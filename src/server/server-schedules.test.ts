import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { toUnixTimestamp } from "@/lib/time";
import { loadConfig } from "@/server/config";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";

test(
  "exposes the Environment Schedule CRUD contract without waking a Sandbox",
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

    const prompt = `Inspect the Environment.\n${"Boundary detail. ".repeat(
      600,
    )}`;
    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/schedules",
      payload: {
        name: "Weekday review",
        prompt,
        timing: {
          kind: "cron",
          expression: "0 9 * * 1-5",
          timeZone: "Asia/Shanghai",
        },
        target: { kind: "newSession" },
        overlapPolicy: "skip",
        enabled: true,
        title: "Scheduled repository review",
      },
    });
    assert.equal(create.statusCode, 201, create.body);
    assert.equal(create.headers["cache-control"], "no-store");
    const created = create.json().data as {
      id: string;
      prompt: string;
      nextRunAt: number;
    };
    assert.equal(created.prompt, prompt.trim());
    assert.equal(typeof created.nextRunAt, "number");

    const list = await server.app.inject({
      method: "GET",
      url: "/api/v1/environments/env-default/schedules",
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.length, 1);
    assert.equal(list.json().data[0].id, created.id);

    const update = await server.app.inject({
      method: "PUT",
      url: `/api/v1/environments/env-default/schedules/${encodeURIComponent(
        created.id,
      )}`,
      payload: {
        name: "Weekday review",
        prompt,
        timing: {
          kind: "cron",
          expression: "0 9 * * 1-5",
          timeZone: "Asia/Shanghai",
        },
        target: { kind: "newSession" },
        overlapPolicy: "skip",
        enabled: false,
        title: "Scheduled repository review",
      },
    });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(update.json().data.enabled, false);
    assert.equal(update.json().data.nextRunAt, undefined);

    const runs = await server.app.inject({
      method: "GET",
      url: `/api/v1/environments/env-default/schedules/${encodeURIComponent(
        created.id,
      )}/runs?limit=20`,
    });
    assert.equal(runs.statusCode, 200, runs.body);
    assert.deepEqual(runs.json().data, []);

    const invalidCron = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/schedules",
      payload: {
        name: "Invalid cron",
        prompt: "This must not be stored.",
        timing: {
          kind: "cron",
          expression: "0 0 9 * * 1-5",
          timeZone: "UTC",
        },
        target: { kind: "newSession" },
        enabled: true,
      },
    });
    assert.equal(invalidCron.statusCode, 400, invalidCron.body);
    assert.equal(
      invalidCron.json().error.code,
      "environment_schedule_cron_invalid",
    );

    const runAt = toUnixTimestamp(new Date(Date.now() + 60 * 60 * 1_000));
    const createOnce = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/schedules",
      payload: {
        name: "One-time review",
        prompt: "Inspect the Environment once.",
        timing: { kind: "once", runAt },
        target: { kind: "newSession" },
        enabled: true,
      },
    });
    assert.equal(createOnce.statusCode, 201, createOnce.body);
    assert.equal(createOnce.json().data.timing.runAt, runAt);
    assert.equal(createOnce.json().data.nextRunAt, runAt);

    const onceId = createOnce.json().data.id as string;
    const removeOnce = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/environments/env-default/schedules/${encodeURIComponent(
        onceId,
      )}`,
    });
    assert.equal(removeOnce.statusCode, 200, removeOnce.body);

    const remove = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/environments/env-default/schedules/${encodeURIComponent(
        created.id,
      )}`,
    });
    assert.equal(remove.statusCode, 200, remove.body);
    assert.equal(remove.json().data.id, created.id);
  },
);
