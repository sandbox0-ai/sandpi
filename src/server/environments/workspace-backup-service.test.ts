import assert from "node:assert/strict";
import test from "node:test";

import type { Environment, EnvironmentWorkspaceBackup } from "@/lib/types";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type {
  PreparedEnvironmentWorkspaceBackup,
  SandpiStore,
  StoredEnvironmentRuntime,
} from "@/server/store";
import { EnvironmentWorkspaceBackupService } from "./workspace-backup-service";

const logger = {
  info() {},
  warn() {},
};

const runtimeState: StoredEnvironmentRuntime = {
  id: "environment-one",
  sandboxId: "sandbox-one",
  workspaceVolumeId: "volume-one",
  runtimeGeneration: 1,
  decoder: {
    supervisorCursor: 0,
    tailBase64: "",
    runtimeGeneration: 1,
  },
  version: 1,
  desiredState: "running",
  observedState: "running",
  lifecyclePolicyVersion: 1,
};

const environment: Environment = {
  id: runtimeState.id,
  teamId: "team-one",
  ownerId: "user-one",
  visibility: "team",
  idlePauseTimeoutSeconds: 1_800,
  sandboxMemoryMiB: 2_048,
  workspaceBackup: {
    intervalSeconds: 86_400,
    retentionCount: 1,
  },
  name: "Development",
  description: "",
  color: "#151515",
  status: "ready",
  revision: 1,
  templateId: "coding-agent",
  rootfsSnapshotId: "",
  workspaceVolumeId: runtimeState.workspaceVolumeId,
  sandboxId: runtimeState.sandboxId,
  sandboxState: "running",
  supervisorSessionId: "",
  workspaceRoot: "/workspace",
  credentialRevision: 0,
  codingAgent: { harness: "codex", label: "Codex", status: "connected" },
  networkPolicy: { mode: "allow-all", domainExceptions: [] },
};

const prepared: PreparedEnvironmentWorkspaceBackup = {
  runtime: runtimeState,
  createBackup: true,
  retentionCount: 1,
};

const oldBackup: EnvironmentWorkspaceBackup = {
  id: "snapshot-old",
  environmentId: environment.id,
  name: "old-backup",
  sizeBytes: 512,
  kind: "automatic",
  createdAt: 1,
};

