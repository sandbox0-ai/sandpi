import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { SecretBox } from "@/server/secrets";
import type { SandpiStore } from "@/server/store";
import {
  codexCredentialAssociatedData,
  CodexEnvironmentAuthService,
} from "./auth-service";
import type { CodexAuthStore } from "./auth-store";

const silentLogger = {
  warn() {},
  error() {},
};

test("environment credential provider decrypts native auth only for its Environment", async () => {
  const box = new SecretBox("deployment-test-key-with-at-least-32-bytes");
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "x" },
  });
  const encrypted = box.encrypt(
    authJson,
    codexCredentialAssociatedData("env-test"),
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

  assert.deepEqual(
    await service.credentialForEnvironment("user-test", "env-test"),
    {
      sourceId: "credential-test",
      revision: 1,
      authJson,
    },
  );
  await assert.rejects(
    service.credentialForEnvironment("user-test", "env-other"),
    (error) =>
      error instanceof HttpError && error.code === "codex_credential_unreadable",
  );
});

test("account summary exposes only bounded non-secret Codex metadata", async () => {
  const store = {
    async getEnvironment() {
      return {
        codingAgent: {
          harness: "codex",
          lastVerified: 1_753_000_000,
        },
      };
    },
  } as unknown as SandpiStore;
  const authStore = {
    async getCredential() {
      return {
        metadata: {
          type: "chatgpt",
          email: " codex-user@example.com ",
          planType: "pro",
          models: { data: [{ id: "must-not-leak" }] },
          accessToken: "must-not-leak",
        },
      };
    },
  } as unknown as CodexAuthStore;
  const service = new CodexEnvironmentAuthService(
    store,
    authStore,
    {} as RuntimeAdapter,
    undefined,
    silentLogger,
  );

  assert.deepEqual(
    await service.accountForEnvironment("user-test", "env-test"),
    {
      type: "chatgpt",
      email: "codex-user@example.com",
      planType: "pro",
      lastVerified: 1_753_000_000,
    },
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
