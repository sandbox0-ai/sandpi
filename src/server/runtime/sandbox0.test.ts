import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { APIError } from "sandbox0";

import type { Environment } from "@/lib/types";
import { createSandbox0FetchWithRetry, Sandbox0Runtime } from "./sandbox0";
import type { EnvironmentRuntimeRecord } from "./types";

const environment: Environment = {
  id: "environment-test",
  teamId: "team-test",
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
    mode: "restricted",
    allowedDomains: ["github.com"],
    logDeniedRequests: true,
  },
  functions: [],
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
  const hardExpiresAt = new Date("2026-08-15T00:00:00.000Z");
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
        return { status: "running", hardExpiresAt };
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
    hardExpiresAt,
  });
  assert.equal(volumeCreates, 0);
  assert.deepEqual(
    (claimInput?.mounts as Array<Record<string, unknown>>)[0],
    {
      sandboxvolumeId: "volume-environment",
      mountPoint: "/workspace",
    },
  );
  assert.equal(
    ((claimInput?.config ?? {}) as Record<string, unknown>).hardTtl,
    30 * 24 * 60 * 60,
  );
  assert.equal(
    ((claimInput?.config ?? {}) as Record<string, unknown>).ttl,
    0,
  );
  assert.equal(
    ((claimInput?.config ?? {}) as Record<string, unknown>).autoResume,
    true,
  );
  assert.deepEqual(allocations, [
    {
      sandboxId: "sandbox-environment",
      workspaceVolumeId: "volume-environment",
    },
  ]);
});

test("creates one Workspace Volume when provisioning a new Environment", async () => {
  const hardExpiresAt = new Date("2026-08-15T00:00:00.000Z");
  const allocations: Array<Record<string, string>> = [];
  const runtime = runtimeWithClient({
    volumes: {
      async create() {
        return { id: "volume-new" };
      },
    },
    sandboxes: {
      async claim(_templateId: string, input: { mounts: Array<{ sandboxvolumeId: string }> }) {
        assert.equal(input.mounts[0]?.sandboxvolumeId, "volume-new");
        return { id: "sandbox-new" };
      },
      async waitForLifecycle() {
        return { status: "running", hardExpiresAt };
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
    hardExpiresAt,
  });
  assert.deepEqual(allocations, [
    { workspaceVolumeId: "volume-new" },
    { sandboxId: "sandbox-new", workspaceVolumeId: "volume-new" },
  ]);
});

test("applies the Environment policy and executes Sandpi-owned pause", async () => {
  const hardExpiresAt = new Date("2026-08-15T00:00:00.000Z");
  const updates: unknown[] = [];
  let paused = false;
  const runtime = runtimeWithClient({
    sandboxes: {
      async update(sandboxId: string, request: unknown) {
        assert.equal(sandboxId, "sandbox-environment");
        updates.push(request);
        return { hardExpiresAt };
      },
      async get() {
        return paused
          ? { status: "paused", paused: true, hardExpiresAt }
          : { status: "running", paused: false, hardExpiresAt };
      },
      async pauseAndWait() {
        paused = true;
        return { status: "paused", paused: true, hardExpiresAt };
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

  assert.deepEqual(
    await runtime.configureEnvironmentLifecycle(coordinates, 900),
    { hardExpiresAt },
  );
  assert.deepEqual(updates, [
    { config: { ttl: 0, hardTtl: 900, autoResume: true } },
  ]);
  await runtime.pauseEnvironment(coordinates);
  assert.equal(paused, true);
});

test("uses Sandbox0 runtime access to auto-resume a paused Environment", async () => {
  let paused = true;
  let runtimeGeneration = 1;
  let workspaceAccesses = 0;
  let lifecycleWaits = 0;
  let explicitResumes = 0;
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
    async mkdir() {},
    async writeFile() {},
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

  assert.equal(workspaceAccesses, 2);
  assert.equal(lifecycleWaits, 1);
  assert.equal(explicitResumes, 0);
  assert.equal(recovered.runtimeGeneration, 2);
  assert.equal(recovered.sandboxRestarted, true);
});

test("starts one Environment-scoped Codex app-server with native state on the Volume", async () => {
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
        return { status: "running", paused: false };
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
  assert.deepEqual(writes, [
    {
      path: "/dev/shm/sandpi-codex-auth.json",
      content: '{"tokens":{"access_token":"test"}}',
    },
  ]);
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
  assert.ok(
    commands.some(
      (command) =>
        command.name === "prepare-environment-codex-home" &&
        command.command?.at(-1)?.includes("environment_v1"),
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
            return { attempt: { id: "attempt-retry" } };
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

test("reports exhausted Sandbox0 transport failures as retryable unavailability", async () => {
  let sessionReads = 0;
  let inputWrites = 0;
  const runtime = runtimeWithClient({
    sandboxes: {
      sandbox() {
        return {
          async getSession() {
            sessionReads += 1;
            return { attempt: { id: "attempt-unavailable" } };
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
      assert.match(
        (error as Error).message,
        /temporarily unreachable/i,
      );
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
      message: /required team role and permissions/,
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
      assert.equal((error as { code?: string }).code, "codex_rollout_path_invalid");
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
      assert.equal((error as { code?: string }).code, "codex_rollout_path_symlink");
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

  assert.equal(
    Buffer.from(content).toString("utf8"),
    "compressed rollout\n",
  );
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
      assert.equal((error as { code?: string }).code, "codex_rollout_too_large");
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
      { name: "src", kind: "folder", children: undefined },
      { name: ".env", kind: "file", children: undefined },
      { name: "README.md", kind: "file", children: undefined },
    ],
  );
});
