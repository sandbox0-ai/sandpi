import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { loadConfig } from "@/server/config";
import { NATIVE_TUI_V2_UNAVAILABLE_CODE } from "@/server/native-tui-v2";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";

test(
  "keeps v1 Webhook inventory readable while retiring ingress and mutations",
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

    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/environments/env-default/webhooks",
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().data, []);

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/webhooks",
      payload: {
        source: { kind: "custom" },
        name: "Retired ingress",
        prompt: "This must not enter a native TUI.",
        batchWindowSeconds: 0,
        target: { kind: "newSession" },
        enabled: true,
      },
    });
    assert.equal(create.statusCode, 410, create.body);
    assert.equal(create.json().error.code, NATIVE_TUI_V2_UNAVAILABLE_CODE);

    const ingress = await server.app.inject({
      method: "POST",
      url: "/api/v1/webhooks/legacy-hook",
      payload: { event: "build.finished" },
    });
    assert.equal(ingress.statusCode, 410, ingress.body);
    assert.equal(ingress.json().error.code, NATIVE_TUI_V2_UNAVAILABLE_CODE);
  },
);
