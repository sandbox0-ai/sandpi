import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { migrateDatabase } from "@/server/db/migrate";
import { seedCommunityDefaults } from "@/server/db/seed";
import { HttpError } from "@/server/http-error";
import { SecretBox } from "@/server/secrets";
import { EnvironmentWebhookStore, type WebhookMutableConfiguration } from "./webhook-store";
import type { NormalizedWebhookEvent } from "./webhook-ingress";

test(
  "deduplicates verified deliveries and fences concurrent run claims",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const webhook = await createWebhook(store, "webhook-immediate", {
      cooldownPolicy: { mode: "none" },
    });
    const now = new Date();
    const event = webhookEvent("delivery-one", "deploy.finished", "service-a", "ok", now);

    const accepted = await store.ingestDelivery({
      webhook,
      event,
      matched: true,
      now,
    });
    assert.equal(accepted.kind, "queued");
    assert.equal(
      (await store.ingestDelivery({ webhook, event, matched: true, now })).kind,
      "duplicate",
    );

    const runId = accepted.kind === "queued" ? accepted.runId : "";
    const leaseUntil = new Date(now.getTime() + 60_000);
    const [first, second] = await Promise.all([
      store.claimRunLease(runId, "lease-one", leaseUntil, now),
      store.claimRunLease(runId, "lease-two", leaseUntil, now),
    ]);
    const winner = first ?? second;
    assert.ok(winner);
    assert.equal(Number(Boolean(first)) + Number(Boolean(second)), 1);
    assert.match(winner.run.prompt, /external_webhook_events/);
    assert.match(winner.run.prompt, /deploy\.finished/);

    assert.equal(
      await store.finishRun({
        runId,
        leaseToken: winner.run.leaseToken!,
        status: "succeeded",
        nativeTurnId: "turn-one",
      }),
      true,
    );
    assert.equal(
      await store.finishRun({
        runId,
        leaseToken: winner.run.leaseToken!,
        status: "failed",
      }),
      false,
      "a completed lease must not finish twice",
    );

    const deliveries = await store.listDeliveries(
      "user-webhook-test",
      "environment-webhook-test",
      webhook.id,
    );
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "queued");
    const runs = await store.listRuns(
      "user-webhook-test",
      "environment-webhook-test",
      webhook.id,
    );
    assert.equal(runs[0]?.status, "succeeded");
    assert.equal(runs[0]?.nativeTurnId, "turn-one");
  },
);

test(
  "persists state-change filtering independently for each group",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const webhook = await createWebhook(store, "webhook-state", {
      triggerPolicy: {
        mode: "stateChange",
        eventTypes: [],
        conditions: [],
        statePath: "/stateValue",
      },
      cooldownPolicy: { mode: "none" },
    });
    const now = new Date();

    assert.equal(
      (
        await store.ingestDelivery({
          webhook,
          event: webhookEvent("state-one", "alert", "api", "firing", now),
          matched: true,
          now,
        })
      ).kind,
      "queued",
    );
    assert.equal(
      (
        await store.ingestDelivery({
          webhook,
          event: webhookEvent("state-two", "alert", "api", "firing", now),
          matched: true,
          now,
        })
      ).kind,
      "filtered",
    );
    assert.equal(
      (
        await store.ingestDelivery({
          webhook,
          event: webhookEvent("state-three", "alert", "worker", "firing", now),
          matched: true,
          now,
        })
      ).kind,
      "queued",
    );
    assert.equal(
      (
        await store.ingestDelivery({
          webhook,
          event: webhookEvent("state-four", "alert", "api", "resolved", now),
          matched: true,
          now,
        })
      ).kind,
      "queued",
    );

    const deliveries = await store.listDeliveries(
      "user-webhook-test",
      "environment-webhook-test",
      webhook.id,
    );
    assert.deepEqual(
      deliveries.map((delivery) => delivery.status).sort(),
      ["filtered", "queued", "queued", "queued"],
    );

    const revised = await store.update({
      userId: "user-webhook-test",
      environmentId: "environment-webhook-test",
      webhookId: webhook.id,
      expectedRevision: webhook.revision,
      resetTriggerState: true,
      configuration: configuration({
        triggerPolicy: {
          mode: "stateChange",
          eventTypes: [],
          conditions: [],
          statePath: "/payload/stateValue",
        },
      }),
    });
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: revised,
          event: webhookEvent("state-five", "alert", "api", "resolved", now),
          matched: true,
          now,
        })
      ).kind,
      "queued",
      "changing state coordinates must start a fresh state comparison",
    );
  },
);

