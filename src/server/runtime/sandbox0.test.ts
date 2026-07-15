import assert from "node:assert/strict";
import test from "node:test";

import { APIError } from "sandbox0";

import { HttpError } from "@/server/http-error";
import { Sandbox0Runtime } from "./sandbox0";
import type {
  RuntimeForkSessionInput,
  RuntimeProvisionSessionInput,
  RuntimeSessionRecord,
} from "./types";

const runtimeRecord: RuntimeSessionRecord = {
  id: "session-test",
  sandboxId: "sandbox-test",
  workspaceVolumeId: "volume-test",
  supervisorSessionId: "missing-supervisor",
  supervisorCursor: 0,
  harnessStateLayout: "workspace_v2",
};

const environment = {
  id: "environment-test",
  teamId: "team-test",
  name: "Test",
  description: "",
  color: "blue",
  status: "ready",
  revision: 1,
  templateId: "coding-agent",
  rootfsSnapshotId: "",
  workspaceVolumeId: "environment-volume",
  credentialRevision: 1,
  codingAgent: { harness: "codex", label: "Codex", status: "connected" },
  networkPolicy: {
    mode: "allow-all",
    allowedDomains: [],
    logDeniedRequests: false,
  },
  functions: [],
} satisfies RuntimeProvisionSessionInput["environment"];

test("finds the newest exact-name Volume checkpoint", async () => {
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      volumes: {
        async listSnapshots(volumeId: string) {
          assert.equal(volumeId, runtimeRecord.workspaceVolumeId);
          return [
            {
              id: "snapshot-other",
              name: "migration-baseline-other",
              createdAt: "2026-07-15T00:03:00.000Z",
            },
            {
              id: "snapshot-old",
              name: "migration-baseline",
              createdAt: "2026-07-15T00:01:00.000Z",
            },
            {
              id: "snapshot-new",
              name: "migration-baseline",
              createdAt: "2026-07-15T00:02:00.000Z",
            },
          ];
        },
      },
    },
  });

  assert.deepEqual(
    await runtime.findVolumeCheckpoint(runtimeRecord, "migration-baseline"),
    { snapshotId: "snapshot-new" },
  );
  assert.equal(
    await runtime.findVolumeCheckpoint(runtimeRecord, "missing-baseline"),
    undefined,
  );
});

test("deduplicates staged Codex delivery within one Supervisor attempt", async () => {
  const writes: Array<{
    inputId: string;
    expectedAttemptId?: string;
    dataBase64?: string;
  }> = [];
  const frame = Buffer.from('{"id":"turn-start:test"}\n', "utf8");
  const sandbox = {
    async readFile() {
      return frame;
    },
    async getSession(sessionId: string) {
      assert.equal(sessionId, runtimeRecord.supervisorSessionId);
      return { id: sessionId, attempt: { id: "attempt-one" } };
    },
    async writeSessionInput(
      sessionId: string,
      input: {
        inputId: string;
        expectedAttemptId?: string;
        dataBase64?: string;
      },
    ) {
      assert.equal(sessionId, runtimeRecord.supervisorSessionId);
      writes.push(input);
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: { sandboxes: { sandbox: () => sandbox } },
  });
  const logicalInputId = `turn-input:${"unsafe/id".repeat(100)}`;

  await runtime.dispatchStagedCodexMessage(runtimeRecord, logicalInputId);
  await runtime.dispatchStagedCodexMessage(runtimeRecord, logicalInputId);

  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.inputId, writes[1]?.inputId);
  assert.match(writes[0]?.inputId ?? "", /^sandpi-input-[a-f0-9]{64}$/);
  assert.equal(writes[0]?.inputId.length, 77);
  assert.equal(writes[0]?.expectedAttemptId, "attempt-one");
  assert.equal(writes[0]?.dataBase64, frame.toString("base64"));
});

