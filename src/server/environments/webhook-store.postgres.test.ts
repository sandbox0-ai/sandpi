import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { migrateDatabase } from "@/server/db/migrate";
import { seedCommunityDefaults } from "@/server/db/seed";
import { HttpError } from "@/server/http-error";
import { SecretBox } from "@/server/secrets";
import {
  EnvironmentWebhookStore,
  type WebhookMutableConfiguration,
} from "./webhook-store";
import type { NormalizedWebhookEvent } from "./webhook-ingress";

test(
  "deduplicates verified deliveries and keeps one active run per Webhook",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const webhook = await createWebhook(store, "webhook-immediate");
    const now = new Date();
    const firstEvent = webhookEvent(
      "delivery-one",
      "deploy.finished",
      "service-a",
      now,
    );

    const firstAccepted = await store.ingestDelivery({
      webhook,
      event: firstEvent,
      now,
    });
    assert.equal(firstAccepted.kind, "queued");
    assert.equal(
      (await store.ingestDelivery({ webhook, event: firstEvent, now })).kind,
      "duplicate",
    );
    const secondAccepted = await store.ingestDelivery({
      webhook,
      event: webhookEvent("delivery-two", "build.failed", "service-b", now),
      now,
    });
    assert.equal(secondAccepted.kind, "queued");

    const firstRunId = firstAccepted.kind === "queued" ? firstAccepted.runId : "";
    const secondRunId =
      secondAccepted.kind === "queued" ? secondAccepted.runId : "";
    const leaseUntil = new Date(now.getTime() + 60_000);
    const [firstClaim, competingClaim] = await Promise.all([
      store.claimRunLease(firstRunId, "lease-one", leaseUntil, now),
      store.claimRunLease(firstRunId, "lease-two", leaseUntil, now),
    ]);
    const winner = firstClaim ?? competingClaim;
    assert.ok(winner);
    assert.equal(Number(Boolean(firstClaim)) + Number(Boolean(competingClaim)), 1);
    assert.equal(
      await store.claimRunLease(secondRunId, "lease-three", leaseUntil, now),
      undefined,
      "a second run must wait while this Webhook already has an active run",
    );
    assert.match(winner.run.prompt, /external_webhook_events/);
    assert.match(winner.run.prompt, /deploy\.finished/);

    assert.equal(
      await store.finishRun({
        runId: firstRunId,
        leaseToken: winner.run.leaseToken!,
        status: "succeeded",
        nativeTurnId: "turn-one",
      }),
      true,
    );
    assert.ok(
      await store.claimRunLease(secondRunId, "lease-four", leaseUntil, now),
    );

    const deliveries = await store.listDeliveries(
      "user-webhook-test",
      "environment-webhook-test",
      webhook.id,
    );
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every((delivery) => delivery.status === "queued"));
  },
);

test(
  "keeps an open fixed batch window immutable across definition edits",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const created = await createWebhook(store, "webhook-batch", {
      prompt: "Original response policy",
      batchWindowSeconds: 60,
    });
    const startedAt = new Date("2026-08-01T00:00:00.000Z");
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: created,
          event: webhookEvent("batch-one", "build", "repo", startedAt),
          now: startedAt,
        })
      ).kind,
      "batched",
    );

    const updated = await store.update({
      userId: "user-webhook-test",
      environmentId: "environment-webhook-test",
      webhookId: created.id,
      expectedRevision: created.revision,
      configuration: configuration({
        prompt: "Replacement response policy",
        batchWindowSeconds: 5,
      }),
    });
    const secondAt = new Date(startedAt.getTime() + 10_000);
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: updated,
          event: webhookEvent("batch-two", "build", "repo", secondAt),
          now: secondAt,
        })
      ).kind,
      "batched",
    );

    assert.deepEqual(
      await store.releaseDueBatch({
        webhookId: created.id,
        groupKey: "repo",
        now: new Date(secondAt.getTime() + 5_001),
      }),
      { kind: "stale" },
      "editing the definition must not shorten an open batch",
    );
    const released = await store.releaseDueBatch({
      webhookId: created.id,
      groupKey: "repo",
      now: new Date(startedAt.getTime() + 60_001),
    });
    assert.equal(released.kind, "queued");

    const runs = await store.listRuns(
      "user-webhook-test",
      "environment-webhook-test",
      created.id,
    );
    assert.equal(runs[0]?.eventCount, 2);
    const snapshot = await database.query<{ prompt: string }>(
      "SELECT prompt FROM environment_webhook_runs WHERE id = $1",
      [released.kind === "queued" ? released.runId : ""],
    );
    assert.match(snapshot.rows[0]?.prompt ?? "", /^Original response policy/);
    assert.match(snapshot.rows[0]?.prompt ?? "", /batch-one/);
    assert.match(snapshot.rows[0]?.prompt ?? "", /batch-two/);
    assert.doesNotMatch(
      snapshot.rows[0]?.prompt ?? "",
      /Replacement response policy/,
    );
  },
);