test(
  "keeps an open debounce bucket immutable across definition edits",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const created = await createWebhook(store, "webhook-debounce", {
      prompt: "Original response policy",
      cooldownPolicy: {
        mode: "debounce",
        durationSeconds: 60,
        behavior: "latest",
      },
    });
    const startedAt = new Date("2026-08-01T00:00:00.000Z");
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: created,
          event: webhookEvent("batch-one", "build", "repo", "one", startedAt),
          matched: true,
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
        cooldownPolicy: {
          mode: "batch",
          durationSeconds: 5,
          behavior: "merge",
        },
      }),
    });
    const secondAt = new Date(startedAt.getTime() + 10_000);
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: updated,
          event: webhookEvent("batch-two", "build", "repo", "two", secondAt),
          matched: true,
          now: secondAt,
        })
      ).kind,
      "batched",
    );

    assert.deepEqual(
      await store.releaseDueBucket({
        webhookId: created.id,
        groupKey: "repo",
        now: new Date(secondAt.getTime() + 5_001),
      }),
      { kind: "stale" },
      "the edited five-second window must not release an older bucket",
    );
    const released = await store.releaseDueBucket({
      webhookId: created.id,
      groupKey: "repo",
      now: new Date(secondAt.getTime() + 60_001),
    });
    assert.equal(released.kind, "queued");
    const runs = await store.listRuns(
      "user-webhook-test",
      "environment-webhook-test",
      created.id,
    );
    assert.equal(runs[0]?.eventCount, 2);
    const deliveries = await store.listDeliveries(
      "user-webhook-test",
      "environment-webhook-test",
      created.id,
    );
    assert.deepEqual(
      deliveries.map((delivery) => ({
        status: delivery.status,
        runId: delivery.runId,
      })),
      [
        { status: "queued", runId: runs[0]?.id },
        { status: "queued", runId: runs[0]?.id },
      ],
    );

    const snapshot = await database.query<{ prompt: string }>(
      "SELECT prompt FROM environment_webhook_runs WHERE id = $1",
      [released.kind === "queued" ? released.runId : ""],
    );
    assert.match(snapshot.rows[0]?.prompt ?? "", /^Original response policy/);
    assert.match(snapshot.rows[0]?.prompt ?? "", /batch-two/);
    assert.doesNotMatch(snapshot.rows[0]?.prompt ?? "", /batch-one/);
    assert.doesNotMatch(snapshot.rows[0]?.prompt ?? "", /Replacement response policy/);
  },
);

test(
  "counts pending cooldown buckets against the configured run backlog",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const webhook = await createWebhook(store, "webhook-backlog", {
      maxPendingRuns: 1,
      cooldownPolicy: {
        mode: "batch",
        durationSeconds: 60,
        behavior: "merge",
      },
    });
    const now = new Date();
    assert.equal(
      (
        await store.ingestDelivery({
          webhook,
          event: webhookEvent("backlog-one", "build", "repo-a", "one", now),
          matched: true,
          now,
        })
      ).kind,
      "batched",
    );
    assert.equal(
      (
        await store.ingestDelivery({
          webhook,
          event: webhookEvent("backlog-two", "build", "repo-a", "two", now),
          matched: true,
          now,
        })
      ).kind,
      "batched",
      "another event may join the already-reserved run slot",
    );
    await assert.rejects(
      store.ingestDelivery({
        webhook,
        event: webhookEvent("backlog-three", "build", "repo-b", "one", now),
        matched: true,
        now,
      }),
      (error) =>
        error instanceof HttpError &&
        error.code === "environment_webhook_backlog_full",
    );
  },
);

test(
  "deleting a Webhook cancels queued and cooldown work",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentWebhookStore(database);
    const queued = await createWebhook(store, "webhook-delete-queued");
    const bucketed = await createWebhook(store, "webhook-delete-bucketed", {
      cooldownPolicy: {
        mode: "debounce",
        durationSeconds: 60,
        behavior: "merge",
      },
    });
    const now = new Date();
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: queued,
          event: webhookEvent("delete-one", "build", "repo-a", "one", now),
          matched: true,
          now,
        })
      ).kind,
      "queued",
    );
    assert.equal(
      (
        await store.ingestDelivery({
          webhook: bucketed,
          event: webhookEvent("delete-two", "build", "repo-b", "one", now),
          matched: true,
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
      bucketed.id,
    );
    const remaining = await database.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM environment_webhooks
       WHERE id = ANY($1::TEXT[])`,
      [[queued.id, bucketed.id]],
    );
    assert.equal(remaining.rows[0]?.count, "0");
  },
);

async function createWebhook(
  store: EnvironmentWebhookStore,
  id: string,
  overrides: Partial<WebhookMutableConfiguration> = {},
) {
  const secretBox = new SecretBox("webhook-test-encryption-key-at-least-32-bytes");
  return store.create({
    id,
    endpointId: `endpoint-${id}`,
    userId: "user-webhook-test",
    environmentId: "environment-webhook-test",
    secret: secretBox.encrypt("webhook-secret", `environment-webhook:${id}:secret`),
    configuration: configuration(overrides),
  });
}

function configuration(
  overrides: Partial<WebhookMutableConfiguration> = {},
): WebhookMutableConfiguration {
  return {
    name: "Webhook test",
    prompt: "Handle this event",
    triggerPolicy: { mode: "every", eventTypes: [], conditions: [] },
    cooldownPolicy: { mode: "none" },
    target: { kind: "newSession" },
    overlapPolicy: "queue",
    maxConcurrentRuns: 1,
    maxPendingRuns: 100,
    enabled: true,
    ...overrides,
  };
}

function webhookEvent(
  deliveryId: string,
  eventType: string,
  groupKey: string,
  stateValue: string,
  now: Date,
): NormalizedWebhookEvent {
  return {
    deliveryId,
    eventType,
    groupKey,
    stateValue,
    summary: `${eventType} ${stateValue}`,
    receivedAt: now.toISOString(),
    payload: { eventType, groupKey, stateValue, deliveryId },
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
