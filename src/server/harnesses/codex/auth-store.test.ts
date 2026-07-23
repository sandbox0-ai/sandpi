import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { toUnixTimestamp } from "@/lib/time";
import { CODEX_MCP_OAUTH_CREDENTIAL_PATH } from "@/server/runtime/types";

import {
  CodexAuthStore,
  publicCodexDeviceAuthFlow,
  type CodexDeviceAuthFlow,
} from "./auth-store";

test("authorizes Codex login flows through Environment ownership", async () => {
  let query = "";
  const store = new CodexAuthStore({
    async query(sql: string) {
      query = sql;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool);

  assert.equal(
    await store.findActiveFlow("user-test", "environment-test"),
    undefined,
  );
  assert.match(query, /e\.created_by_user_id = \$1/);
  assert.doesNotMatch(query, /membership|visibility|team_id/i);
});

test("device login projection never exposes runtime state or protocol messages", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const flow: CodexDeviceAuthFlow = {
    id: "codex_auth_test",
    environmentId: "env_test",
    status: "awaiting_user",
    runtime: {
      sandboxId: "sandbox-secret-coordinate",
      supervisorSessionId: "supervisor-secret-coordinate",
      attemptId: "attempt-secret-coordinate",
      runtimeGeneration: 1,
    },
    decoder: {
      supervisorCursor: 7,
      tailBase64: "sensitive-tail",
      runtimeGeneration: 1,
    },
    nativeLoginId: "native-login-id",
    verificationUrl: "https://auth.example.test/device",
    userCode: "ABCD-EFGH",
    protocolMessages: [{ id: "response", result: { internal: true } }],
    expiresAt: now,
    createdAt: now,
    updatedAt: now,
  };

  assert.deepEqual(publicCodexDeviceAuthFlow(flow), {
    id: "codex_auth_test",
    environmentId: "env_test",
    status: "awaiting_user",
    verificationUrl: "https://auth.example.test/device",
    userCode: "ABCD-EFGH",
    error: undefined,
    expiresAt: toUnixTimestamp(now),
    createdAt: toUnixTimestamp(now),
    updatedAt: toUnixTimestamp(now),
  });
  assert.doesNotMatch(
    JSON.stringify(publicCodexDeviceAuthFlow(flow)),
    /sandbox-secret|supervisor-secret|sensitive-tail|internal/,
  );
});

test("materializing MCP OAuth locks the Environment and pins the ephemeral slot path", async () => {
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
  let released = false;
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("INSERT INTO environment_credential_bindings")) {
        return { rows: [{ id: "binding-test" }], rowCount: 1 };
      }
      return { rows: [{ id: "environment-test" }], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  const store = new CodexAuthStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  await store.markMcpOAuthCredentialMaterialized(
    "environment-test",
    "credential-mcp-test",
    7,
  );

  assert.equal(queries[0]?.sql, "BEGIN");
  assert.match(queries[1]?.sql ?? "", /FROM environments[\s\S]+FOR UPDATE/);
  const binding = queries.find(({ sql }) =>
    sql.includes("INSERT INTO environment_credential_bindings"),
  );
  assert.deepEqual(binding?.values?.slice(1), [
    "credential-mcp-test",
    "environment-test",
    7,
    CODEX_MCP_OAUTH_CREDENTIAL_PATH,
  ]);
  assert.match(binding?.sql ?? "", /credential_slot[\s\S]+'mcp-oauth'/);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
  assert.equal(released, true);
});

test("revoking MCP OAuth removes only the matching active slot and binding", async () => {
  const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
  let released = false;
  const encryptedRow = {
    id: "credential-mcp-test",
    environment_id: "environment-test",
    harness: "codex",
    credential_slot: "mcp-oauth",
    revision: 4,
    ciphertext: Buffer.from("ciphertext"),
    initialization_vector: Buffer.from("initialization-vector"),
    authentication_tag: Buffer.from("authentication-tag"),
    encryption_algorithm: "aes-256-gcm",
    encryption_key_id: "key-test",
    non_secret_metadata: { type: "mcp-oauth" },
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT id FROM environments")) {
        return { rows: [{ id: "environment-test" }], rowCount: 1 };
      }
      if (sql.includes("SELECT * FROM harness_credentials")) {
        return { rows: [encryptedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  const store = new CodexAuthStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  assert.deepEqual(
    await store.revokeMcpOAuthCredentialFromEnvironment(
      "environment-test",
      "credential-mcp-test",
    ),
    { revoked: true },
  );

  const credentialUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE harness_credentials"),
  );
  assert.match(credentialUpdate?.sql ?? "", /SET revoked_at = NOW\(\)/);
  assert.deepEqual(credentialUpdate?.values, ["credential-mcp-test"]);
  const bindingUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE environment_credential_bindings"),
  );
  assert.match(bindingUpdate?.sql ?? "", /SET status = 'revoked'/);
  assert.match(
    bindingUpdate?.sql ?? "",
    /harness = 'codex'[\s\S]+credential_slot = 'mcp-oauth'/,
  );
  assert.deepEqual(bindingUpdate?.values, ["environment-test"]);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
  assert.equal(released, true);
});

test("a stale OAuth revocation cannot remove a newer active revision", async () => {
  const mutations: string[] = [];
  const encryptedRow = {
    id: "credential-mcp-newer",
    environment_id: "environment-test",
    harness: "codex",
    credential_slot: "mcp-oauth",
    revision: 5,
    ciphertext: Buffer.from("ciphertext"),
    initialization_vector: Buffer.from("initialization-vector"),
    authentication_tag: Buffer.from("authentication-tag"),
    encryption_algorithm: "aes-256-gcm",
    encryption_key_id: "key-test",
    non_secret_metadata: { type: "mcp-oauth" },
  };
  const client = {
    async query(sql: string) {
      if (sql.includes("UPDATE ")) mutations.push(sql);
      if (sql.includes("SELECT id FROM environments")) {
        return { rows: [{ id: "environment-test" }], rowCount: 1 };
      }
      if (sql.includes("SELECT * FROM harness_credentials")) {
        return { rows: [encryptedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new CodexAuthStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  const result = await store.revokeMcpOAuthCredentialFromEnvironment(
    "environment-test",
    "credential-mcp-older",
  );

  assert.equal(result.revoked, false);
  if (!result.revoked) {
    assert.equal(result.credential.sourceId, "credential-mcp-newer");
    assert.equal(result.credential.revision, 5);
  }
  assert.deepEqual(mutations, []);
});
