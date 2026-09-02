import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { loadConfig } from "@/server/config";
import { NATIVE_TUI_V2_UNAVAILABLE_CODE } from "@/server/native-tui-v2";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";

test(
  "keeps GitHub inventory readable while retiring install, callback, and events",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_github_webhook_api_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-github-webhook-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-github-webhook-test",
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      SANDPI_HOST: "127.0.0.1",
      SANDPI_PORT: "39003",
      SANDPI_PUBLIC_URL: "http://127.0.0.1:39003",
      SANDPI_AUTH_MODE: "admin",
      SANDPI_SECRET_KEY: "github-webhook-encryption-key-at-least-32-bytes",
      SANDPI_GITHUB_APP_SLUG: "sandpi-webhook-test",
      SANDPI_GITHUB_CLIENT_ID: "Iv1.github-test",
      SANDPI_GITHUB_CLIENT_SECRET: "github-client-secret",
      SANDPI_GITHUB_WEBHOOK_SECRET: "github-webhook-test-secret",
      SANDPI_LOG_LEVEL: "silent",
      SANDPI_WEB_DIR: "/tmp/sandpi-github-webhook-test-no-web",
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

    const inventory = await server.app.inject({
      method: "GET",
      url: "/api/v1/environments/env-default/webhook-sources/github",
    });
    assert.equal(inventory.statusCode, 200, inventory.body);
    assert.equal(inventory.json().data.configured, true);
    assert.deepEqual(inventory.json().data.connections, []);

    for (const request of [
      {
        method: "POST" as const,
        url: "/api/v1/environments/env-default/webhook-sources/github/install",
      },
      {
        method: "GET" as const,
        url: "/api/v1/webhook-sources/github/callback?code=x&state=y",
      },
      {
        method: "POST" as const,
        url: "/api/v1/webhook-sources/github/events",
      },
    ]) {
      const response = await server.app.inject(request);
      assert.equal(response.statusCode, 410, response.body);
      assert.equal(
        response.json().error.code,
        NATIVE_TUI_V2_UNAVAILABLE_CODE,
      );
    }
  },
);