test("replays one logical Codex delivery with a new attempt-scoped input id", async () => {
  const writes: Array<{ inputId: string; expectedAttemptId?: string }> = [];
  let attemptId = "attempt-one";
  const sandbox = {
    async readFile() {
      return Buffer.from('{"id":"turn-start:test"}\n', "utf8");
    },
    async getSession() {
      return { id: runtimeRecord.supervisorSessionId, attempt: { id: attemptId } };
    },
    async writeSessionInput(
      _sessionId: string,
      input: { inputId: string; expectedAttemptId?: string },
    ) {
      writes.push(input);
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: { sandboxes: { sandbox: () => sandbox } },
  });
  const logicalInputId = "turn-input:logical-delivery";

  await runtime.dispatchStagedCodexMessage(runtimeRecord, logicalInputId);
  attemptId = "attempt-two";
  await runtime.dispatchStagedCodexMessage(runtimeRecord, logicalInputId);

  assert.equal(writes.length, 2);
  assert.notEqual(writes[0]?.inputId, writes[1]?.inputId);
  assert.deepEqual(
    writes.map(({ expectedAttemptId }) => expectedAttemptId),
    ["attempt-one", "attempt-two"],
  );
});

test("lists workspace files without coupling file access to the Supervisor", async () => {
  const listedDirectories: string[] = [];
  const sandbox = {
    listFiles: async (directory: string) => {
      listedDirectories.push(directory);
      if (directory === "/workspace") {
        return [
          { name: ".sandpi", path: "/workspace/.sandpi", type: "dir" },
          { name: ".git", path: "/workspace/.git", type: "dir" },
          { name: ".next", path: "/workspace/.next", type: "dir" },
          { name: ".npm", path: "/workspace/.npm", type: "dir" },
          {
            name: "node_modules",
            path: "/workspace/node_modules",
            type: "dir",
          },
          { name: "src", path: "/workspace/src", type: "dir" },
          { name: "README.md", path: "/workspace/README.md", type: "file" },
        ];
      }
      if (directory === "/workspace/src") {
        return [
          {
            name: "index.ts",
            path: "/workspace/src/index.ts",
            type: "file",
          },
        ];
      }
      throw new Error(`Unexpected directory: ${directory}`);
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: {
        sandbox: (sandboxId: string) => {
          assert.equal(sandboxId, runtimeRecord.sandboxId);
          return sandbox;
        },
      },
    },
  });

  const files = await runtime.listFiles(runtimeRecord, "/workspace");

  assert.deepEqual(listedDirectories, ["/workspace", "/workspace/src"]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "/workspace");
  assert.deepEqual(
    files[0]?.children?.map(({ name, kind }) => ({ name, kind })),
    [
      { name: "src", kind: "folder" },
      { name: "README.md", kind: "file" },
    ],
  );
  assert.deepEqual(
    files[0]?.children?.[0]?.children?.map(({ name, kind, path }) => ({
      name,
      kind,
      path,
    })),
    [
      {
        name: "index.ts",
        kind: "file",
        path: "/workspace/src/index.ts",
      },
    ],
  );
});

test("rejects direct access to Sandpi-owned Workspace state", async () => {
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: {
        sandbox: () => assert.fail("protected paths must fail before SDK I/O"),
      },
    },
  });
  const protectedPath = "/workspace/.sandpi/harnesses/codex/state_5.sqlite";
  const isProtected = (error: unknown) =>
    error instanceof HttpError &&
    error.statusCode === 403 &&
    error.code === "workspace_internal_path_protected";

  await assert.rejects(runtime.listFiles(runtimeRecord, protectedPath), isProtected);
  await assert.rejects(runtime.readFile(runtimeRecord, protectedPath), isProtected);
  await assert.rejects(
    runtime.readWorkspaceIdeFile(runtimeRecord, protectedPath),
    isProtected,
  );
  await assert.rejects(
    runtime.writeWorkspaceIdeFile(
      runtimeRecord,
      protectedPath,
      Buffer.from("no"),
      "revision",
    ),
    isProtected,
  );
});

test("returns a stable 404 when a Workspace preview file no longer exists", async () => {
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: {
        sandbox: () => ({
          async statFile() {
            throw new APIError({
              statusCode: 404,
              code: "file_not_found",
              message: "file not found",
            });
          },
        }),
      },
    },
  });

  await assert.rejects(
    runtime.readFile(runtimeRecord, "/workspace/removed.txt"),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 404 &&
      error.code === "workspace_file_not_found",
  );
});

