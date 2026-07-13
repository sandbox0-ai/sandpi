import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { SecretBox } from "@/server/secrets";
import type { SandpiStore } from "@/server/store";
import { CodexEnvironmentAuthService } from "./auth-service";
import type { CodexAuthStore } from "./auth-store";

const silentLogger = {
  warn() {},
  error() {},
};

test("environment credential provider decrypts the native auth.json only for its environment", async () => {
  const box = new SecretBox("deployment-test-key-with-at-least-32-bytes");
  const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x" } });
  const encrypted = box.encrypt(
    authJson,
    "sandpi:codex:environment-credential:env-test",
  );
  const authStore = {
    async getCredential() {
      return {
        sourceId: "credential-test",
        revision: 1,
        encrypted,
        metadata: { type: "chatgpt" },
      };
    },
  } as unknown as CodexAuthStore;
  const service = new CodexEnvironmentAuthService(
    {} as SandpiStore,
    authStore,
    {} as RuntimeAdapter,
    box,
    silentLogger,
  );

  assert.deepEqual(await service.credentialForEnvironment("user-test", "env-test"), {
    sourceId: "credential-test",
    revision: 1,
    authJson,
  });
  await assert.rejects(
    service.credentialForEnvironment("user-test", "env-other"),
    (error) =>
      error instanceof HttpError && error.code === "codex_credential_unreadable",
  );
});

test("Codex login is unavailable until deployment encryption is configured", async () => {
  const service = new CodexEnvironmentAuthService(
    {} as SandpiStore,
    {} as CodexAuthStore,
    {} as RuntimeAdapter,
    undefined,
    silentLogger,
  );
  await assert.rejects(
    service.credentialForEnvironment("user-test", "env-test"),
    (error) =>
      error instanceof HttpError &&
      error.code === "credential_encryption_not_configured",
  );
});
