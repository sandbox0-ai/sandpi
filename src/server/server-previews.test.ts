import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { loadConfig } from "@/server/config";
import { UnconfiguredRuntime } from "@/server/runtime/unconfigured";
import type {
  RuntimeAdapter,
  RuntimeSandboxPreviewGrant,
} from "@/server/runtime/types";
import { createSandpiServer } from "@/server/server";

test(
  "routes authenticated loopback previews through the owned Environment runtime",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_preview_api_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-preview-api-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-preview-api-test",
      options: `-c search_path=${schema}`,
      max: 8,
    });
    const calls: Array<Record<string, unknown>> = [];
    const grant = (expiresAt: Date): RuntimeSandboxPreviewGrant => ({
      id: "preview-one",
      sandboxId: "sandbox-preview",
      port: 3_000,
      protocol: "http",
      url: "https://sandbox-preview--p3000.region.sandbox0.app/.sandbox0/preview/bootstrap?token=secret",
      targetUrl: "https://sandbox-preview--p3000.region.sandbox0.app/dashboard?q=1#logs",
      expiresAt,
      runtimeGeneration: 4,
    });
    const runtime = Object.assign(new UnconfiguredRuntime(), {
      async createEnvironmentPreview(
        current: { sandboxId: string },
        input: Record<string, unknown>,
      ) {
        calls.push({ operation: "create", sandboxId: current.sandboxId, input });
        return grant(new Date("2026-08-03T00:15:00.000Z"));
      },
      async renewEnvironmentPreview(
        current: { sandboxId: string },
        previewId: string,
        ttlSeconds?: number,
      ) {
        calls.push({
          operation: "renew",
          sandboxId: current.sandboxId,
          previewId,
          ttlSeconds,
        });
        return grant(new Date("2026-08-03T00:30:00.000Z"));
      },
      async revokeEnvironmentPreview(
        current: { sandboxId: string },
        previewId: string,
      ) {
        calls.push({
          operation: "revoke",
          sandboxId: current.sandboxId,
          previewId,
        });
      },
    }) as RuntimeAdapter;
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      SANDPI_HOST: "127.0.0.1",
      SANDPI_PORT: "39005",
      SANDPI_PUBLIC_URL: "http://127.0.0.1:39005",
      SANDPI_AUTH_MODE: "admin",
      SANDPI_LOG_LEVEL: "silent",
      SANDPI_WEB_DIR: "/tmp/sandpi-preview-api-test-no-web",
    });
    const server = await createSandpiServer({
      config,
      pool: database,
      advisoryLockPool: database,
      runtime,
    });
    context.after(async () => {
      await server.close();
      await database.end();
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.end();
    });
    await server.store.markEnvironmentReady("env-default", {
      sandboxId: "sandbox-preview",
    });

    const invalid = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/previews",
      payload: { url: "https://example.com:3000/" },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(invalid.json().error.code, "sandbox_loopback_url_required");
    assert.equal(calls.length, 0);

    const create = await server.app.inject({
      method: "POST",
      url: "/api/v1/environments/env-default/previews",
      payload: { url: "localhost:3000/dashboard?q=1#logs" },
    });
    assert.equal(create.statusCode, 201, create.body);
    assert.equal(create.headers["cache-control"], "no-store");
    assert.equal(create.json().data.id, "preview-one");
    assert.equal(create.json().data.expiresAt, 1_785_716_100);
    assert.deepEqual(calls[0], {
      operation: "create",
      sandboxId: "sandbox-preview",
      input: {
        port: 3_000,
        protocol: "http",
        path: "/dashboard?q=1#logs",
      },
    });

    const renew = await server.app.inject({
      method: "PUT",
      url: "/api/v1/environments/env-default/previews/preview-one",
      payload: { ttlSeconds: 900 },
    });
    assert.equal(renew.statusCode, 200, renew.body);
    assert.equal(renew.headers["cache-control"], "no-store");
    assert.equal(renew.json().data.expiresAt, 1_785_717_000);

    const revoke = await server.app.inject({
      method: "DELETE",
      url: "/api/v1/environments/env-default/previews/preview-one",
    });
    assert.equal(revoke.statusCode, 200, revoke.body);
    assert.deepEqual(revoke.json().data, { id: "preview-one" });
    assert.deepEqual(calls.slice(1), [
      {
        operation: "renew",
        sandboxId: "sandbox-preview",
        previewId: "preview-one",
        ttlSeconds: 900,
      },
      {
        operation: "revoke",
        sandboxId: "sandbox-preview",
        previewId: "preview-one",
      },
    ]);
  },
);