test("rejects symlink aliases before listing or reading their targets", async () => {
  let listCalls = 0;
  let readCalls = 0;
  const sandbox = {
    async statFile(filePath: string) {
      assert.equal(filePath, "/workspace/leak");
      return { path: filePath, type: "symlink", isLink: true };
    },
    async listFiles() {
      listCalls += 1;
      return [];
    },
    async readFile() {
      readCalls += 1;
      return new Uint8Array();
    },
    async cmd() {
      assert.fail("IDE Git inspection must not run through a symlink alias");
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: { sandboxes: { sandbox: () => sandbox } },
  });
  const isSymlinkRejection = (error: unknown) =>
    error instanceof HttpError && error.code === "workspace_symlink_not_editable";

  await assert.rejects(runtime.listFiles(runtimeRecord, "/workspace/leak"), isSymlinkRejection);
  await assert.rejects(runtime.readFile(runtimeRecord, "/workspace/leak"), isSymlinkRejection);
  await assert.rejects(
    runtime.readWorkspaceIdeFile(runtimeRecord, "/workspace/leak"),
    isSymlinkRejection,
  );
  assert.equal(listCalls, 0);
  assert.equal(readCalls, 0);
});

test("silently drops internal file-watch events while preserving Git invalidation", async () => {
  let closed = false;
  const watcher = {
    async *events() {
      yield {
        type: "event",
        event: "write",
        path: "/workspace/.sandpi/harnesses/codex/state_5.sqlite-wal",
      };
      yield { type: "event", event: "write", path: "/workspace/.git/index" };
      yield { type: "event", event: "write", path: "/workspace/src/index.ts" };
    },
    close() {
      closed = true;
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: { sandbox: () => ({ watchFiles: async () => watcher }) },
    },
  });

  const handle = await runtime.watchWorkspaceFiles(runtimeRecord);
  const messages = [];
  for await (const message of handle.messages) messages.push(message);
  handle.close();

  assert.deepEqual(messages, [
    { event: "git:write", path: "/workspace" },
    { event: "write", path: "/workspace/src/index.ts" },
  ]);
  assert.equal(closed, true);
});

test("prunes and filters Sandpi-owned state from Git discovery", async () => {
  let findCommand: string[] = [];
  const sandbox = {
    async cmd(name: string, options: { command: string[] }) {
      if (name === "find-git-repositories") {
        findCommand = options.command;
        return {
          exitCode: 0,
          stdout: "/workspace/.git\0/workspace/.sandpi/hidden/.git\0",
        };
      }
      assert.equal(name, "git");
      assert.equal(options.command[2], "/workspace");
      return {
        exitCode: 0,
        stdout:
          "# branch.head main\0? .sandpi/harnesses/codex/state_5.sqlite\0? src/index.ts\0",
      };
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: { sandboxes: { sandbox: () => sandbox } },
  });

  const state = await runtime.getWorkspaceGitState(runtimeRecord);

  assert.ok(findCommand.includes("/workspace/.sandpi"));
  assert.equal(state.repositories.length, 1);
  assert.deepEqual(
    state.repositories[0]?.files.map((file) => file.path),
    ["/workspace/src/index.ts"],
  );
});