test(
  "bounds the fixed Webhook backlog including open batches",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const webhook = await createWebhook(store, "webhook-backlog", {
      batchWindowSeconds: 60,
    });
    const now = new Date();
    for (let index = 0; index < 100; index += 1) {
      const result = await store.ingestDelivery({
        webhook,
        event: webhookEvent(
          `backlog-${index}`,
          "build",
          `repo-${index}`,
          now,
        ),
        now,
      });
      assert.equal(result.kind, "batched");
    }
    await assert.rejects(
      store.ingestDelivery({
        webhook,
        event: webhookEvent("backlog-overflow", "build", "repo-overflow", now),
        now,
      }),
      (error) =>
        error instanceof HttpError &&
        error.code === "environment_webhook_backlog_full",
    );
  },
);

test(
  "deleting a Webhook cancels queued and batched work",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const queued = await createWebhook(store, "webhook-delete-queued");
    const batched = await createWebhook(store, "webhook-delete-batched", {
      batchWindowSeconds: 60,
    });
    const now = new Date();
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: queued,
          event: webhookEvent("delete-one", "build", "repo-a", now),
          now,
        })
      ).kind,
      "queued",
    );
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: batched,
          event: webhookEvent("delete-two", "build", "repo-b", now),
          now,
        })
      ).kind,
      "batched",
    );

    await store.delete(
      "user-webhook-test",
      "environment-webhook-test",
      queued.id,
    );
    await store.delete(
      "user-webhook-test",
      "environment-webhook-test",
      batched.id,
    );
    const remaining = await database.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM environment_webhooks
       WHERE id = ANY($1::TEXT[])`,
      [[queued.id, batched.id]],
    );
    assert.equal(remaining.rows[0]?.count, "0");
  },
);

async function createWebhook(
  store: EnvironmentWebhookStore,
  id: string,
  overrides: Partial<WebhookMutableConfiguration> = {},
) {
  const secretBox = new SecretBox(
    "webhook-test-encryption-key-at-least-32-bytes",
  );
  return store.create({
    id,
    endpointId: `endpoint-${id}`,
    userId: "user-webhook-test",
    environmentId: "environment-webhook-test",
    secret: secretBox.encrypt(
      "webhook-secret",
      `environment-webhook:${id}:secret`,
    ),
    configuration: configuration(overrides),
  });
}

function configuration(
  overrides: Partial<WebhookMutableConfiguration> = {},
): WebhookMutableConfiguration {
  return {
    source: { kind: "custom" },
    name: "Webhook test",
    prompt: "Handle this event",
    batchWindowSeconds: 0,
    target: { kind: "newSession" },
    enabled: true,
    ...overrides,
  };
}

function webhookEvent(
  deliveryId: string,
  eventType: string,
  groupKey: string,
  now: Date,
): NormalizedWebhookEvent {
  return {
    deliveryId,
    eventType,
    groupKey,
    summary: `${eventType} ${deliveryId}`,
    receivedAt: now.toISOString(),
    payload: { eventType, groupKey, deliveryId },
  };
}

async function isolatedDatabase(context: test.TestContext): Promise<Pool> {
  const schema = `sandpi_webhook_test_${randomUUID().replaceAll("-", "")}`;
  const administration = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "sandpi-webhook-test-administration",
    max: 1,
  });
  await administration.query(`CREATE SCHEMA "${schema}"`);
  const database = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "sandpi-webhook-postgres-test",
    options: `-c search_path=${schema}`,
    max: 4,
  });
  context.after(async () => {
    await database.end();
    await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
    await administration.end();
  });
  await migrateDatabase(database);
  await seedCommunityDefaults(database, {
    admin: {
      id: "user-webhook-test",
      email: "webhook-test@sandpi.local",
      identitySubject: "webhook-test",
    },
    environment: {
      id: "environment-webhook-test",
      name: "Webhook test",
    },
  });
  return database;
}
