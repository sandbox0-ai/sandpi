import assert from "node:assert/strict";
import test from "node:test";

import {
  publicCodexDeviceAuthFlow,
  type CodexDeviceAuthFlow,
} from "./auth-store";

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
    expiresAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  assert.doesNotMatch(
    JSON.stringify(publicCodexDeviceAuthFlow(flow)),
    /sandbox-secret|supervisor-secret|sensitive-tail|internal/,
  );
});