test("fresh provisioning clears the reserved home and returns workspace_v2", async () => {
  let prepareCommand = "";
  const supervisor = {
    id: "supervisor-v2",
    attempt: { id: "attempt-v2" },
    runtimeGeneration: 1,
  };
  const claimedSandbox = {
    id: "sandbox-v2",
    async mkdir() {},
    async writeFile() {},
    async cmd(name: string, options: { command?: string[] }) {
      if (name === "prepare-codex-home-fresh") {
        prepareCommand = options.command?.at(-1) ?? "";
      }
      return { exitCode: 0 };
    },
    async createSession(
      spec: { env?: Record<string, string> },
      options: { idempotencyKey?: string },
    ) {
      assert.equal(spec.env?.CODEX_HOME, "/workspace/.sandpi/harnesses/codex");
      assert.equal(
        options.idempotencyKey,
        "sandpi-codex-workspace-v2-session-fresh",
      );
      return supervisor;
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      volumes: {
        async fork(volumeId: string) {
          assert.equal(volumeId, environment.workspaceVolumeId);
          return { id: "session-volume" };
        },
      },
      sandboxes: {
        async claim(templateId: string) {
          assert.equal(templateId, environment.templateId);
          return claimedSandbox;
        },
        async waitForLifecycle() {},
      },
    },
  });

  const provisioned = await runtime.provisionSession({
    sessionId: "session-fresh",
    environment,
    codexAuthJson: "{}",
  });

  assert.equal(provisioned.harnessStateLayout, "workspace_v2");
  assert.equal(provisioned.workspaceVolumeId, "session-volume");
  assert.match(prepareCommand, /rm -rf "\$home" "\$stage"/);
  assert.match(prepareCommand, /\.sandpi-layout-workspace-v2/);
});

test("waits for a live Supervisor attempt after restoring a Volume checkpoint", async () => {
  let sessionReads = 0;
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      volumes: {
        async restoreSnapshot(volumeId: string, snapshotId: string) {
          assert.equal(volumeId, runtimeRecord.workspaceVolumeId);
          assert.equal(snapshotId, "snapshot-input");
        },
      },
      sandboxes: {
        async get(sandboxId: string) {
          assert.equal(sandboxId, runtimeRecord.sandboxId);
          return { paused: true };
        },
        async resumeAndWait(sandboxId: string) {
          assert.equal(sandboxId, runtimeRecord.sandboxId);
        },
        sandbox(sandboxId: string) {
          assert.equal(sandboxId, runtimeRecord.sandboxId);
          return {
            async getSession(supervisorSessionId: string) {
              assert.equal(supervisorSessionId, runtimeRecord.supervisorSessionId);
              sessionReads += 1;
              return {
                id: supervisorSessionId,
                runtimeGeneration: 2,
                attempt:
                  sessionReads === 1
                    ? {
                        id: "attempt-finished",
                        finishedAt: new Date(),
                      }
                    : { id: "attempt-live" },
              };
            },
          };
        },
      },
    },
  });

  const recovered = await runtime.restoreVolumeCheckpoint(
    { ...runtimeRecord, attemptId: "attempt-original" },
    "snapshot-input",
  );

  assert.deepEqual(recovered, {
    attemptId: "attempt-live",
    runtimeGeneration: 2,
  });
  assert.equal(sessionReads, 2);
});

test("a legacy Session fork forcibly replaces any Volume home from rootfs", async () => {
  const operations: string[] = [];
  let copyCommand = "";
  const supervisor = {
    id: "supervisor-child-v2",
    attempt: { id: "attempt-child-v2" },
    runtimeGeneration: 1,
  };
  const childSandbox = {
    id: "sandbox-child",
    async mkdir() {},
    async writeFile() {},
    async cmd(name: string, options: { command?: string[] }) {
      if (name === "prepare-codex-home-copy_legacy_fork") {
        copyCommand = options.command?.at(-1) ?? "";
      }
      return { exitCode: 0 };
    },
    async createSession() {
      return supervisor;
    },
  };
  const source: RuntimeSessionRecord = {
    ...runtimeRecord,
    id: "session-source",
    sandboxId: "sandbox-source",
    workspaceVolumeId: "volume-source",
    supervisorSessionId: "supervisor-source",
    harnessStateLayout: "rootfs_v1",
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      volumes: {
        async fork(volumeId: string) {
          assert.equal(volumeId, source.workspaceVolumeId);
          return { id: "volume-child" };
        },
      },
      sandboxes: {
        async get() {
          return { paused: true };
        },
        async createRootFSSnapshot() {
          operations.push("snapshot-rootfs");
          return { id: "rootfs-snapshot" };
        },
        async resumeAndWait() {
          operations.push("resume-source");
        },
        async claim(_templateId: string, options: { snapshotId?: string }) {
          assert.equal(options.snapshotId, "rootfs-snapshot");
          return childSandbox;
        },
        async waitForLifecycle() {},
        async deleteRootFSSnapshot(snapshotId: string) {
          assert.equal(snapshotId, "rootfs-snapshot");
          operations.push("delete-rootfs-snapshot");
        },
      },
    },
  });
  const input: RuntimeForkSessionInput = {
    sessionId: "session-child",
    environment,
    codexAuthJson: "{}",
    source,
  };

  const provisioned = await runtime.forkSession(input);

  assert.equal(provisioned.harnessStateLayout, "workspace_v2");
  assert.match(copyCommand, /test -d "\$legacy"/);
  assert.match(copyCommand, /rm -rf "\$home" "\$stage"/);
  assert.doesNotMatch(copyCommand, /if \[ ! -d "\$home" \]/);
  assert.deepEqual(operations, [
    "snapshot-rootfs",
    "resume-source",
    "delete-rootfs-snapshot",
  ]);
});

