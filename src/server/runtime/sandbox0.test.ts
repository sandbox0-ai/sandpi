import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { APIError } from "sandbox0";

import type { Environment } from "@/lib/types";
import { createSandbox0FetchWithRetry, Sandbox0Runtime } from "./sandbox0";
import {
  CODEX_MCP_OAUTH_CALLBACK_BASE_PATH,
  CODEX_MCP_OAUTH_CALLBACK_PORT,
  type EnvironmentRuntimeRecord,
} from "./types";

const environment: Environment = {
  id: "environment-test",
  ownerId: "user-test",
  idlePauseTimeoutSeconds: 30 * 60,
  sandboxMemoryMiB: 2 * 1024,
  workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
  name: "Development",
  description: "",
  color: "#151515",
  status: "ready",
  revision: 1,
  templateId: "coding-agent",
  rootfsSnapshotId: "rootfs-baseline",
  workspaceVolumeId: "volume-environment",
  sandboxId: "sandbox-environment",
  sandboxState: "running",
  supervisorSessionId: "",
  workspaceRoot: "/workspace",
  credentialRevision: 1,
  codingAgent: { harness: "codex", label: "Codex", status: "connected" },
  networkPolicy: {
    mode: "block-all",
    domainExceptions: ["github.com"],
  },
};

function runtimeWithClient(client: unknown) {
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", { value: client });
  return runtime;
}

function sandbox0FetchTimeout() {
  const cause = Object.assign(new Error("connect timed out"), {
    code: "ETIMEDOUT",
  });
  const error = new Error(
    "The request failed and the interceptors did not return an alternative response",
    { cause },
  );
  error.name = "FetchError";
  return error;
}

test("claims exactly one Environment Sandbox around its shared Workspace Volume", async () => {
  const allocations: Array<Record<string, string>> = [];
  let volumeCreates = 0;
  let claimInput: Record<string, unknown> | undefined;
  const runtime = runtimeWithClient({
    volumes: {
      async create() {
        volumeCreates += 1;
        return { id: "unexpected-volume" };
      },
    },
    sandboxes: {
      async claim(templateId: string, input: Record<string, unknown>) {
        assert.equal(templateId, "coding-agent");
        claimInput = input;
        return { id: "sandbox-environment" };
      },
      async waitForLifecycle(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return { status: "running" };
      },
    },
  });

  const provisioned = await runtime.provisionEnvironment({
    environment,
    async onResourcesAllocated(resources) {
      allocations.push(resources as Record<string, string>);
    },
  });

  assert.deepEqual(provisioned, {
    sandboxId: "sandbox-environment",
    workspaceVolumeId: "volume-environment",
  });
  assert.equal(volumeCreates, 0);
  assert.deepEqual((claimInput?.mounts as Array<Record<string, unknown>>)[0], {
    sandboxvolumeId: "volume-environment",
    mountPoint: "/workspace",
  });
  assert.equal(
    ((claimInput?.config ?? {}) as Record<string, unknown>).hardTtl,
    0,
  );
  assert.equal(((claimInput?.config ?? {}) as Record<string, unknown>).ttl, 0);
  assert.equal(
    ((claimInput?.config ?? {}) as Record<string, unknown>).autoResume,
    true,
  );
  assert.deepEqual(
    ((claimInput?.config ?? {}) as Record<string, unknown>).resources,
    { memory: "2048Mi" },
  );
  assert.deepEqual(
    ((claimInput?.config ?? {}) as Record<string, unknown>).network,
    {
      mode: "block-all",
      egress: {
        trafficRules: [
          {
            name: "sandpi-environment-domain-exceptions",
            action: "allow",
            domains: ["github.com"],
          },
        ],
      },
      credentialBindings: [],
    },
  );
  assert.deepEqual(allocations, [
    {
      sandboxId: "sandbox-environment",
      workspaceVolumeId: "volume-environment",
    },
  ]);
});

test("creates one Workspace Volume when provisioning a new Environment", async () => {
  const allocations: Array<Record<string, string>> = [];
  const runtime = runtimeWithClient({
    volumes: {
      async create() {
        return { id: "volume-new" };
      },
    },
    sandboxes: {
      async claim(
        _templateId: string,
        input: { mounts: Array<{ sandboxvolumeId: string }> },
      ) {
        assert.equal(input.mounts[0]?.sandboxvolumeId, "volume-new");
        return { id: "sandbox-new" };
      },
      async waitForLifecycle() {
        return { status: "running" };
      },
    },
  });

  const provisioned = await runtime.provisionEnvironment({
    environment: { ...environment, workspaceVolumeId: "" },
    async onResourcesAllocated(resources) {
      allocations.push(resources as Record<string, string>);
    },
  });

  assert.deepEqual(provisioned, {
    sandboxId: "sandbox-new",
    workspaceVolumeId: "volume-new",
  });
  assert.deepEqual(allocations, [
    { workspaceVolumeId: "volume-new" },
    { sandboxId: "sandbox-new", workspaceVolumeId: "volume-new" },
  ]);
});

