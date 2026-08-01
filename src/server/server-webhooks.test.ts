import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { loadConfig } from "@/server/config";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";

test(
  "accepts GitHub signatures and Slack form signatures through public ingress",
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

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhooks",
      payload: {
        name: "GitHub pushes",
        provider: "github",
        prompt: "Review this push and run the relevant checks.",
        triggerPolicy: {
          mode: "every",
          eventTypes: ["push"],
          conditions: [],
          groupKeyPath: "/payload/repository/full_name",
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
      },
    });
    assert.equal(create.statusCode, 201, create.body);
    assert.equal(create.headers["cache-control"], "no-store");
    const setup = create.json().data as {
      webhook: { id: string; endpointUrl: string; provider: string };
      setupSecret: string;
    };
    assert.equal(setup.webhook.provider, "github");
    assert.ok(setup.setupSecret);
    assert.match(setup.webhook.endpointUrl, /\/api\/v1\/webhooks\/hook_/);

    const body = Buffer.from(
      JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "sandbox0-ai/sandpi" },
        sender: { login: "octocat" },
      }),
    );
    const badSignature = await server.app.inject({
      method: "POST",
      url: new URL(setup.webhook.endpointUrl).pathname,
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-invalid",
        "x-hub-signature-256": "sha256=invalid",
      },
      payload: body,
    });
    assert.equal(badSignature.statusCode, 401, badSignature.body);
    assert.equal(
      badSignature.json().error.code,
      "environment_webhook_unauthorized",
    );

    const signature = `sha256=${createHmac("sha256", setup.setupSecret)
      .update(body)
      .digest("hex")}`;
    const accepted = await server.app.inject({
      method: "POST",
      url: new URL(setup.webhook.endpointUrl).pathname,
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-valid",
        "x-hub-signature-256": signature,
      },
      payload: body,
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(accepted.json().status, "batched");

    const duplicate = await server.app.inject({
      method: "POST",
      url: new URL(setup.webhook.endpointUrl).pathname,
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-valid",
        "x-hub-signature-256": signature,
      },
      payload: body,
    });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().status, "duplicate");

    const deliveries = await server.app.inject({
      method: "GET",
      url: `/api/v1/environments/env-default/webhooks/${encodeURIComponent(
        setup.webhook.id,
      )}/deliveries`,
    });
    assert.equal(deliveries.statusCode, 200, deliveries.body);
    assert.equal(deliveries.json().data.length, 1);
    assert.equal(deliveries.json().data[0].eventType, "push");
    assert.equal(deliveries.json().data[0].status, "batched");

    const slackSecret = "slack-signing-secret-for-api-test";
    const createSlack = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhooks",
      payload: {
        name: "Slack commands",
        provider: "slack",
        secret: slackSecret,
        prompt: "Handle this signed Slack command.",
        triggerPolicy: {
          mode: "every",
          eventTypes: ["slash_command"],
          conditions: [],
        },
        cooldownPolicy: {
          mode: "batch",
          durationSeconds: 30,
          behavior: "merge",
        },
        target: { kind: "newSession" },
        overlapPolicy: "queue",
        maxConcurrentRuns: 1,
        maxPendingRuns: 10,
        enabled: true,
      },
    });
    assert.equal(createSlack.statusCode, 201, createSlack.body);
    const slackWebhook = createSlack.json().data.webhook as {
      id: string;
      endpointUrl: string;
    };
    const slackBody = Buffer.from(
      "command=%2Finvestigate&team_id=T1&channel_id=C1&user_id=U1&trigger_id=trigger-one",
    );
    const slackTimestamp = String(Math.floor(Date.now() / 1_000));
    const slackSignature = `v0=${createHmac("sha256", slackSecret)
      .update(`v0:${slackTimestamp}:${slackBody.toString("utf8")}`)
      .digest("hex")}`;
    const slackAccepted = await server.app.inject({
      method: "POST",
      url: new URL(slackWebhook.endpointUrl).pathname,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": slackTimestamp,
        "x-slack-signature": slackSignature,
      },
      payload: slackBody,
    });
    assert.equal(slackAccepted.statusCode, 200, slackAccepted.body);
    assert.equal(slackAccepted.json().status, "batched");

    const slackDeliveries = await server.app.inject({
      method: "GET",
      url: `/api/v1/environments/env-default/webhooks/${encodeURIComponent(
        slackWebhook.id,
      )}/deliveries`,
    });
    assert.equal(slackDeliveries.statusCode, 200, slackDeliveries.body);
    assert.equal(slackDeliveries.json().data[0].eventType, "slash_command");

    const customSecret = "custom-bearer-secret-for-api-test";
    const createCustom = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhooks",
      payload: {
        name: "Custom text events",
        provider: "custom",
        secret: customSecret,
        prompt: "Handle this custom event.",
        triggerPolicy: {
          mode: "every",
          eventTypes: ["deploy.finished"],
          conditions: [],
        },
        cooldownPolicy: {
          mode: "batch",
          durationSeconds: 30,
          behavior: "latest",
        },
        target: { kind: "newSession" },
        overlapPolicy: "queue",
        maxConcurrentRuns: 1,
        maxPendingRuns: 10,
        enabled: true,
      },
    });
    assert.equal(createCustom.statusCode, 201, createCustom.body);
    const customWebhook = createCustom.json().data.webhook as {
      endpointUrl: string;
    };
    const customAccepted = await server.app.inject({
      method: "POST",
      url: new URL(customWebhook.endpointUrl).pathname,
      headers: {
        authorization: `Bearer ${customSecret}`,
        "content-type": "text/plain",
        "idempotency-key": "custom-text-one",
        "x-sandpi-event": "deploy.finished",
      },
      payload: "production deployment finished",
    });
    assert.equal(customAccepted.statusCode, 202, customAccepted.body);
    assert.equal(customAccepted.json().status, "batched");
  },
);
