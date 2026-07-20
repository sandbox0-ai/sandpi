import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { SecretBox } from "@/server/secrets";
import type { SandpiStore } from "@/server/store";
import {
  codexCredentialAssociatedData,
  codexMcpOAuthCredentialAssociatedData,
  CodexEnvironmentAuthService,
} from "./auth-service";
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
  assert.throws(
    () => service.requireMcpOAuthPersistence(),
    (error) =>
      error instanceof HttpError &&
      error.code === "credential_encryption_not_configured",
  );
});

test("MCP OAuth credentials are isolated from account and other Environment AAD", async () => {
  const box = new SecretBox("deployment-test-key-with-at-least-32-bytes");
  const credentialsJson = JSON.stringify({
    "github|test": {
      server_name: "github",
      access_token: "mcp-oauth-secret",
    },
  });
  const encrypted = box.encrypt(
    credentialsJson,
    codexMcpOAuthCredentialAssociatedData("env-test"),
  );
  const authStore = {
    async getMcpOAuthCredentialForEnvironmentRuntime() {
      return {
        environmentId: "env-test",
        sourceId: "credential-mcp-test",
        revision: 3,
        encrypted,
        metadata: { type: "mcp-oauth" },
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
  assert.doesNotThrow(() => service.requireMcpOAuthPersistence());

  assert.deepEqual(
    await service.mcpOAuthCredentialForEnvironmentRuntime("env-test"),
    {
      sourceId: "credential-mcp-test",
      revision: 3,
      credentialsJson,
    },
  );
  await assert.rejects(
    service.mcpOAuthCredentialForEnvironmentRuntime("env-other"),
    (error) =>
      error instanceof HttpError &&
      error.code === "codex_mcp_oauth_credential_unreadable",
  );

  const accountEncrypted = box.encrypt(
    credentialsJson,
    codexCredentialAssociatedData("env-test"),
  );
  const accountBoundStore = {
    async getMcpOAuthCredentialForEnvironmentRuntime() {
      return {
        environmentId: "env-test",
        sourceId: "credential-account-test",
        revision: 1,
        encrypted: accountEncrypted,
        metadata: { type: "mcp-oauth" },
      };
    },
  } as unknown as CodexAuthStore;
  const accountBoundService = new CodexEnvironmentAuthService(
    {} as SandpiStore,
    accountBoundStore,
    {} as RuntimeAdapter,
    box,
    silentLogger,
  );
  await assert.rejects(
    accountBoundService.mcpOAuthCredentialForEnvironmentRuntime("env-test"),
    (error) =>
      error instanceof HttpError &&
      error.code === "codex_mcp_oauth_credential_unreadable",
  );
});

test("empty MCP OAuth stores revoke the materialized durable slot", async () => {
  const box = new SecretBox("deployment-test-key-with-at-least-32-bytes");
  const encrypted = box.encrypt(
    '{"github|test":{"access_token":"old-secret"}}',
    codexMcpOAuthCredentialAssociatedData("env-test"),
  );
  const revocations: Array<{
    environmentId: string;
    expectedSourceId: string | undefined;
  }> = [];
  const authStore = {
    async getMcpOAuthCredentialForEnvironmentRuntime() {
      return {
        environmentId: "env-test",
        sourceId: "credential-mcp-test",
        revision: 2,
        encrypted,
        metadata: { type: "mcp-oauth" },
        bindingSourceId: "credential-mcp-test",
        bindingRevision: 2,
        bindingStatus: "active",
      };
    },
    async revokeMcpOAuthCredentialFromEnvironment(
      environmentId: string,
      expectedSourceId: string | undefined,
    ) {
      revocations.push({ environmentId, expectedSourceId });
      return { revoked: true as const };
    },
  } as unknown as CodexAuthStore;
  const service = new CodexEnvironmentAuthService(
    {} as SandpiStore,
    authStore,
    {} as RuntimeAdapter,
    box,
    silentLogger,
  );

  assert.equal(
    await service.syncMcpOAuthCredentialFromRuntime("env-test", undefined),
    undefined,
  );
  assert.equal(
    await service.syncMcpOAuthCredentialFromRuntime("env-test", " { } "),
    undefined,
  );
  assert.deepEqual(revocations, [
    {
      environmentId: "env-test",
      expectedSourceId: "credential-mcp-test",
    },
    {
      environmentId: "env-test",
      expectedSourceId: "credential-mcp-test",
    },
  ]);
});

test("MCP OAuth synchronization encrypts with slot AAD and marks its exact revision", async () => {
  const box = new SecretBox("deployment-test-key-with-at-least-32-bytes");
  const credentialsJson =
    '{"github|test":{"server_name":"github","access_token":"new-secret"}}';
  let encrypted: ReturnType<SecretBox["encrypt"]> | undefined;
  const materialized: Array<{
    environmentId: string;
    sourceId: string;
    revision: number;
  }> = [];
  const authStore = {
    async getMcpOAuthCredentialForEnvironmentRuntime() {
      return undefined;
    },
    async replaceMcpOAuthCredentialFromEnvironment(
      _environmentId: string,
      expectedSourceId: string | undefined,
      value: ReturnType<SecretBox["encrypt"]>,
    ) {
      assert.equal(expectedSourceId, undefined);
      encrypted = value;
      return {
        replaced: true as const,
        credential: {
          sourceId: "credential-mcp-new",
          revision: 7,
          encrypted: value,
          metadata: { type: "mcp-oauth" },
        },
      };
    },
    async markMcpOAuthCredentialMaterialized(
      environmentId: string,
      sourceId: string,
      revision: number,
    ) {
      materialized.push({ environmentId, sourceId, revision });
    },
  } as unknown as CodexAuthStore;
  const service = new CodexEnvironmentAuthService(
    {} as SandpiStore,
    authStore,
    {} as RuntimeAdapter,
    box,
    silentLogger,
  );

  assert.equal(
    await service.syncMcpOAuthCredentialFromRuntime(
      "env-test",
      credentialsJson,
    ),
    undefined,
  );
  assert.ok(encrypted);
  assert.equal(
    box.decrypt(
      encrypted,
      codexMcpOAuthCredentialAssociatedData("env-test"),
    ),
    credentialsJson,
  );
  assert.throws(() =>
    box.decrypt(encrypted!, codexCredentialAssociatedData("env-test")),
  );
  assert.deepEqual(materialized, [
    {
      environmentId: "env-test",
      sourceId: "credential-mcp-new",
      revision: 7,
    },
  ]);
});

test("an empty runtime cannot revoke a newer unmaterialized OAuth revision", async () => {
  const box = new SecretBox("deployment-test-key-with-at-least-32-bytes");
  const authoritativeJson =
    '{"linear|test":{"server_name":"linear","access_token":"newer-secret"}}';
  const authoritative = box.encrypt(
    authoritativeJson,
    codexMcpOAuthCredentialAssociatedData("env-test"),
  );
  const stale = box.encrypt(
    '{"github|test":{"access_token":"stale-secret"}}',
    codexMcpOAuthCredentialAssociatedData("env-test"),
  );
  const authStore = {
    async getMcpOAuthCredentialForEnvironmentRuntime() {
      return {
        environmentId: "env-test",
        sourceId: "credential-current",
        revision: 4,
        encrypted: stale,
        metadata: { type: "mcp-oauth" },
        bindingSourceId: "credential-materialized-before-current",
        bindingRevision: 3,
        bindingStatus: "stale",
      };
    },
    async revokeMcpOAuthCredentialFromEnvironment() {
      return {
        revoked: false as const,
        credential: {
          sourceId: "credential-newer",
          revision: 5,
          encrypted: authoritative,
          metadata: { type: "mcp-oauth" },
        },
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
    await service.syncMcpOAuthCredentialFromRuntime("env-test", "{}"),
    {
      sourceId: "credential-newer",
      revision: 5,
      credentialsJson: authoritativeJson,
    },
  );
});
