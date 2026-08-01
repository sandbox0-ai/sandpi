import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { loadConfig } from "@/server/config";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";

test(
  "accepts authenticated generic payloads through public Webhook ingress",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_webhook_api_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-webhook-api-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-webhook-api-test",
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      SANDPI_HOST: "127.0.0.1",
      SANDPI_PORT: "39002",
      SANDPI_PUBLIC_URL: "http://127.0.0.1:39002",
      SANDPI_AUTH_MODE: "admin",
      SANDPI_SECRET_KEY: "webhook-api-encryption-key-at-least-32-bytes",
      SANDPI_LOG_LEVEL: "silent",
      SANDPI_WEB_DIR: "/tmp/sandpi-webhook-api-test-no-web",
    });
    const server = await createSandpiServer({
      config,
      pool: database,
      advisoryLockPool: database,
      runtime: new UnconfiguredRuntime(),
    });
    context.after(async () => {
      await server.close();
      await database.end();
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.end();
    });

    const legacyProvider = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhooks",
      payload: webhookDefinition({ provider: "github" }),
    });
    assert.equal(legacyProvider.statusCode, 400, legacyProvider.body);

    const secret = "custom-bearer-secret-for-api-test";
    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhooks",
      payload: webhookDefinition({ secret }),
    });
    assert.equal(create.statusCode, 201, create.body);
    assert.equal(create.headers["cache-control"], "no-store");
    const setup = create.json().data as {
      webhook: { id: string; endpointUrl: string };
    };
    assert.equal("provider" in setup.webhook, false);
    assert.match(setup.webhook.endpointUrl, /\/api\/v1\/webhooks\/hook_/);

    const path = new URL(setup.webhook.endpointUrl).pathname;
    const badToken = await server.app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: "Bearer wrong",
        "content-type": "application/json",
      },
      payload: { type: "deploy.finished" },
    });
    assert.equal(badToken.statusCode, 401, badToken.body);
    assert.equal(
      badToken.json().error.code,
      "environment_webhook_unauthorized",
    );

    const accepted = await server.app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "delivery-valid",
      },
      payload: {
        type: "deploy.finished",
        deployment: { environment: "production" },
      },
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(accepted.json().status, "batched");

    const duplicate = await server.app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "idempotency-key": "delivery-valid",
      },
      payload: {
        type: "deploy.finished",
        deployment: { environment: "production" },
      },
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().status, "duplicate");

    const formAccepted = await server.app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-sandpi-delivery": "form-delivery",
        "x-sandpi-event": "build.failed",
      },
      payload: "build_id=42&status=failed",
    });
    assert.equal(formAccepted.statusCode, 202, formAccepted.body);
    assert.equal(formAccepted.json().status, "batched");

    const deliveries = await server.app.inject({
      method: "GET",
      url: `/api/v1/environments/env-default/webhooks/${encodeURIComponent(
        setup.webhook.id,
      )}/deliveries`,
    });
    assert.equal(deliveries.statusCode, 200, deliveries.body);
    assert.deepEqual(
      deliveries
        .json()
        .data.map((delivery: { eventType: string }) => delivery.eventType)
        .sort(),
      ["build.failed", "deploy.finished"],
    );
  },
);

function webhookDefinition(overrides: Record<string, unknown> = {}) {
  return {
    name: "Deployment events",
    prompt: "Review this event and run the relevant checks.",
    triggerPolicy: {
      mode: "every",
      eventTypes: ["deploy.finished", "build.failed"],
      conditions: [],
      groupKeyPath: "/payload/deployment/environment",
    },
    cooldownPolicy: {
      mode: "batch",
      durationSeconds: 30,
      behavior: "merge",
    },
    target: { kind: "newSession" },
    overlapPolicy: "queue",
    maxConcurrentRuns: 2,
    maxPendingRuns: 50,
    enabled: true,
    ...overrides,
  };
}
