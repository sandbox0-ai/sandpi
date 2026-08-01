import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { loadConfig } from "@/server/config";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import { createSandpiServer } from "@/server/server";

test(
  "completes the native system-browser handoff through the HTTP contract",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_native_auth_api_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-native-auth-api-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-native-auth-api-test",
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const publicUrl = "http://127.0.0.1:39002";
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      SANDPI_HOST: "127.0.0.1",
      SANDPI_PORT: "39002",
      SANDPI_PUBLIC_URL: publicUrl,
      SANDPI_AUTH_MODE: "admin",
      SANDPI_LOG_LEVEL: "silent",
      SANDPI_WEB_DIR: "/tmp/sandpi-native-auth-api-test-no-web",
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

    const verifier = "v".repeat(43);
    const deviceConfiguration = await server.app.inject({
      method: "GET",
      url: "/api/v1/auth/device/config",
    });
    assert.equal(deviceConfiguration.statusCode, 200, deviceConfiguration.body);
    assert.deepEqual(deviceConfiguration.json().data, { mode: "admin" });

    const prepare = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/native/prepare",
      headers: { origin: publicUrl },
      payload: {
        returnTo: `${publicUrl}/?new=1`,
        verifier,
        state: "s".repeat(43),
      },
    });
    assert.equal(prepare.statusCode, 200, prepare.body);
    assert.equal(prepare.headers["cache-control"], "no-store");
    const authorizationUrl = new URL(
      prepare.json().data.authorizationUrl as string,
    );
    assert.equal(authorizationUrl.origin, publicUrl);
    assert.equal(
      authorizationUrl.pathname,
      "/api/v1/auth/native/login",
    );

    const login = await server.app.inject({
      method: "GET",
      url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    });
    assert.equal(login.statusCode, 302, login.body);
    assert.equal(login.headers["cache-control"], "no-store");
    const callback = new URL(login.headers.location as string);
    assert.equal(callback.protocol, "sandpi:");
    assert.equal(callback.hostname, "auth");
    assert.equal(callback.pathname, "/callback");

    const completionPayload = {
      attemptId: callback.searchParams.get("attempt_id"),
      code: callback.searchParams.get("code"),
      verifier,
    };
    const complete = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/native/complete",
      headers: { origin: publicUrl },
      payload: completionPayload,
    });
    assert.equal(complete.statusCode, 200, complete.body);
    assert.equal(complete.headers["cache-control"], "no-store");
    assert.equal(complete.json().data.returnTo, "/?new=1");

    const replay = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/native/complete",
      headers: { origin: publicUrl },
      payload: completionPayload,
    });
    assert.equal(replay.statusCode, 400, replay.body);
    assert.equal(
      replay.json().error.code,
      "native_auth_attempt_invalid",
    );

    const missingOrigin = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/native/prepare",
      payload: {
        returnTo: "/",
        verifier,
        state: "x".repeat(43),
      },
    });
    assert.equal(missingOrigin.statusCode, 403, missingOrigin.body);
    assert.equal(missingOrigin.json().error.code, "origin_invalid");
  },
);