test("remounts a disconnected Workspace and replaces a missing Supervisor", async () => {
  const operations: string[] = [];
  let workspaceChecks = 0;
  const replacement = {
    id: "supervisor-replacement",
    runtimeGeneration: 2,
    attempt: { id: "attempt-replacement" },
    spec: { env: { CODEX_HOME: "/workspace/.sandpi/harnesses/codex" } },
  };
  const sandbox = {
    async listFiles(directory: string) {
      assert.equal(directory, "/workspace");
      operations.push("workspace");
      workspaceChecks += 1;
      if (workspaceChecks === 1) {
        throw new APIError({
          statusCode: 500,
          code: "operation_failed",
          message: "open /workspace: transport endpoint is not connected",
        });
      }
      return [];
    },
    async mkdir() {
      operations.push("mkdir");
    },
    async writeFile() {
      operations.push("credential");
    },
    async cmd(command: string) {
      operations.push(
        command === "prepare-codex-home-preserve" ? "prepare-home" : "chmod",
      );
      return { exitCode: 0 };
    },
    async getSession(sessionId: string) {
      assert.equal(sessionId, runtimeRecord.supervisorSessionId);
      throw new APIError({
        statusCode: 404,
        code: "not_found",
        message: "session not found",
      });
    },
    async createSession(
      spec: { command?: string[] },
      options: { idempotencyKey?: string },
    ) {
      assert.equal(
        options.idempotencyKey,
        `sandpi-codex-workspace-v2-${runtimeRecord.id}`,
      );
      const command = spec.command?.join(" ") ?? "";
      assert.doesNotMatch(command, /> .*config\.toml/);
      assert.match(command, /\/workspace\/\.sandpi\/harnesses\/codex/);
      assert.match(command, /app-server --stdio -c 'cli_auth_credentials_store="file"'/);
      operations.push("create-supervisor");
      return replacement;
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: {
        async get() {
          return { status: "running", paused: false };
        },
        async pauseAndWait() {
          operations.push("pause");
          return { status: "paused", paused: true };
        },
        async resumeAndWait() {
          operations.push("resume");
          return { status: "running", paused: false };
        },
        sandbox: () => sandbox,
      },
    },
  });

  const recovered = await runtime.recoverCodexRuntime(runtimeRecord, "{}");

  assert.deepEqual(recovered, {
    supervisorSessionId: replacement.id,
    attemptId: replacement.attempt.id,
    runtimeGeneration: replacement.runtimeGeneration,
    sandboxRestarted: true,
  });
  assert.deepEqual(operations, [
    "workspace",
    "pause",
    "resume",
    "workspace",
    "mkdir",
    "credential",
    "chmod",
    "prepare-home",
    "create-supervisor",
  ]);
});

