import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore, StoredRuntime } from "@/server/store";
import {
  CodexService,
  type CodexCredentialProvider,
} from "./service";

const logger = {
  debug() {},
  warn() {},
  error() {},
};

const runtimeRecord = {
  id: "session-test",
  sandboxId: "sandbox-test",
  workspaceVolumeId: "volume-test",
  supervisorSessionId: "supervisor-test",
  supervisorCursor: 0,
  attemptId: "attempt-test",
  runtimeGeneration: 1,
  threadId: "thread-test",
  decoder: {
    supervisorCursor: 0,
    tailBase64: "",
    attemptId: "attempt-test",
    runtimeGeneration: 1,
  },
} satisfies StoredRuntime;

const credentials = {
  async credentialForEnvironment() {
    return { sourceId: "credential-test", revision: 1, authJson: "{}" };
  },
  async credentialForRuntime() {
    return { sourceId: "credential-test", revision: 1, authJson: "{}" };
  },
  async markCredentialMaterialized() {},
  async syncCredentialFromRuntime() {
    return undefined;
  },
} satisfies CodexCredentialProvider;

test("cleans provisioned Sandbox and Volume when native initialization fails", async () => {
  let deleted = false;
  let failedWithClearedRuntime = false;
  const store = {
    async createSessionMetadata() {
      return runtimeRecord.id;
    },
    async markSessionProvisioned() {},
    async decoderState() {
      return runtimeRecord;
    },
    async getRpcResponse() {
      return { error: { message: "initialize failed" } };
    },
    async allocatedSessionResources() {
      return runtimeRecord;
    },
    async markSessionFailed(_sessionId: string, _error: string, clear: boolean) {
      failedWithClearedRuntime = clear;
    },
  } as unknown as SandpiStore;
  const runtime = {
    async provisionSession() {
      return runtimeRecord;
    },
    async writeCodexMessage() {},
    async deleteSessionResources() {
      deleted = true;
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  await assert.rejects(
    service.createSession({
      userId: "user-test",
      environment: {
        id: "env-test",
        workspaceVolumeId: "environment-volume",
      } as Environment,
      title: "Failure test",
      prompt: "Run the test",
      images: [],
    }),
  );
  assert.equal(deleted, true);
  assert.equal(failedWithClearedRuntime, true);
});

test("hard-TTL reaper removes runtime resources before clearing metadata", async () => {
  const operations: string[] = [];
  const store = {
    async expiredRuntimeSessions() {
      return [runtimeRecord];
    },
    async markSessionExpired(sessionId: string) {
      operations.push(`mark:${sessionId}`);
    },
    async failedRuntimeSessions() {
      return [];
    },
  } as unknown as SandpiStore;
  const runtime = {
    async deleteSessionResources() {
      operations.push("delete");
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  await service.reapExpiredSessions();
  assert.deepEqual(operations, ["delete", `mark:${runtimeRecord.id}`]);
});

test("starts the API recovery workers when one Sandbox is temporarily unreachable", async () => {
  const warnings: Array<{ fields: object; message: string }> = [];
  const store = {
    async expiredRuntimeSessions() {
      return [];
    },
    async failedRuntimeSessions() {
      return [];
    },
    async recoverStaleTurnCheckpointClaims() {},
    async interruptedTurnMutations() {
      return [];
    },
    async activeRuntimeSessionIds() {
      return [runtimeRecord.id];
    },
    async reconcileSessionStatus() {},
    async decoderState() {
      return runtimeRecord;
    },
    async retryableTurnCheckpoints() {
      return [];
    },
  } as unknown as SandpiStore;
  const runtime = {
    async readCodexSessionCredential() {
      throw new Error("Sandbox0 unavailable");
    },
    async installCodexSessionCredential() {
      throw new Error("Sandbox0 unavailable");
    },
    async listCodexEvents() {
      return { events: [], cursor: { earliest: 0, latest: 0 } };
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(
    store,
    runtime,
    {
      ...logger,
      warn(fields, message) {
        warnings.push({ fields, message });
      },
    },
    credentials,
  );

  await service.resumeWorkers();
  await service.close();

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "Codex runtime recovery deferred");
  assert.match(JSON.stringify(warnings[0]?.fields), /Sandbox0 unavailable/);
});

test("reserves a Session before materializing credentials for a new Turn", async () => {
  const operations: string[] = [];
  const store = {
    async beginSessionTurn() {
      operations.push("reserve");
    },
    async getRuntime() {
      operations.push("runtime");
      return runtimeRecord;
    },
    async releaseSessionTurn() {
      operations.push("release");
    },
  } as unknown as SandpiStore;
  const runtime = {
    async installCodexSessionCredential() {
      operations.push("install");
      throw new Error("credential install failed");
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, {
    ...credentials,
    async credentialForRuntime() {
      operations.push("credential");
      return credentials.credentialForRuntime();
    },
  });

  await assert.rejects(
    service.startTurn({
      userId: "user-test",
      sessionId: runtimeRecord.id,
      text: "hello",
      images: [],
    }),
    /credential install failed/,
  );
  assert.deepEqual(operations, [
    "reserve",
    "runtime",
    "credential",
    "install",
    "release",
  ]);
});

test("removes an uncommitted Workspace snapshot when checkpoint persistence fails", async () => {
  const operations: string[] = [];
  let failedWithClearedRuntime = false;
  const store = {
    async createSessionMetadata() {
      return runtimeRecord.id;
    },
    async recordSessionAllocation() {},
    async markSessionProvisioned() {},
    async decoderState() {
      return runtimeRecord;
    },
    async getRpcResponse(_sessionId: string, requestId: string) {
      if (requestId.startsWith("initialize:")) return { result: {} };
      if (requestId.startsWith("thread-start:")) {
        return { result: { thread: { id: runtimeRecord.threadId } } };
      }
      return undefined;
    },
    async claimTurnCheckpoint() {
      return { state: "claimed", id: "checkpoint-test", ordinal: 0 } as const;
    },
    async completeTurnCheckpoint() {
      throw new Error("checkpoint commit failed");
    },
    async failTurnCheckpoint() {
      operations.push("fail-checkpoint");
    },
    async allocatedSessionResources() {
      return runtimeRecord;
    },
    async markSessionFailed(_sessionId: string, _error: string, clear: boolean) {
      failedWithClearedRuntime = clear;
    },
  } as unknown as SandpiStore;
  const runtime = {
    async provisionSession(input: Parameters<RuntimeAdapter["provisionSession"]>[0]) {
      await input.onResourcesAllocated?.(runtimeRecord);
      return runtimeRecord;
    },
    async writeCodexMessage() {},
    async createWorkspaceCheckpoint() {
      operations.push("create-snapshot");
      return { snapshotId: "snapshot-uncommitted" };
    },
    async deleteWorkspaceCheckpoint(
      _runtime: StoredRuntime,
      snapshotId: string,
    ) {
      operations.push(`delete-snapshot:${snapshotId}`);
    },
    async deleteSessionResources() {
      operations.push("delete-resources");
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  await assert.rejects(
    service.createSession({
      userId: "user-test",
      environment: {
        id: "env-test",
        workspaceVolumeId: "environment-volume",
      } as Environment,
      title: "Checkpoint failure",
      prompt: "Run the test",
      images: [],
    }),
    /initial Workspace checkpoint/i,
  );
  assert.deepEqual(operations, [
    "create-snapshot",
    "delete-snapshot:snapshot-uncommitted",
    "fail-checkpoint",
    "delete-resources",
  ]);
  assert.equal(failedWithClearedRuntime, true);
});

test("forks a Turn from its native Codex rollout and selected Workspace checkpoint", async () => {
  const childSessionId = "session-child";
  const writes: Array<Record<string, unknown>> = [];
  const copiedBounds: Array<number | undefined> = [];
  const runtimeBySession = (sessionId: string): StoredRuntime => ({
    ...runtimeRecord,
    id: sessionId,
    sandboxId: sessionId === childSessionId ? "sandbox-child" : "sandbox-source",
    workspaceVolumeId:
      sessionId === childSessionId ? "volume-child" : "volume-source",
    supervisorSessionId:
      sessionId === childSessionId ? "supervisor-child" : "supervisor-source",
    threadId: sessionId === childSessionId ? "thread-child" : "thread-source",
  });
  const store = {
    async getSession() {
      return {
        id: runtimeRecord.id,
        environmentId: "env-test",
        status: "waiting",
        title: "Source",
      };
    },
    async reserveTurnFork() {
      return {
        selectedTurnId: "turn-selected",
        selectedOrdinal: 2,
        selectedSnapshotId: "snapshot-selected",
        upperSequence: 42,
      };
    },
    async getRuntime(_userId: string, sessionId: string) {
      return runtimeBySession(sessionId);
    },
    async getEnvironment() {
      return {
        id: "env-test",
        templateId: "coding-agent",
        workspaceVolumeId: "environment-volume",
      } as Environment;
    },
    async createForkSessionMetadata(input: { kind?: string; sourceNativeItemId?: string }) {
      assert.equal(input.kind, "turn");
      assert.equal(input.sourceNativeItemId, "item-selected");
      return childSessionId;
    },
    async recordSessionAllocation() {},
    async markSessionProvisioned() {},
    async copyVisibleHarnessHistory(
      _sourceId: string,
      _childId: string,
      upperSequence?: number,
    ) {
      copiedBounds.push(upperSequence);
    },
    async decoderState(sessionId: string) {
      return runtimeBySession(sessionId);
    },
    async getRpcResponse(_sessionId: string, requestId: string) {
      if (requestId.startsWith("thread-read:")) {
        return {
          result: {
            thread: {
              id: "thread-source",
              path: "/var/lib/sandpi/codex/sessions/2026/rollout-source.jsonl",
            },
          },
        };
      }
      if (requestId.startsWith("initialize:")) return { result: {} };
      if (requestId.startsWith("thread-fork:")) {
        return { result: { thread: { id: "thread-child" } } };
      }
      return undefined;
    },
    async claimTurnCheckpoint() {
      return { state: "claimed", id: "checkpoint-child", ordinal: 0 } as const;
    },
    async completeTurnCheckpoint() {},
    async releaseSessionTurn() {},
    async releaseTurnFork() {},
    async retryableTurnCheckpoints() {
      return [];
    },
  } as unknown as SandpiStore;
  const runtime = {
    async writeCodexMessage(
      _runtime: StoredRuntime,
      message: Record<string, unknown>,
    ) {
      writes.push(message);
    },
    async forkTurn(input: Parameters<RuntimeAdapter["forkTurn"]>[0]) {
      assert.equal(input.workspaceSnapshotId, "snapshot-selected");
      assert.equal(
        input.sourceThreadPath,
        "/var/lib/sandpi/codex/sessions/2026/rollout-source.jsonl",
      );
      await input.onResourcesAllocated?.({
        sandboxId: "sandbox-child",
        workspaceVolumeId: "volume-child",
      });
      return {
        ...runtimeBySession(childSessionId),
        nativeCredentialTargetPath: "/dev/shm/sandpi-codex-auth.json",
        nativeThreadImportPath:
          "/var/lib/sandpi/codex/sessions/2026/rollout-source.jsonl",
      };
    },
    async deleteCodexThreadImport() {},
    async createWorkspaceCheckpoint() {
      return { snapshotId: "snapshot-child" };
    },
    async listCodexEvents() {
      return { events: [], cursor: { earliest: 0, latest: 0 } };
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  try {
    const result = await service.forkTurn({
      userId: "user-test",
      sessionId: runtimeRecord.id,
      userMessageItemId: "item-selected",
    });
    assert.equal(result, childSessionId);
    assert.deepEqual(copiedBounds, [42]);
    const nativeFork = writes.find((message) => message.method === "thread/fork");
    assert.deepEqual(nativeFork?.params, {
      threadId: "thread-source",
      path: "/var/lib/sandpi/codex/sessions/2026/rollout-source.jsonl",
      lastTurnId: "turn-selected",
      cwd: "/workspace",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  } finally {
    await service.close();
  }
});

test("compensates a failed Turn edit by restoring the original Workspace head", async () => {
  const restoreSnapshots: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  let finalizeAttempts = 0;
  let released = 0;
  let aborted = 0;
  let currentRuntime: StoredRuntime = { ...runtimeRecord, threadId: "thread-original" };
  const mutation = {
    selectedTurnId: "turn-edit",
    selectedOrdinal: 2,
    boundarySequence: 10,
    upperSequence: 20,
    restoreSnapshotId: "snapshot-before-edit",
    headSnapshotId: "snapshot-current-head",
    branchThroughTurnId: "turn-before-edit",
  };
  const store = {
    async prepareTurnMutation() {
      return mutation;
    },
    async getRuntime() {
      return currentRuntime;
    },
    async decoderState() {
      return currentRuntime;
    },
    async setRestoredRuntime(
      _sessionId: string,
      value: { threadId: string; attemptId: string; runtimeGeneration: number },
    ) {
      currentRuntime = { ...currentRuntime, ...value };
    },
    async setRuntimeThread(_sessionId: string, threadId: string) {
      currentRuntime = { ...currentRuntime, threadId };
    },
    async getRpcResponse(_sessionId: string, requestId: string) {
      if (requestId.startsWith("initialize:")) return { result: {} };
      if (requestId.startsWith("thread-resume:")) {
        return { result: { thread: { id: currentRuntime.threadId } } };
      }
      if (requestId.startsWith("thread-rewind:")) {
        return { result: { thread: { id: "thread-replacement" } } };
      }
      if (requestId.startsWith("turn-start:")) {
        return { result: { turn: { id: "turn-replacement" } } };
      }
      if (requestId.startsWith("turn-interrupt:")) return { result: {} };
      return undefined;
    },
    async finalizeTurnMutation() {
      finalizeAttempts += 1;
      throw new Error("database finalize failed");
    },
    async releasePreparedTurnMutation() {
      released += 1;
    },
    async abortTurnMutation() {
      aborted += 1;
    },
    async retryableTurnCheckpoints() {
      return [];
    },
  } as unknown as SandpiStore;
  const runtime = {
    async restoreWorkspaceCheckpoint(
      _runtime: StoredRuntime,
      snapshotId: string,
    ) {
      restoreSnapshots.push(snapshotId);
      return {
        attemptId: `attempt-${restoreSnapshots.length}`,
        runtimeGeneration: restoreSnapshots.length + 1,
      };
    },
    async readCodexSessionCredential() {
      return "{}";
    },
    async installCodexSessionCredential() {},
    async writeCodexMessage(
      _runtime: StoredRuntime,
      message: Record<string, unknown>,
    ) {
      writes.push(message);
    },
    async listCodexEvents() {
      return { events: [], cursor: { earliest: 0, latest: 0 } };
    },
  } as unknown as RuntimeAdapter;
  const service = new CodexService(store, runtime, logger, credentials);

  try {
    await assert.rejects(
      service.editTurn({
        userId: "user-test",
        sessionId: runtimeRecord.id,
        userMessageItemId: "item-edit",
        text: "replacement",
        images: [],
      }),
      /database finalize failed/,
    );
    assert.deepEqual(restoreSnapshots, [
      "snapshot-before-edit",
      "snapshot-current-head",
    ]);
    assert.equal(finalizeAttempts, 3);
    assert.equal(released, 1);
    assert.equal(aborted, 0);
    assert.ok(writes.some((message) => message.method === "turn/interrupt"));
  } finally {
    await service.close();
  }
});
