import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import { Sandbox0Runtime } from "./sandbox0";
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
  assert.deepEqual(
    (claimInput?.mounts as Array<Record<string, unknown>>)[0],
    {
      sandboxvolumeId: "volume-environment",
      mountPoint: "/workspace",
    },
  );
  assert.equal(
    "hardTtl" in ((claimInput?.config ?? {}) as Record<string, unknown>),
    false,
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
      async claim(_templateId: string, input: { mounts: Array<{ sandboxvolumeId: string }> }) {
        assert.equal(input.mounts[0]?.sandboxvolumeId, "volume-new");
        return { id: "sandbox-new" };
      },
      async waitForLifecycle() {},
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