test("disables Environment TTLs and executes Sandpi-owned pause", async () => {
  const updates: unknown[] = [];
  let paused = false;
  const runtime = runtimeWithClient({
    sandboxes: {
      async update(sandboxId: string, request: unknown) {
        assert.equal(sandboxId, "sandbox-environment");
        updates.push(request);
        return {};
      },
      async get() {
        return paused
          ? { status: "paused", paused: true }
          : { status: "running", paused: false };
      },
      async pauseAndWait() {
        paused = true;
        return { status: "paused", paused: true };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await runtime.applyEnvironmentLifecyclePolicy(coordinates);
  assert.deepEqual(updates, [
    { config: { ttl: 0, hardTtl: 0, autoResume: true } },
  ]);
  await runtime.pauseEnvironment(coordinates);
  assert.equal(paused, true);
});

test("updates the existing Environment Sandbox memory", async () => {
  const updates: Array<{ sandboxId: string; memory: string }> = [];
  const runtime = runtimeWithClient({
    sandboxes: {
      async updateMemory(sandboxId: string, memory: string) {
        updates.push({ sandboxId, memory });
        return { id: sandboxId, resources: { memory } };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await runtime.updateEnvironmentMemory(coordinates, 8 * 1024);

  assert.deepEqual(updates, [
    { sandboxId: "sandbox-environment", memory: "8192Mi" },
  ]);
});

test("preserves unrelated services and installs a constrained MCP OAuth callback", async () => {
  assert.equal(CODEX_MCP_OAUTH_CALLBACK_BASE_PATH, "/callback");
  let replacement: unknown;
  const unrelated = {
    id: "preview",
    displayName: "Preview",
    port: 3000,
    runtime: { type: "manual" as const },
    ingress: {
      _public: true,
      routes: [{ id: "preview", pathPrefix: "/", resume: true }],
    },
    publishable: true,
    publicUrl: "https://preview.example.invalid",
  };
  const staleCallback = {
    id: "sandpi-codex-mcp-oauth",
    port: 1234,
    runtime: { type: "manual" as const },
    ingress: { _public: false, routes: [] },
    publishable: false,
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return {
          async getServices() {
            return {
              sandboxId,
              services: [unrelated, staleCallback],
            };
          },
          async updateServices(services: unknown[]) {
            replacement = services;
            return {
              sandboxId,
              services: services.map((service) => {
                const candidate = service as { id: string };
                return {
                  ...candidate,
                  publishable: true,
                  publicUrl:
                    candidate.id === "sandpi-codex-mcp-oauth"
                      ? "https://oauth.example.invalid"
                      : "https://preview.example.invalid",
                };
              }),
            };
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  const callback = await runtime.ensureEnvironmentMcpOAuthCallbackService(
    coordinates,
    { port: CODEX_MCP_OAUTH_CALLBACK_PORT },
  );

  assert.deepEqual(callback, {
    port: CODEX_MCP_OAUTH_CALLBACK_PORT,
    publicUrl: "https://oauth.example.invalid",
  });
  assert.deepEqual(replacement, [
    {
      id: "preview",
      displayName: "Preview",
      port: 3000,
      runtime: {
        type: "manual",
        command: undefined,
        envVars: undefined,
      },
      ingress: {
        _public: true,
        routes: [
          {
            id: "preview",
            pathPrefix: "/",
            resume: true,
            methods: undefined,
            auth: undefined,
            cors: undefined,
            rateLimit: undefined,
          },
        ],
      },
      healthCheck: undefined,
    },
    {
      id: "sandpi-codex-mcp-oauth",
      displayName: "Codex MCP OAuth callback",
      port: CODEX_MCP_OAUTH_CALLBACK_PORT,
      runtime: { type: "manual" },
      ingress: {
        _public: true,
        routes: [
          {
            id: "oauth-callback",
            pathPrefix: `${CODEX_MCP_OAUTH_CALLBACK_BASE_PATH}/`,
            methods: ["GET"],
            auth: { mode: "none" },
            rateLimit: { rps: 5, burst: 10 },
            resume: false,
          },
        ],
      },
    },
  ]);
  assert.equal(JSON.stringify(replacement).includes("publicUrl"), false);
  assert.equal(JSON.stringify(replacement).includes("publishable"), false);
});

test("creates, restores and deletes native snapshots for the Environment Workspace Volume", async () => {
  const calls: Array<{ operation: string; volumeId: string; value: unknown }> = [];
  const runtime = runtimeWithClient({
    volumes: {
      async createSnapshot(volumeId: string, request: unknown) {
        calls.push({ operation: "create", volumeId, value: request });
        return {
          id: "snapshot-workspace-one",
          volumeId,
          name: "sandpi-workspace-backup",
          sizeBytes: 1_048_576,
          createdAt: "2026-07-21T12:00:00.000Z",
        };
      },
      async deleteSnapshot(volumeId: string, snapshotId: string) {
        calls.push({ operation: "delete", volumeId, value: snapshotId });
        return { message: "deleted" };
      },
      async restoreSnapshot(volumeId: string, snapshotId: string) {
        calls.push({ operation: "restore", volumeId, value: snapshotId });
        return { status: "restored" };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  const snapshot = await runtime.createEnvironmentWorkspaceBackup(coordinates, {
    name: "sandpi-workspace-backup",
    description: "Environment backup",
  });
  await runtime.restoreEnvironmentWorkspaceBackup(coordinates, snapshot.id);
  await runtime.deleteEnvironmentWorkspaceBackup(
    coordinates,
    snapshot.id,
  );

  assert.deepEqual(snapshot, {
    id: "snapshot-workspace-one",
    name: "sandpi-workspace-backup",
    sizeBytes: 1_048_576,
    createdAt: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.deepEqual(calls, [
    {
      operation: "create",
      volumeId: "volume-environment",
      value: {
        name: "sandpi-workspace-backup",
        description: "Environment backup",
      },
    },
    {
      operation: "restore",
      volumeId: "volume-environment",
      value: "snapshot-workspace-one",
    },
    {
      operation: "delete",
      volumeId: "volume-environment",
      value: "snapshot-workspace-one",
    },
  ]);
});

test("waits for the paused Sandbox ctld portal to unmount before restoring a Workspace snapshot", async () => {
  let attempts = 0;
  const runtime = runtimeWithClient({
    volumes: {
      async restoreSnapshot(volumeId: string, snapshotId: string) {
        assert.equal(volumeId, "volume-environment");
        assert.equal(snapshotId, "snapshot-workspace-one");
        attempts += 1;
        if (attempts === 1) {
          throw new APIError({
            statusCode: 409,
            code: "conflict",
            message:
              "ctld-mounted volumes must be unmounted before snapshot or restore",
          });
        }
        return { status: "restored" };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await runtime.restoreEnvironmentWorkspaceBackup(
    coordinates,
    "snapshot-workspace-one",
  );

  assert.equal(attempts, 2);
});

test("does not retry unrelated Workspace snapshot restore conflicts", async () => {
  let attempts = 0;
  const runtime = runtimeWithClient({
    volumes: {
      async restoreSnapshot() {
        attempts += 1;
        throw new APIError({
          statusCode: 409,
          code: "conflict",
          message: "snapshot restore is already in progress",
        });
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await assert.rejects(
    runtime.restoreEnvironmentWorkspaceBackup(
      coordinates,
      "snapshot-workspace-one",
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "sandbox0_conflict");
      return true;
    },
  );
  assert.equal(attempts, 1);
});

 test("uses Sandbox0 runtime access to auto-resume a paused Environment", async () => {
  let paused = true;
  let runtimeGeneration = 1;
  let workspaceAccesses = 0;
  let lifecycleWaits = 0;
  let explicitResumes = 0;
  const operations: string[] = [];
  const sandbox = {
    async listFiles(path: string) {
      assert.equal(path, "/workspace");
      operations.push("workspace");
      workspaceAccesses += 1;
      if (paused) {
        throw new APIError({
          statusCode: 503,
          code: "unavailable",
          message: "sandbox is waking up",
        });
      }
      return [];
    },
    async mkdir() {
      if (paused) {
        throw new APIError({
          statusCode: 503,
          code: "unavailable",
          message: "sandbox is waking up",
        });
      }
      operations.push("credential-mkdir");
    },
    async writeFile() {
      operations.push("credential-write");
    },
    async cmd() {
      operations.push("command");
      return { exitCode: 0 };
    },
    async getSession(sessionId: string) {
      assert.equal(sessionId, "supervisor-environment");
      return {
        id: sessionId,
        attempt: { id: "attempt-recovered" },
        runtimeGeneration,
      };
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return sandbox;
      },
      async get() {
        return {
          status: paused ? "paused" : "running",
          paused,
          runtimeGeneration,
        };
      },
      async waitForLifecycle(
        sandboxId: string,
        predicate: (value: {
          status: string;
          paused: boolean;
          runtimeGeneration: number;
        }) => boolean | Promise<boolean>,
      ) {
        assert.equal(sandboxId, "sandbox-environment");
        lifecycleWaits += 1;
        paused = false;
        runtimeGeneration = 2;
        const running = {
          status: "running",
          paused: false,
          runtimeGeneration,
        };
        assert.equal(await predicate(running), true);
        return running;
      },
      async resumeAndWait() {
        explicitResumes += 1;
        throw new Error("Sandpi must not explicitly resume");
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-before-pause",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  const recovered = await runtime.ensureCodexEnvironmentRuntime(
    coordinates,
    '{"tokens":{"access_token":"test"}}',
  );

  assert.equal(workspaceAccesses, 1);
  assert.equal(lifecycleWaits, 1);
  assert.equal(explicitResumes, 0);
  assert.equal(recovered.runtimeGeneration, 2);
  assert.equal(recovered.sandboxRestarted, true);
  assert.ok(
    operations.indexOf("credential-write") < operations.indexOf("workspace"),
  );
});

test("rehydrates the Codex credential after missing Supervisor repair restarts the Sandbox", async () => {
  let paused = false;
  let runtimeGeneration = 1;
  let supervisorReads = 0;
  let credentialGeneration: number | undefined;
  const credentialWrites: number[] = [];
  const operations: string[] = [];
  const sandbox = {
    async listFiles(path: string) {
      assert.equal(path, "/workspace");
      operations.push("workspace");
      if (paused) {
        throw new APIError({
          statusCode: 503,
          code: "unavailable",
          message: "sandbox is waking up",
        });
      }
      return [];
    },
    async mkdir() {},
    async writeFile() {
      credentialGeneration = runtimeGeneration;
      credentialWrites.push(runtimeGeneration);
      operations.push(`credential-${runtimeGeneration}`);
    },
    async cmd(name: string) {
      operations.push(
        name.startsWith("chmod ") ? `chmod-${runtimeGeneration}` : name,
      );
      return { exitCode: 0 };
    },
    async getSession(sessionId: string) {
      assert.equal(sessionId, "supervisor-environment");
      supervisorReads += 1;
      if (supervisorReads === 1) {
        throw new APIError({
          statusCode: 404,
          code: "not_found",
          message: "session not found",
        });
      }
      return {
        id: sessionId,
        attempt: { id: "attempt-recovered" },
        runtimeGeneration,
      };
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return sandbox;
      },
      async get() {
        return {
          status: paused ? "paused" : "running",
          paused,
          runtimeGeneration,
        };
      },
      async pauseAndWait() {
        operations.push("pause");
        paused = true;
        credentialGeneration = undefined;
      },
      async waitForLifecycle(
        _sandboxId: string,
        predicate: (value: {
          status: string;
          paused: boolean;
          runtimeGeneration: number;
        }) => boolean | Promise<boolean>,
      ) {
        paused = false;
        runtimeGeneration = 2;
        const running = {
          status: "running",
          paused: false,
          runtimeGeneration,
        };
        assert.equal(await predicate(running), true);
        return running;
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-before-repair",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  const recovered = await runtime.ensureCodexEnvironmentRuntime(
    coordinates,
    '{"tokens":{"access_token":"test"}}',
  );

  assert.deepEqual(credentialWrites, [1, 2]);
  assert.equal(credentialGeneration, recovered.runtimeGeneration);
  assert.ok(operations.indexOf("pause") < operations.indexOf("credential-2"));
  assert.deepEqual(recovered, {
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-recovered",
    runtimeGeneration: 2,
    sandboxRestarted: true,
  });
});

test("rehydrates the Codex credential after Workspace transport repair", async () => {
  let paused = false;
  let runtimeGeneration = 1;
  let workspaceAccesses = 0;
  let credentialGeneration: number | undefined;
  const credentialWrites: number[] = [];
  const sandbox = {
    async listFiles(path: string) {
      assert.equal(path, "/workspace");
      workspaceAccesses += 1;
      if (workspaceAccesses === 1) {
        throw new Error("transport endpoint is not connected");
      }
      if (paused) {
        throw new APIError({
          statusCode: 503,
          code: "unavailable",
          message: "sandbox is waking up",
        });
      }
      return [];
    },
    async mkdir() {},
    async writeFile() {
      credentialGeneration = runtimeGeneration;
      credentialWrites.push(runtimeGeneration);
    },
    async cmd() {
      return { exitCode: 0 };
    },
    async getSession(sessionId: string) {
      assert.equal(sessionId, "supervisor-environment");
      return {
        id: sessionId,
        attempt: { id: "attempt-recovered" },
        runtimeGeneration,
      };
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return sandbox;
      },
      async get() {
        return {
          status: paused ? "paused" : "running",
          paused,
          runtimeGeneration,
        };
      },
      async pauseAndWait() {
        paused = true;
        credentialGeneration = undefined;
      },
      async waitForLifecycle(
        _sandboxId: string,
        predicate: (value: {
          status: string;
          paused: boolean;
          runtimeGeneration: number;
        }) => boolean | Promise<boolean>,
      ) {
        paused = false;
        runtimeGeneration = 2;
        const running = {
          status: "running",
          paused: false,
          runtimeGeneration,
        };
        assert.equal(await predicate(running), true);
        return running;
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-before-repair",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  const recovered = await runtime.ensureCodexEnvironmentRuntime(
    coordinates,
    '{"tokens":{"access_token":"test"}}',
  );

  assert.deepEqual(credentialWrites, [1, 2]);
  assert.equal(credentialGeneration, recovered.runtimeGeneration);
  assert.equal(recovered.runtimeGeneration, 2);
  assert.equal(recovered.sandboxRestarted, true);
});

test("rejects a credential write whose post-write Sandbox generation changed", async () => {
  let runtimeGeneration = 1;
  let lifecycleReads = 0;
  let credentialGeneration: number | undefined;
  let workspaceAccesses = 0;
  const sandbox = {
    async mkdir() {},
    async writeFile() {
      credentialGeneration = runtimeGeneration;
    },
    async cmd() {
      return { exitCode: 0 };
    },
    async listFiles() {
      workspaceAccesses += 1;
      return [];
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return sandbox;
      },
      async get() {
        lifecycleReads += 1;
        if (lifecycleReads === 2) {
          runtimeGeneration = 2;
          credentialGeneration = undefined;
        }
        return {
          status: "running",
          paused: false,
          runtimeGeneration,
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-before-restart",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await assert.rejects(
    runtime.ensureCodexEnvironmentRuntime(
      coordinates,
      '{"tokens":{"access_token":"test"}}',
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "codex_runtime_epoch_changed",
      );
      return true;
    },
  );
  assert.equal(credentialGeneration, undefined);
  assert.equal(workspaceAccesses, 0);
});

test("does not swallow an unrelated Supervisor attempt conflict", async () => {
  const conflict = new APIError({
    statusCode: 409,
    code: "session_conflict",
    message: "the Supervisor specification is invalid",
  });
  let supervisorReads = 0;
  const stoppedSupervisor = {
    id: "supervisor-environment",
    attempt: {
      id: "attempt-stopped",
      finishedAt: new Date("2026-07-19T00:00:00.000Z"),
    },
    runtimeGeneration: 1,
  };
  const sandbox = {
    async mkdir() {},
    async writeFile() {},
    async cmd() {
      return { exitCode: 0 };
    },
    async listFiles() {
      return [];
    },
    async getSession() {
      supervisorReads += 1;
      return stoppedSupervisor;
    },
    async createSessionAttempt() {
      throw conflict;
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return sandbox;
      },
      async get() {
        return {
          status: "running",
          paused: false,
          runtimeGeneration: 1,
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-stopped",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await assert.rejects(
    runtime.ensureCodexEnvironmentRuntime(coordinates, "{}"),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "sandbox0_session_conflict",
      );
      return true;
    },
  );
  assert.equal(supervisorReads, 2);
});

test("accepts a Supervisor attempt conflict only after Sandbox0 proves the live race winner", async () => {
  const conflict = new APIError({
    statusCode: 409,
    code: "session_conflict",
    message: "a concurrent recovery already started the attempt",
  });
  let supervisorReads = 0;
  const sandbox = {
    async mkdir() {},
    async writeFile() {},
    async cmd() {
      return { exitCode: 0 };
    },
    async listFiles() {
      return [];
    },
    async getSession() {
      supervisorReads += 1;
      if (supervisorReads === 1) {
        return {
          id: "supervisor-environment",
          attempt: {
            id: "attempt-stopped",
            finishedAt: new Date("2026-07-19T00:00:00.000Z"),
          },
          runtimeGeneration: 1,
        };
      }
      return {
        id: "supervisor-environment",
        attempt: { id: "attempt-race-winner" },
        runtimeGeneration: 1,
      };
    },
    async createSessionAttempt() {
      throw conflict;
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return sandbox;
      },
      async get() {
        return {
          status: "running",
          paused: false,
          runtimeGeneration: 1,
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-stopped",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  assert.deepEqual(
    await runtime.ensureCodexEnvironmentRuntime(coordinates, "{}"),
    {
      supervisorSessionId: "supervisor-environment",
      attemptId: "attempt-race-winner",
      runtimeGeneration: 1,
      sandboxRestarted: false,
    },
  );
  assert.equal(supervisorReads, 2);
});

test("restores harness-neutral access without starting Codex", async () => {
  let workspaceAccesses = 0;
  let lifecycleWaits = 0;
  let lifecycleReads = 0;
  let codexMutations = 0;
  const sandbox = {
    async listFiles(path: string) {
      assert.equal(path, "/workspace");
      workspaceAccesses += 1;
      if (workspaceAccesses === 1) {
        throw new APIError({
          statusCode: 503,
          code: "unavailable",
          message: "sandbox is waking up",
        });
      }
      return [];
    },
    async mkdir() {
      codexMutations += 1;
    },
    async writeFile() {
      codexMutations += 1;
    },
    async createSession() {
      codexMutations += 1;
      return {};
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return sandbox;
      },
      async get() {
        lifecycleReads += 1;
        return {
          status: "running",
          paused: false,
          runtimeGeneration: 2,
        };
      },
      async waitForLifecycle(
        _sandboxId: string,
        predicate: (value: {
          status: string;
          paused: boolean;
          runtimeGeneration: number;
        }) => boolean | Promise<boolean>,
      ) {
        lifecycleWaits += 1;
        const running = {
          status: "running",
          paused: false,
          runtimeGeneration: 2,
        };
        assert.equal(await predicate(running), true);
        return running;
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await runtime.ensureEnvironmentRuntimeAccess(coordinates);

  assert.equal(workspaceAccesses, 2);
  assert.equal(lifecycleWaits, 1);
  assert.equal(lifecycleReads, 1);
  assert.equal(codexMutations, 0);
});

test("repairs a disconnected Workspace portal for harness-neutral access", async () => {
  let workspaceAccesses = 0;
  let pauses = 0;
  let lifecycleReads = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async listFiles(path: string) {
            assert.equal(path, "/workspace");
            workspaceAccesses += 1;
            if (workspaceAccesses === 1) {
              throw new Error("transport endpoint is not connected");
            }
            return [];
          },
        };
      },
      async get() {
        lifecycleReads += 1;
        return {
          status: "running",
          paused: false,
          runtimeGeneration: 2,
        };
      },
      async pauseAndWait(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        pauses += 1;
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await runtime.ensureEnvironmentRuntimeAccess(coordinates);

  assert.equal(workspaceAccesses, 2);
  assert.equal(pauses, 1);
  assert.equal(lifecycleReads, 2);
});

test("starts one Environment-scoped Codex app-server without unsupported plugin discovery", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const commands: Array<{ name: string; command?: string[] }> = [];
  const sessions: Array<{
    spec: Record<string, unknown>;
    idempotencyKey?: string;
  }> = [];
  const sandbox = {
    async listFiles(path: string) {
      assert.equal(path, "/workspace");
      return [];
    },
    async mkdir() {},
    async writeFile(path: string, content: Uint8Array) {
      writes.push({ path, content: Buffer.from(content).toString("utf8") });
    },
    async deleteFile() {
      return { message: "deleted" };
    },
    async cmd(name: string, options: { command?: string[] }) {
      commands.push({ name, command: options.command });
      return { exitCode: 0 };
    },
    async createSession(
      spec: Record<string, unknown>,
      options: { idempotencyKey?: string },
    ) {
      sessions.push({ spec, idempotencyKey: options.idempotencyKey });
      return {
        id: "supervisor-environment",
        attempt: { id: "attempt-environment" },
        runtimeGeneration: 3,
      };
    },
  };
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return sandbox;
      },
      async get() {
        return {
          status: "running",
          paused: false,
          runtimeGeneration: 3,
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 0,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 0,
    },
  };

  const recovered = await runtime.ensureCodexEnvironmentRuntime(
    coordinates,
    '{"tokens":{"access_token":"test"}}',
  );

  assert.deepEqual(recovered, {
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-environment",
    runtimeGeneration: 3,
    sandboxRestarted: false,
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    path: "/dev/shm/sandpi-codex-auth.json",
    content: '{"tokens":{"access_token":"test"}}',
  });
  assert.equal(sessions.length, 1);
  assert.equal(
    sessions[0]?.idempotencyKey,
    "sandpi-codex-environment-environment-test",
  );
  assert.equal(sessions[0]?.spec.cwd, "/workspace");
  assert.deepEqual(sessions[0]?.spec.env, {
    HOME: "/workspace",
    CODEX_HOME: "/workspace/.sandpi/harnesses/codex",
  });
  assert.doesNotMatch(
    String((sessions[0]?.spec.command as string[] | undefined)?.at(-1)),
    /mcp_oauth_credentials_store="file"/,
  );
  assert.match(
    String((sessions[0]?.spec.command as string[] | undefined)?.at(-1)),
    /codex app-server --stdio[\s\S]+--disable apps[\s\S]+--disable plugins[\s\S]+--disable remote_plugin[\s\S]+--disable tool_suggest/,
  );
  assert.ok(
    commands.some(
      (command) =>
        command.name === "prepare-environment-codex-home" &&
        command.command?.at(-1)?.includes("environment_v1") &&
        command.command
          ?.at(-1)
          ?.includes(
            'readlink "$home/.credentials.json")" = "/dev/shm/sandpi-codex-mcp-oauth.json"',
          ),
    ),
  );
});

test("retries safe Sandbox0 reads after transient transport failures", async () => {
  let calls = 0;
  const fetchWithRetry = createSandbox0FetchWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw sandbox0FetchTimeout();
    return new Response("ok", { status: 200 });
  });

  const response = await fetchWithRetry("http://sandbox0.invalid/resource", {
    method: "GET",
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test("stops retrying safe Sandbox0 reads when their signal is aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchWithRetry = createSandbox0FetchWithRetry(async () => {
    calls += 1;
    controller.abort();
    throw sandbox0FetchTimeout();
  });

  await assert.rejects(
    fetchWithRetry("http://sandbox0.invalid/resource", {
      method: "GET",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("does not replay a generic Sandbox0 mutation", async () => {
  let calls = 0;
  const fetchWithRetry = createSandbox0FetchWithRetry(async () => {
    calls += 1;
    throw sandbox0FetchTimeout();
  });

  await assert.rejects(
    fetchWithRetry("http://sandbox0.invalid/resource", { method: "POST" }),
    { name: "FetchError" },
  );
  assert.equal(calls, 1);
});

test("retries transient Supervisor writes without duplicating input", async () => {
  let sessionReads = 0;
  let inputWrites = 0;
  const requests: unknown[] = [];
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async getSession() {
            sessionReads += 1;
            return {
              attempt: { id: "attempt-retry" },
              runtimeGeneration: 1,
            };
          },
          async writeSessionInput(_sessionId: string, request: unknown) {
            inputWrites += 1;
            requests.push(request);
            if (inputWrites === 1) throw sandbox0FetchTimeout();
            return { accepted: true };
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-retry",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await runtime.writeCodexMessage(
    coordinates,
    { id: 1, method: "turn/start", params: {} },
    "00000000-0000-4000-8000-000000000001",
  );

  assert.equal(sessionReads, 1);
  assert.equal(inputWrites, 2);
  assert.deepEqual(requests[0], requests[1]);
});

test("rejects stale Supervisor coordinates before writing input", async () => {
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-current",
    runtimeGeneration: 7,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 7,
    },
  };
  const actualEpochs = [
    {
      attempt: { id: "attempt-replaced" },
      runtimeGeneration: coordinates.runtimeGeneration,
    },
    {
      attempt: { id: coordinates.attemptId },
      runtimeGeneration: coordinates.runtimeGeneration + 1,
    },
  ];

  for (const actualEpoch of actualEpochs) {
    let inputWrites = 0;
    const runtime = runtimeWithClient({
      sandboxes: {
        sandbox() {
          return {
            async getSession() {
              return actualEpoch;
            },
            async writeSessionInput() {
              inputWrites += 1;
              return { accepted: true };
            },
          };
        },
      },
    });

    await assert.rejects(
      runtime.writeCodexMessage(
        coordinates,
        { id: 1, method: "thread/read", params: {} },
        "00000000-0000-4000-8000-000000000010",
      ),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.equal(
          (error as { code?: string }).code,
          "codex_runtime_epoch_changed",
        );
        return true;
      },
    );
    assert.equal(inputWrites, 0);
  }
});

test("maps an expected-attempt input conflict to safe epoch recovery", async () => {
  let inputWrites = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async getSession() {
            return {
              attempt: { id: "attempt-current" },
              runtimeGeneration: 7,
            };
          },
          async writeSessionInput() {
            inputWrites += 1;
            throw new APIError({
              statusCode: 409,
              code: "session_conflict",
              message: "session attempt mismatch",
            });
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-current",
    runtimeGeneration: 7,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      attemptId: "attempt-current",
      runtimeGeneration: 7,
    },
  };

  await assert.rejects(
    runtime.writeCodexMessage(
      coordinates,
      { id: 1, method: "thread/read", params: {} },
      "00000000-0000-4000-8000-000000000011",
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "codex_runtime_epoch_changed",
      );
      return true;
    },
  );
  assert.equal(inputWrites, 1);
});

test("uses abortable generated APIs for cancellable Supervisor writes", async () => {
  const controller = new AbortController();
  let highLevelSessionReads = 0;
  let highLevelInputWrites = 0;
  let generatedSessionReads = 0;
  let generatedInputWrites = 0;
  const runtime = runtimeWithClient({
    apispec: {
      sessions: {
        async apiV1SandboxesIdSessionsSessionIdGet(
          request: { id: string; sessionId: string },
          init: RequestInit,
        ) {
          generatedSessionReads += 1;
          assert.deepEqual(request, {
            id: "sandbox-environment",
            sessionId: "supervisor-environment",
          });
          assert.equal(init.signal, controller.signal);
          return {
            success: true,
            data: {
              attempt: { id: "attempt-abortable" },
              runtimeGeneration: 1,
            },
          };
        },
        async apiV1SandboxesIdSessionsSessionIdInputsPost(
          request: {
            id: string;
            sessionId: string;
            executionSessionInputRequest: {
              expectedAttemptId: string;
            };
          },
          init: RequestInit,
        ) {
          generatedInputWrites += 1;
          assert.equal(request.id, "sandbox-environment");
          assert.equal(request.sessionId, "supervisor-environment");
          assert.equal(
            request.executionSessionInputRequest.expectedAttemptId,
            "attempt-abortable",
          );
          assert.equal(init.signal, controller.signal);
          controller.abort();
          throw sandbox0FetchTimeout();
        },
      },
    },
    sandboxes: {
      sandbox() {
        return {
          async getSession() {
            highLevelSessionReads += 1;
            throw new Error("cancellable reads must use the generated API");
          },
          async writeSessionInput() {
            highLevelInputWrites += 1;
            throw new Error("cancellable writes must use the generated API");
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-abortable",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await assert.rejects(
    runtime.writeCodexMessage(
      coordinates,
      { id: 3, method: "thread/read", params: {} },
      "00000000-0000-4000-8000-000000000003",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(generatedSessionReads, 1);
  assert.equal(generatedInputWrites, 1);
  assert.equal(highLevelSessionReads, 0);
  assert.equal(highLevelInputWrites, 0);
});

test("reports exhausted Sandbox0 transport failures as retryable unavailability", async () => {
  let sessionReads = 0;
  let inputWrites = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async getSession() {
            sessionReads += 1;
            return {
              attempt: { id: "attempt-unavailable" },
              runtimeGeneration: 1,
            };
          },
          async writeSessionInput() {
            inputWrites += 1;
            throw sandbox0FetchTimeout();
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    attemptId: "attempt-unavailable",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };

  await assert.rejects(
    runtime.writeCodexMessage(
      coordinates,
      { id: 2, method: "turn/start", params: {} },
      "00000000-0000-4000-8000-000000000002",
    ),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 503);
      assert.equal((error as { code?: string }).code, "sandbox0_unavailable");
      assert.match((error as Error).message, /temporarily unreachable/i);
      return true;
    },
  );
  assert.equal(sessionReads, 1);
  assert.equal(inputWrites, 3);
});

test("reports Sandbox0 deployment credential failures with operator guidance", async () => {
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };
  const cases = [
    {
      statusCode: 401,
      upstreamCode: "unauthorized",
      code: "sandbox0_invalid_api_key",
      message: /SANDBOX0_API_KEY/,
    },
    {
      statusCode: 403,
      upstreamCode: "forbidden",
      code: "sandbox0_permission_denied",
      message: /required deployment role and permissions/,
    },
  ] as const;

  for (const expected of cases) {
    const runtime = runtimeWithClient({
      sandboxes: {
        async get() {
          throw new APIError({
            statusCode: expected.statusCode,
            code: expected.upstreamCode,
            message: expected.upstreamCode,
          });
        },
      },
    });

    await assert.rejects(
      runtime.pauseEnvironment(coordinates),
      (error: unknown) => {
        assert.equal(
          (error as { statusCode?: number }).statusCode,
          expected.statusCode,
        );
        assert.equal((error as { code?: string }).code, expected.code);
        assert.match((error as Error).message, expected.message);
        return true;
      },
    );
  }
});

test("all Environment file access resolves through the shared Sandbox", async () => {
  const sandboxIds: string[] = [];
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        sandboxIds.push(sandboxId);
        return {
          async statFile(path: string) {
            assert.equal(path, "/workspace/README.md");
            return { type: "file", size: 5, isLink: false };
          },
          async readFile(path: string) {
            assert.equal(path, "/workspace/README.md");
            return Buffer.from("hello");
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  const content = await runtime.readFile(coordinates, "/workspace/README.md");
  assert.equal(Buffer.from(content).toString("utf8"), "hello");
  assert.deepEqual(sandboxIds, ["sandbox-environment"]);
});

test("reads a native Codex rollout only from its bound managed path", async () => {
  const nativeSessionId = "019f-native-thread";
  const rolloutPath =
    "/workspace/.sandpi/harnesses/codex/sessions/2026/07/18/" +
    `rollout-test-${nativeSessionId}.jsonl`;
  const statPaths: string[] = [];
  let reads = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, environment.sandboxId);
        return {
          async statFile(path: string) {
            statPaths.push(path);
            return path === rolloutPath
              ? { type: "file", size: 8, isLink: false }
              : { type: "dir", size: 0, isLink: false };
          },
          async readFile(path: string) {
            reads += 1;
            assert.equal(path, rolloutPath);
            return Buffer.from("rollout\n");
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  const content = await runtime.readCodexRollout(
    coordinates,
    rolloutPath,
    nativeSessionId,
  );

  assert.equal(Buffer.from(content).toString("utf8"), "rollout\n");
  assert.equal(reads, 1);
  assert.equal(statPaths.at(-1), rolloutPath);
  assert.ok(statPaths.includes("/workspace/.sandpi/harnesses/codex"));
  await assert.rejects(
    runtime.readCodexRollout(
      coordinates,
      `/workspace/private/rollout-test-${nativeSessionId}.jsonl`,
      nativeSessionId,
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "codex_rollout_path_invalid",
      );
      return true;
    },
  );
  assert.equal(reads, 1);
});

test("rejects a Codex rollout reached through a symbolic link", async () => {
  const nativeSessionId = "019f-native-thread";
  const rolloutPath =
    "/workspace/.sandpi/harnesses/codex/sessions/2026/07/18/" +
    `rollout-test-${nativeSessionId}.jsonl`;
  let reads = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async statFile(path: string) {
            return path === "/workspace/.sandpi/harnesses/codex"
              ? { type: "symlink", size: 0, isLink: true }
              : { type: "dir", size: 0, isLink: false };
          },
          async readFile() {
            reads += 1;
            return Buffer.from("must not read");
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  await assert.rejects(
    runtime.readCodexRollout(coordinates, rolloutPath, nativeSessionId),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "codex_rollout_path_symlink",
      );
      return true;
    },
  );
  assert.equal(reads, 0);
});

test("falls back to Codex's compressed rollout sibling", async () => {
  const nativeSessionId = "019f-native-thread";
  const rolloutPath =
    "/workspace/.sandpi/harnesses/codex/sessions/2026/07/18/" +
    `rollout-test-${nativeSessionId}.jsonl`;
  const compressedPath = `${rolloutPath}.zst`;
  const compressed = zstdCompressSync(Buffer.from("compressed rollout\n"));
  const readPaths: string[] = [];
  const missing = () =>
    new APIError({
      statusCode: 404,
      code: "not_found",
      message: "not found",
    });
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async statFile(path: string) {
            if (path === rolloutPath) throw missing();
            return path === compressedPath
              ? { type: "file", size: compressed.byteLength, isLink: false }
              : { type: "dir", size: 0, isLink: false };
          },
          async readFile(path: string) {
            readPaths.push(path);
            assert.equal(path, compressedPath);
            return compressed;
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  const content = await runtime.readCodexRollout(
    coordinates,
    rolloutPath,
    nativeSessionId,
  );

  assert.equal(Buffer.from(content).toString("utf8"), "compressed rollout\n");
  assert.deepEqual(readPaths, [compressedPath]);
});

test("bounds decompressed Codex rollout output", async () => {
  const nativeSessionId = "019f-native-thread";
  const rolloutPath =
    "/workspace/.sandpi/harnesses/codex/sessions/2026/07/18/" +
    `rollout-test-${nativeSessionId}.jsonl`;
  const compressedPath = `${rolloutPath}.zst`;
  const compressed = zstdCompressSync(Buffer.alloc(16 * 1024 * 1024 + 1));
  const missing = () =>
    new APIError({
      statusCode: 404,
      code: "not_found",
      message: "not found",
    });
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async statFile(path: string) {
            if (path === rolloutPath) throw missing();
            return path === compressedPath
              ? { type: "file", size: compressed.byteLength, isLink: false }
              : { type: "dir", size: 0, isLink: false };
          },
          async readFile() {
            return compressed;
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  await assert.rejects(
    runtime.readCodexRollout(coordinates, rolloutPath, nativeSessionId),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "codex_rollout_too_large",
      );
      return true;
    },
  );
});

test("streams retained and live Codex events from the Supervisor cursor", async () => {
  const watches: Array<{
    sessionId: string;
    after?: number;
    signal?: AbortSignal;
  }> = [];
  let closes = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return {
          async watchSessionEvents(
            sessionId: string,
            options: { after?: number; signal?: AbortSignal },
          ) {
            watches.push({ sessionId, ...options });
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  seq: 8,
                  runtimeGeneration: 2,
                  attemptId: "attempt-stream",
                  type: "output",
                  stream: "stdout",
                  dataBase64: Buffer.from("{}\n").toString("base64"),
                  occurredAt: new Date("2026-07-16T01:02:03.000Z"),
                };
              },
              async close() {
                closes += 1;
              },
            };
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    supervisorSessionId: "supervisor-environment-test",
    attemptId: "attempt-stream",
    runtimeGeneration: 2,
    decoder: {
      supervisorCursor: 7,
      tailBase64: "",
      attemptId: "attempt-stream",
      runtimeGeneration: 2,
    },
  };
  const controller = new AbortController();

  const stream = await runtime.watchCodexEvents(
    coordinates,
    7,
    controller.signal,
  );
  const events = [];
  for await (const event of stream.events) events.push(event);
  await stream.close();

  assert.deepEqual(watches, [
    {
      sessionId: "supervisor-environment-test",
      after: 7,
      signal: controller.signal,
    },
  ]);
  assert.equal(events[0]?.occurredAt, "2026-07-16T01:02:03.000Z");
  assert.equal(closes, 1);
});

test("lists one Workspace directory without recursively expanding folders", async () => {
  const listedPaths: string[] = [];
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return {
          async listFiles(directoryPath: string) {
            listedPaths.push(directoryPath);
            return [
              {
                name: "src",
                path: "/workspace/src",
                type: "dir",
                size: 0,
              },
              {
                name: ".codex",
                path: "/workspace/.codex",
                type: "dir",
                size: 0,
              },
              {
                name: ".sandpi",
                path: "/workspace/.sandpi",
                type: "dir",
                size: 0,
              },
              {
                name: "node_modules",
                path: "/workspace/node_modules",
                type: "dir",
                size: 0,
              },
              {
                name: ".env",
                path: "/workspace/.env",
                type: "file",
                size: 12,
              },
              {
                name: "README.md",
                path: "/workspace/README.md",
                type: "file",
                size: 5,
              },
            ];
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  const listing = await runtime.listFiles(coordinates, "/workspace");

  assert.deepEqual(listedPaths, ["/workspace"]);
  assert.equal(listing.path, "/workspace");
  assert.equal(typeof listing.refreshedAt, "number");
  assert.deepEqual(
    listing.entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      children: entry.children,
    })),
    [
      { name: ".codex", kind: "folder", children: undefined },
      { name: ".sandpi", kind: "folder", children: undefined },
      { name: "src", kind: "folder", children: undefined },
      { name: ".env", kind: "file", children: undefined },
      { name: "README.md", kind: "file", children: undefined },
    ],
  );
});

test("searches Workspace files through the harness-neutral Sandbox0 runtime", async () => {
  const commands: Array<{
    name: string;
    options: {
      command: string[];
      cwd?: string;
      envVars?: Record<string, string>;
      ttlSec?: number;
    };
  }> = [];
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return {
          async cmd(
            name: string,
            options: {
              command: string[];
              cwd?: string;
              envVars?: Record<string, string>;
              ttlSec?: number;
            },
          ) {
            commands.push({ name, options });
            return {
              exitCode: 0,
              stderr: "",
              stdout: [
                "f",
                "./src/server.ts",
                "d",
                "./src/server",
                "f",
                "./src/my-server-test.ts",
                "f",
                "./src/components.ts",
                "f",
                "./.sandpi/server-secret.json",
                "d",
                "./node_modules/server",
                "l",
                "./server-link",
                "f",
                "/outside/server.ts",
                "f",
                "./src/server.ts",
                "",
              ].join("\0"),
            };
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  assert.deepEqual(await runtime.searchFiles(coordinates, " server "), [
    {
      name: "server",
      path: "/workspace/src/server",
      kind: "folder",
    },
    {
      name: "server.ts",
      path: "/workspace/src/server.ts",
      kind: "file",
    },
    {
      name: "server-secret.json",
      path: "/workspace/.sandpi/server-secret.json",
      kind: "file",
    },
    {
      name: "my-server-test.ts",
      path: "/workspace/src/my-server-test.ts",
      kind: "file",
    },
  ]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "search-workspace-files");
  assert.equal(commands[0]?.options.cwd, "/workspace");
  assert.equal(commands[0]?.options.ttlSec, 10);
  assert.equal(commands[0]?.options.envVars?.LC_ALL, "C");
  assert.equal(commands[0]?.options.command[0], "/bin/sh");
  assert.match(commands[0]?.options.command[2] ?? "", /node_modules/);
  assert.match(commands[0]?.options.command[2] ?? "", /-name '\.git'/);
  assert.doesNotMatch(commands[0]?.options.command[2] ?? "", /-name '\.\*'/);
  assert.equal(commands[0]?.options.command.at(-1), "*s*e*r*v*e*r*");

  assert.deepEqual(await runtime.searchFiles(coordinates, "*?["), []);
  assert.equal(commands[1]?.options.command.at(-1), "*\\**\\?*\\[*");
  assert.deepEqual(await runtime.searchFiles(coordinates, " "), []);
  assert.equal(commands.length, 2);
});

test("opens Sandpi-managed Workspace files as read-only", async () => {
  const managedPath = "/workspace/.sandpi/harnesses/codex/config.toml";
  const content = Buffer.from("model = \"gpt-5\"\n");
  let reads = 0;
  let writes = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return {
          async statFile(filePath: string) {
            if (filePath === managedPath) {
              return {
                type: "file",
                size: content.byteLength,
                modTime: new Date("2026-07-21T00:00:00.000Z"),
                isLink: false,
              };
            }
            return { type: "dir", size: 0, isLink: false };
          },
          async readFile(filePath: string) {
            assert.equal(filePath, managedPath);
            reads += 1;
            return content;
          },
          async writeFile() {
            writes += 1;
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  const file = await runtime.readWorkspaceIdeFile(coordinates, managedPath);

  assert.equal(file.path, managedPath);
  assert.equal(
    Buffer.from(file.content, "base64").toString("utf8"),
    content.toString("utf8"),
  );
  assert.equal(file.editable, false);
  assert.equal(file.readOnlyReason, "sandpi-managed");
  assert.equal(reads, 1);
  await assert.rejects(
    runtime.writeWorkspaceIdeFile(
      coordinates,
      managedPath,
      Buffer.from("model = \"other\"\n"),
      file.revision,
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "workspace_internal_path_protected",
      );
      return true;
    },
  );
  assert.equal(writes, 0);
});

test("writes composer uploads only below the protected Workspace upload root", async () => {
  const uploadPath = "/workspace/.sandpi/uploads/upload-1/requirements.pdf";
  const directories: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const missing = () =>
    new APIError({
      statusCode: 404,
      code: "not_found",
      message: "not found",
    });
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox(sandboxId: string) {
        assert.equal(sandboxId, "sandbox-environment");
        return {
          async mkdir(directory: string) {
            directories.push(directory);
          },
          async statFile(filePath: string) {
            if (filePath === uploadPath) throw missing();
            return { type: "dir", size: 0, isLink: false };
          },
          async writeFile(filePath: string, content: Uint8Array) {
            writes.push({
              path: filePath,
              content: Buffer.from(content).toString("utf8"),
            });
          },
        };
      },
    },
  });
  const coordinates: EnvironmentRuntimeRecord = {
    id: environment.id,
    sandboxId: environment.sandboxId,
    workspaceVolumeId: environment.workspaceVolumeId,
    runtimeGeneration: 1,
    decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 1 },
  };

  await runtime.writeCodexComposerUpload(
    coordinates,
    uploadPath,
    Buffer.from("requirements"),
  );

  assert.deepEqual(directories, ["/workspace/.sandpi/uploads/upload-1"]);
  assert.deepEqual(writes, [{ path: uploadPath, content: "requirements" }]);
  await assert.rejects(
    runtime.writeCodexComposerUpload(
      coordinates,
      "/workspace/.sandpi/harnesses/codex/auth.json",
      Buffer.from("must not write"),
    ),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "invalid_codex_file_upload_path",
      );
      return true;
    },
  );
  assert.equal(writes.length, 1);
});