test("remounts a disconnected Supervisor portal before creating a replacement", async () => {
  const operations: string[] = [];
  let supervisorReads = 0;
  const original = {
    id: runtimeRecord.supervisorSessionId,
    runtimeGeneration: 2,
    attempt: { id: "attempt-recovered" },
    spec: { env: { CODEX_HOME: "/workspace/.sandpi/harnesses/codex" } },
  };
  const sandbox = {
    async listFiles() {
      operations.push("workspace");
      return [];
    },
    async getSession() {
      supervisorReads += 1;
      if (supervisorReads === 1) {
        throw new APIError({
          statusCode: 500,
          code: "operation_failed",
          message: "open /var/lib/sandbox0/procd: transport endpoint is not connected",
        });
      }
      operations.push("original-supervisor");
      return original;
    },
    async mkdir() {
      operations.push("mkdir");
    },
    async writeFile() {
      operations.push("credential");
    },
    async cmd(command: string) {
      operations.push(
        command === "prepare-codex-home-preserve" ? "prepare-home" : "chmod",
      );
      return { exitCode: 0 };
    },
    async createSession() {
      assert.fail("the recovered original Supervisor must be reused");
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: {
        async get() {
          return { status: "running", paused: false };
        },
        async pauseAndWait() {
          operations.push("pause");
          return { status: "paused", paused: true };
        },
        async resumeAndWait() {
          operations.push("resume");
          return { status: "running", paused: false };
        },
        sandbox: () => sandbox,
      },
    },
  });

  const recovered = await runtime.recoverCodexRuntime(runtimeRecord, "{}");

  assert.equal(recovered.supervisorSessionId, original.id);
  assert.equal(recovered.attemptId, original.attempt.id);
  assert.equal(recovered.sandboxRestarted, true);
  assert.deepEqual(operations, [
    "workspace",
    "pause",
    "resume",
    "workspace",
    "original-supervisor",
    "mkdir",
    "credential",
    "chmod",
    "prepare-home",
  ]);
});

test("atomically migrates legacy native state and starts a distinct v2 Supervisor", async () => {
  const operations: string[] = [];
  let migrationCommand = "";
  const legacyRuntime: RuntimeSessionRecord = {
    ...runtimeRecord,
    supervisorSessionId: "supervisor-rootfs-v1",
    harnessStateLayout: "rootfs_v1",
  };
  const legacySupervisor = {
    id: legacyRuntime.supervisorSessionId,
    spec: { env: { CODEX_HOME: "/var/lib/sandpi/codex" } },
    runtimeGeneration: 1,
    attempt: { id: "attempt-v1" },
  };
  const migratedSupervisor = {
    id: "supervisor-workspace-v2",
    spec: { env: { CODEX_HOME: "/workspace/.sandpi/harnesses/codex" } },
    runtimeGeneration: 2,
    attempt: { id: "attempt-v2" },
  };
  const sandbox = {
    async getSession(sessionId: string) {
      assert.equal(sessionId, legacySupervisor.id);
      return legacySupervisor;
    },
    async setSessionDesiredState(sessionId: string, state: string) {
      assert.equal(sessionId, legacySupervisor.id);
      assert.equal(state, "stopped");
      operations.push("stop-v1");
      return {
        ...legacySupervisor,
        attempt: { ...legacySupervisor.attempt, finishedAt: new Date() },
      };
    },
    async mkdir() {
      operations.push("mkdir-credential");
    },
    async writeFile() {
      operations.push("write-credential");
    },
    async cmd(name: string, options: { command?: string[] }) {
      if (name === "prepare-codex-home-migrate_legacy") {
        migrationCommand = options.command?.at(-1) ?? "";
        operations.push("migrate-home");
      } else {
        operations.push("chmod-credential");
      }
      return { exitCode: 0 };
    },
    async createSession(
      spec: { name?: string; env?: Record<string, string>; command: string[] },
      options: { idempotencyKey?: string },
    ) {
      assert.equal(spec.name, "codex-workspace-v2");
      assert.equal(spec.env?.CODEX_HOME, "/workspace/.sandpi/harnesses/codex");
      assert.equal(
        options.idempotencyKey,
        `sandpi-codex-workspace-v2-${runtimeRecord.id}`,
      );
      operations.push("create-v2");
      return migratedSupervisor;
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: {
        async get() {
          return { status: "running", paused: false };
        },
        sandbox: () => sandbox,
      },
    },
  });

  const migrated = await runtime.migrateCodexNativeState(legacyRuntime, "{}");

  assert.deepEqual(migrated, {
    supervisorSessionId: migratedSupervisor.id,
    attemptId: migratedSupervisor.attempt.id,
    runtimeGeneration: migratedSupervisor.runtimeGeneration,
    sandboxRestarted: false,
    harnessStateLayout: "workspace_v2",
    sourceHadRollout: false,
  });
  assert.deepEqual(operations, [
    "stop-v1",
    "mkdir-credential",
    "write-credential",
    "chmod-credential",
    "migrate-home",
    "create-v2",
  ]);
  assert.match(migrationCommand, /tar --exclude='\.\/auth\.json'/);
  assert.match(migrationCommand, /\.sandpi-layout-workspace-v2/);
  assert.match(migrationCommand, /mv "\$stage" "\$home"/);
  assert.match(migrationCommand, /ln -s \/dev\/shm\/sandpi-codex-auth\.json/);
});

