import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { loadConfig } from "@/server/config";
import { NATIVE_TUI_V2_UNAVAILABLE_CODE } from "@/server/native-tui-v2";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";

test(
  "keeps v1 Schedules readable but retires execution-producing mutations",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_schedule_api_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-schedule-api-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-schedule-api-test",
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      SANDPI_HOST: "127.0.0.1",
      SANDPI_PORT: "39001",
      SANDPI_PUBLIC_URL: "http://127.0.0.1:39001",
      SANDPI_AUTH_MODE: "admin",
      SANDPI_LOG_LEVEL: "silent",
      SANDPI_WEB_DIR: "/tmp/sandpi-schedule-api-test-no-web",
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
      url: "/api/v1/environments/env-default/schedules",
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().data, []);

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/schedules",
      payload: {
        name: "Retired review",
        prompt: "This prompt must never be injected into a native TUI.",
        timing: {
          kind: "cron",
          expression: "0 9 * * 1-5",
          timeZone: "Asia/Shanghai",
        },
        target: { kind: "newSession" },
        enabled: true,
      },
    });
    assert.equal(create.statusCode, 410, create.body);
    assert.equal(create.json().error.code, NATIVE_TUI_V2_UNAVAILABLE_CODE);

    const update = await server.app.inject({
      method: "PUT",
      url: "/api/v1/environments/env-default/schedules/legacy-schedule",
      payload: {},
    });
    assert.equal(update.statusCode, 410, update.body);
    assert.equal(update.json().error.code, NATIVE_TUI_V2_UNAVAILABLE_CODE);
  },
);
