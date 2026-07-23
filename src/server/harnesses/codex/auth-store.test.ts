import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { toUnixTimestamp } from "@/lib/time";
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