test("one elected worker snapshots the Workspace and prunes only journaled backups", async () => {
  const calls: string[] = [];
  const scopedStore = {
    async prepareEnvironmentWorkspaceBackup(environmentId: string, force: boolean) {
      assert.equal(environmentId, environment.id);
      assert.equal(force, false);
      calls.push("prepare");
      return prepared;
    },
    async recordEnvironmentWorkspaceBackup(
      environmentId: string,
      sandboxId: string,
      snapshot: { id: string },
      kind: string,
    ) {
      assert.equal(environmentId, environment.id);
      assert.equal(sandboxId, runtimeState.sandboxId);
      assert.equal(snapshot.id, "snapshot-new");
      assert.equal(kind, "automatic");
      calls.push("record");
    },
    async environmentWorkspaceBackupsBeyondRetention() {
      calls.push("list-expired");
      return [oldBackup];
    },
    async deleteEnvironmentWorkspaceBackupRecord(
      environmentId: string,
      snapshotId: string,
    ) {
      assert.equal(environmentId, environment.id);
      assert.equal(snapshotId, oldBackup.id);
      calls.push("delete-record");
    },
    async recordEnvironmentWorkspaceBackupHealthy() {
      calls.push("healthy");
    },
    async recordEnvironmentWorkspaceBackupFailure() {
      assert.fail("successful backup must not record a failure");
    },
  } as unknown as SandpiStore;
  const rootStore = {
    async environmentWorkspaceBackupCandidateIds() {
      return [environment.id];
    },
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      assert.equal(environmentId, environment.id);
      calls.push("lock");
      return { acquired: true as const, value: await operation(scopedStore) };
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async createEnvironmentWorkspaceBackup(
      received: StoredEnvironmentRuntime,
      input: { name: string; description: string },
    ) {
      assert.strictEqual(received, runtimeState);
      assert.match(input.name, /^sandpi-workspace-/);
      assert.match(input.description, /automatic/);
      calls.push("create");
      return {
        id: "snapshot-new",
        name: input.name,
        sizeBytes: 1_024,
        createdAt: new Date("2026-07-21T12:00:00.000Z"),
      };
    },
    async deleteEnvironmentWorkspaceBackup(
      received: StoredEnvironmentRuntime,
      snapshotId: string,
    ) {
      assert.strictEqual(received, runtimeState);
      assert.equal(snapshotId, oldBackup.id);
      calls.push("delete-native");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentWorkspaceBackupService(
    rootStore,
    runtime,
    logger,
  );

  await service.reconcileOnce();
  await service.close();

  assert.deepEqual(calls, [
    "lock",
    "prepare",
    "create",
    "record",
    "list-expired",
    "delete-native",
    "delete-record",
    "healthy",
  ]);
});

test("a failed native snapshot remains a durable retry", async () => {
  let recordedError = "";
  const store = {
    async environmentWorkspaceBackupCandidateIds() {
      return [environment.id];
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (scopedStore: SandpiStore) => Promise<unknown>,
    ) {
      return { acquired: true as const, value: await operation(this as SandpiStore) };
    },
    async prepareEnvironmentWorkspaceBackup() {
      return prepared;
    },
    async recordEnvironmentWorkspaceBackupFailure(
      _environmentId: string,
      _sandboxId: string,
      error: string,
    ) {
      recordedError = error;
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async createEnvironmentWorkspaceBackup() {
      throw new Error("snapshot quota exceeded");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentWorkspaceBackupService(store, runtime, logger);

  await service.reconcileOnce();
  await service.close();

  assert.equal(recordedError, "snapshot quota exceeded");
});

test("manual backup authorizes management and returns the refreshed policy state", async () => {
  let environmentReads = 0;
  const refreshedEnvironment: Environment = {
    ...environment,
    workspaceBackup: {
      ...environment.workspaceBackup,
      lastBackupAt: 1_774_353_600,
      nextBackupAt: 1_774_440_000,
    },
  };
  const scopedStore = {
    async getManageableEnvironment(userId: string, environmentId: string) {
      assert.equal(userId, "user-one");
      assert.equal(environmentId, environment.id);
      environmentReads += 1;
      return environmentReads > 1 ? refreshedEnvironment : environment;
    },
    async assertEnvironmentWorkspaceQuiescent() {},
    async prepareEnvironmentWorkspaceBackup(
      _environmentId: string,
      force: boolean,
    ) {
      assert.equal(force, true);
      return prepared;
    },
    async recordEnvironmentWorkspaceBackup() {},
    async environmentWorkspaceBackupsBeyondRetention() {
      return [];
    },
    async recordEnvironmentWorkspaceBackupHealthy() {},
    async recordEnvironmentWorkspaceBackupFailure() {
      assert.fail("successful manual backup must not record a failure");
    },
  } as unknown as SandpiStore;
  const rootStore = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      return { acquired: true as const, value: await operation(scopedStore) };
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async createEnvironmentWorkspaceBackup(
      _runtime: StoredEnvironmentRuntime,
      input: { name: string },
    ) {
      return {
        id: "snapshot-manual",
        name: input.name,
        sizeBytes: 2_048,
        createdAt: new Date("2026-07-21T12:00:00.000Z"),
      };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentWorkspaceBackupService(
    rootStore,
    runtime,
    logger,
  );

  const result = await service.createNow("user-one", environment.id);
  await service.close();

  assert.equal(result.backup.id, "snapshot-manual");
  assert.equal(result.backup.kind, "manual");
  assert.strictEqual(result.environment, refreshedEnvironment);
});

test("restore pauses, restores and auto-resumes a running Environment under one lifecycle lock", async () => {
  const calls: string[] = [];
  const refreshedEnvironment: Environment = {
    ...environment,
    sandboxState: "running",
  };
  const scopedStore = {
    async getManageableEnvironment() {
      calls.push("authorize-locked");
      return calls.includes("record-runtime-access")
        ? refreshedEnvironment
        : environment;
    },
    async prepareEnvironmentWorkspaceRestore() {
      calls.push("prepare");
      return {
        runtime: runtimeState,
        backup: oldBackup,
        resumeAfterRestore: true,
      };
    },
    async recordEnvironmentWorkspaceRestored() {
      calls.push("record-restore");
      return { unavailableSessionCount: 2 };
    },
    async recordEnvironmentRuntimeAccess() {
      calls.push("record-runtime-access");
      return runtimeState;
    },
    async recordEnvironmentPaused() {
      assert.fail("a previously running Environment must auto-resume");
    },
  } as unknown as SandpiStore;
  const rootStore = {
    async getManageableEnvironment() {
      calls.push("authorize");
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      calls.push("lock");
      return { acquired: true as const, value: await operation(scopedStore) };
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment(received: StoredEnvironmentRuntime) {
      assert.strictEqual(received, runtimeState);
      calls.push("pause");
    },
    async restoreEnvironmentWorkspaceBackup(
      received: StoredEnvironmentRuntime,
      snapshotId: string,
    ) {
      assert.strictEqual(received, runtimeState);
      assert.equal(snapshotId, oldBackup.id);
      calls.push("restore-native");
    },
    async ensureEnvironmentRuntimeAccess(received: StoredEnvironmentRuntime) {
      assert.strictEqual(received, runtimeState);
      calls.push("auto-resume");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentWorkspaceBackupService(
    rootStore,
    runtime,
    logger,
  );
  service.setRestoreHooks({
    async before() {
      calls.push("before");
    },
    async afterAttempt(_environmentId, result) {
      assert.deepEqual(result, {
        nativeRestored: true,
        resumeAfterRestore: true,
      });
      calls.push("after");
    },
  });

  const result = await service.restore(
    "user-one",
    environment.id,
    oldBackup.id,
    environment.name,
  );
  await service.close();

  assert.equal(result.backup.id, oldBackup.id);
  assert.equal(result.unavailableSessionCount, 2);
  assert.strictEqual(result.environment, refreshedEnvironment);
  assert.deepEqual(calls, [
    "authorize",
    "lock",
    "authorize-locked",
    "prepare",
    "before",
    "pause",
    "restore-native",
    "record-restore",
    "auto-resume",
    "record-runtime-access",
    "authorize-locked",
    "after",
  ]);
});

test("restore leaves an originally paused Environment paused", async () => {
  const pausedRuntime: StoredEnvironmentRuntime = {
    ...runtimeState,
    desiredState: "paused",
    observedState: "paused",
  };
  let recordedPaused = false;
  const store = {
    async getManageableEnvironment() {
      return { ...environment, sandboxState: "paused" };
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      return { acquired: true as const, value: await operation(this as SandpiStore) };
    },
    async prepareEnvironmentWorkspaceRestore() {
      return {
        runtime: pausedRuntime,
        backup: oldBackup,
        resumeAfterRestore: false,
      };
    },
    async recordEnvironmentWorkspaceRestored() {
      return { unavailableSessionCount: 0 };
    },
    async recordEnvironmentPaused() {
      recordedPaused = true;
    },
    async recordEnvironmentRuntimeAccess() {
      assert.fail("a previously paused Environment must remain paused");
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment() {},
    async restoreEnvironmentWorkspaceBackup() {},
    async ensureEnvironmentRuntimeAccess() {
      assert.fail("restore must not wake an originally paused Environment");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentWorkspaceBackupService(store, runtime, logger);

  const result = await service.restore(
    "user-one",
    environment.id,
    oldBackup.id,
    environment.name,
  );
  await service.close();

  assert.equal(result.environment.sandboxState, "paused");
  assert.equal(recordedPaused, true);
});

test("a failed native restore returns a running Environment to its previous lifecycle", async () => {
  const calls: string[] = [];
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      return { acquired: true as const, value: await operation(this as SandpiStore) };
    },
    async prepareEnvironmentWorkspaceRestore() {
      return {
        runtime: runtimeState,
        backup: oldBackup,
        resumeAfterRestore: true,
      };
    },
    async recordEnvironmentRuntimeAccess() {
      calls.push("record-running");
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment() {
      calls.push("pause");
    },
    async restoreEnvironmentWorkspaceBackup() {
      calls.push("restore");
      throw new Error("volume owner is busy");
    },
    async ensureEnvironmentRuntimeAccess() {
      calls.push("auto-resume");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentWorkspaceBackupService(store, runtime, logger);
  service.setRestoreHooks({
    before() {
      calls.push("before");
    },
    afterAttempt(_environmentId, result) {
      assert.equal(result.nativeRestored, false);
      calls.push("after");
    },
  });

  await assert.rejects(
    service.restore(
      "user-one",
      environment.id,
      oldBackup.id,
      environment.name,
    ),
    /volume owner is busy/,
  );
  await service.close();

  assert.deepEqual(calls, [
    "before",
    "pause",
    "restore",
    "auto-resume",
    "record-running",
    "after",
  ]);
});

test("restore requires the current Environment name before taking the lifecycle lock", async () => {
  let locked = false;
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock() {
      locked = true;
      return { acquired: false as const };
    },
  } as unknown as SandpiStore;
  const service = new EnvironmentWorkspaceBackupService(
    store,
    { mode: "sandbox0" } as RuntimeAdapter,
    logger,
  );

  await assert.rejects(
    service.restore("user-one", environment.id, oldBackup.id, "wrong name"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_workspace_restore_confirmation_mismatch",
  );
  await service.close();

  assert.equal(locked, false);
});