test("retries a migrating v2 runtime without stopping or replacing its Supervisor", async () => {
  const operations: string[] = [];
  const v2Supervisor = {
    id: "supervisor-workspace-v2",
    spec: { env: { CODEX_HOME: "/workspace/.sandpi/harnesses/codex" } },
    runtimeGeneration: 3,
    attempt: { id: "attempt-v2" },
  };
  const migratingRuntime: RuntimeSessionRecord = {
    ...runtimeRecord,
    supervisorSessionId: v2Supervisor.id,
    harnessStateLayout: "migrating",
  };
  const sandbox = {
    async getSession() {
      return v2Supervisor;
    },
    async setSessionDesiredState() {
      assert.fail("an already-v2 Supervisor must not be stopped on retry");
    },
    async mkdir() {},
    async writeFile() {},
    async cmd(name: string) {
      operations.push(name);
      return { exitCode: 0 };
    },
    async createSession() {
      assert.fail("the persisted v2 Supervisor must be reused");
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: {
      sandboxes: {
        async get() {
          return { status: "running", paused: false };
        },
        sandbox: () => sandbox,
      },
    },
  });

  const migrated = await runtime.migrateCodexNativeState(migratingRuntime, "{}");

  assert.equal(migrated.supervisorSessionId, v2Supervisor.id);
  assert.deepEqual(operations, [
    "chmod 600 /dev/shm/sandpi-codex-auth.json",
    "prepare-codex-home-migrate_legacy",
  ]);
});

test("cleans legacy state by listing Supervisor homes after the v2 commit", async () => {
  const deleted: string[] = [];
  const stopped: string[] = [];
  const legacy = {
    id: "legacy-supervisor",
    spec: { name: "codex", env: { CODEX_HOME: "/var/lib/sandpi/codex" } },
  };
  const legacyWithoutHome = {
    id: "legacy-supervisor-without-home",
    spec: { name: "codex" },
  };
  const current = {
    id: "workspace-supervisor",
    spec: {
      name: "codex-workspace-v2",
      env: { CODEX_HOME: "/workspace/.sandpi/harnesses/codex" },
    },
  };
  const sandbox = {
    async listSessions() {
      return [legacy, legacyWithoutHome, current];
    },
    async setSessionDesiredState(sessionId: string) {
      stopped.push(sessionId);
      return { ...legacy, attempt: undefined };
    },
    async deleteSession(sessionId: string) {
      deleted.push(sessionId);
    },
    async cmd(name: string, options: { command: string[] }) {
      assert.equal(name, "cleanup-legacy-codex-home");
      assert.match(options.command.join(" "), /rm -rf \/var\/lib\/sandpi\/codex/);
      return { exitCode: 0 };
    },
  };
  const runtime = new Sandbox0Runtime({
    apiHost: "http://sandbox0.invalid",
    apiKey: "test-api-key",
  });
  Object.defineProperty(runtime, "client", {
    value: { sandboxes: { sandbox: () => sandbox } },
  });

  await runtime.cleanupLegacyCodexNativeState(runtimeRecord);

  assert.deepEqual(stopped, [legacy.id, legacyWithoutHome.id]);
  assert.deepEqual(deleted, [legacy.id, legacyWithoutHome.id]);
});
