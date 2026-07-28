import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore, StoredEnvironmentRuntime } from "@/server/store";
import { ENVIRONMENT_LIFECYCLE_POLICY_VERSION } from "./lifecycle-policy";
import { EnvironmentLifecycleService } from "./lifecycle-service";

function storedRuntime(
  overrides: Partial<StoredEnvironmentRuntime> = {},
): StoredEnvironmentRuntime {
  return {
    id: "environment-one",
    sandboxId: "sandbox-one",
    workspaceVolumeId: "volume-one",
    supervisorSessionId: "supervisor-one",
    attemptId: "attempt-one",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      attemptId: "attempt-one",
      runtimeGeneration: 1,
    },
    version: 1,
    desiredState: "running",
    observedState: "running",
    lifecyclePolicyVersion: ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
    appliedRuntimeConfigGeneration: 1,
    appliedSandboxMemoryMiB: 2_048,
    runtimeConfigAttemptCount: 0,
    ...overrides,
  };
}

const logger = {
  debug() {},
  info() {},
  warn() {},
};

const noRuntimeConfigCandidates = {
  async environmentRuntimeConfigCandidateIds() {
    return [];
  },
};

test("applies one durable runtime-config generation under the lifecycle lock", async () => {
  const calls: string[] = [];
  const runtimeState = storedRuntime({
    appliedRuntimeConfigGeneration: 1,
    appliedSandboxMemoryMiB: 1_024,
  });
  const networkPolicy = {
    mode: "block-all" as const,
    domainExceptions: ["github.com"],
  };
  const scopedStore = {
    async prepareEnvironmentRuntimeConfig() {
      calls.push("prepare");
      return {
        runtime: runtimeState,
        generation: 2,
        sandboxMemoryMiB: 2_048,
        networkPolicy,
      };
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      calls.push("credentials");
      return [];
    },
    async recordEnvironmentRuntimeConfigApplied(
      environmentId: string,
      sandboxId: string,
      generation: number,
      memoryMiB: number,
    ) {
      assert.equal(environmentId, runtimeState.id);
      assert.equal(sandboxId, runtimeState.sandboxId);
      assert.equal(generation, 2);
      assert.equal(memoryMiB, 2_048);
      calls.push("record");
      return true;
    },
    async recordEnvironmentRuntimeConfigFailure() {
      assert.fail("successful convergence must not record a failure");
    },
  } as unknown as SandpiStore;
  const store = {
    async environmentRuntimeConfigCandidateIds() {
      return [runtimeState.id];
    },
    async environmentLifecyclePolicyCandidateIds() {
      return [];
    },
    async environmentIdlePauseCandidateIds() {
      return [];
    },
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: (store: SandpiStore) => Promise<void>,
    ) {
      assert.equal(environmentId, runtimeState.id);
      calls.push("lock");
      return { acquired: true as const, value: await operation(scopedStore) };
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async updateEnvironmentNetworkPolicy(
      received: StoredEnvironmentRuntime,
      receivedPolicy: typeof networkPolicy,
    ) {
      assert.strictEqual(received, runtimeState);
      assert.deepEqual(receivedPolicy, networkPolicy);
      calls.push("network");
    },
    async updateEnvironmentMemory(
      received: StoredEnvironmentRuntime,
      memoryMiB: number,
    ) {
      assert.strictEqual(received, runtimeState);
      assert.equal(memoryMiB, 2_048);
      calls.push("memory");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);

  await service.reconcileOnce();
  await service.close();

  assert.deepEqual(calls, [
    "lock",
    "prepare",
    "credentials",
    "network",
    "memory",
    "record",
  ]);
});

test("records a retry after failure and a restarted reconciler can finish it", async () => {
  const calls: string[] = [];
  let shouldFail = true;
  const runtimeState = storedRuntime({
    appliedRuntimeConfigGeneration: 1,
    appliedSandboxMemoryMiB: 1_024,
  });
  const prepared = {
    runtime: runtimeState,
    generation: 2,
    sandboxMemoryMiB: 2_048,
    networkPolicy: {
      mode: "allow-all" as const,
      domainExceptions: [],
    },
  };
  const store = {
    async environmentRuntimeConfigCandidateIds() {
      return [runtimeState.id];
    },
    async environmentLifecyclePolicyCandidateIds() {
      return [];
    },
    async environmentIdlePauseCandidateIds() {
      return [];
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<void>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async prepareEnvironmentRuntimeConfig() {
      calls.push("prepare");
      return prepared;
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [];
    },
    async recordEnvironmentRuntimeConfigFailure(
      _environmentId: string,
      _sandboxId: string,
      generation: number,
      error: string,
      retryAt: Date,
    ) {
      assert.equal(generation, 2);
      assert.equal(error, "Sandbox0 resize timed out");
      assert.ok(retryAt.getTime() > Date.now());
      calls.push("failure");
    },
    async recordEnvironmentRuntimeConfigApplied() {
      calls.push("applied");
      return true;
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async updateEnvironmentNetworkPolicy() {
      calls.push("network");
    },
    async updateEnvironmentMemory() {
      calls.push("memory");
      if (shouldFail) throw new Error("Sandbox0 resize timed out");
    },
  } as unknown as RuntimeAdapter;

  const firstServer = new EnvironmentLifecycleService(store, runtime, logger);
  await firstServer.reconcileOnce();
  await firstServer.close();
  shouldFail = false;
  const restartedServer = new EnvironmentLifecycleService(store, runtime, logger);
  await restartedServer.reconcileOnce();
  await restartedServer.close();

  assert.deepEqual(calls, [
    "prepare",
    "network",
    "memory",
    "failure",
    "prepare",
    "network",
    "memory",
    "applied",
  ]);
});

test("a reconciliation request during an active pass schedules another scan", async () => {
  let releaseMemoryUpdate!: () => void;
  const memoryUpdateGate = new Promise<void>((resolve) => {
    releaseMemoryUpdate = resolve;
  });
  let candidateScans = 0;
  const runtimeState = storedRuntime({
    appliedRuntimeConfigGeneration: 1,
  });
  const store = {
    async environmentRuntimeConfigCandidateIds() {
      candidateScans += 1;
      return candidateScans === 1 ? [runtimeState.id] : [];
    },
    async environmentLifecyclePolicyCandidateIds() {
      return [];
    },
    async environmentIdlePauseCandidateIds() {
      return [];
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<void>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async prepareEnvironmentRuntimeConfig() {
      return {
        runtime: runtimeState,
        generation: 2,
        sandboxMemoryMiB: 2_048,
        networkPolicy: {
          mode: "allow-all" as const,
          domainExceptions: [],
        },
      };
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [];
    },
    async recordEnvironmentRuntimeConfigApplied() {
      return true;
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async updateEnvironmentNetworkPolicy() {},
    async updateEnvironmentMemory() {
      await memoryUpdateGate;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);

  const first = service.reconcileOnce();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = service.reconcileOnce();
  assert.strictEqual(first, second);
  releaseMemoryUpdate();
  await first;
  await service.close();

  assert.equal(candidateScans, 2);
});

test("one elected worker applies policy and pauses a due idle Environment", async () => {
  const calls: string[] = [];
  const policyRuntime = storedRuntime({ lifecyclePolicyVersion: 0 });
  const store = {
    ...noRuntimeConfigCandidates,
    async environmentLifecyclePolicyCandidateIds() {
      return [policyRuntime.id];
    },
    async environmentIdlePauseCandidateIds() {
      return [policyRuntime.id];
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      calls.push("lock");
      return { acquired: true, value: await operation() };
    },
    async prepareEnvironmentLifecyclePolicy() {
      calls.push("prepare-policy");
      return policyRuntime;
    },
    async recordEnvironmentLifecyclePolicy() {
      calls.push("record-policy");
    },
    async recordEnvironmentLifecycleError() {
      assert.fail("policy must not fail");
    },
    async prepareEnvironmentIdlePause() {
      calls.push("prepare-pause");
      return policyRuntime;
    },
    async recordEnvironmentPaused() {
      calls.push("record-paused");
    },
    async recordEnvironmentPauseFailure() {
      assert.fail("pause must not fail");
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async applyEnvironmentLifecyclePolicy(
      received: StoredEnvironmentRuntime,
    ) {
      assert.strictEqual(received, policyRuntime);
      calls.push("apply-policy");
    },
    async pauseEnvironment() {
      calls.push("pause");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);
  service.setBeforePause(() => {
    calls.push("suspend-worker");
  });

  await service.reconcileOnce();
  await service.close();

  assert.deepEqual(calls, [
    "lock",
    "prepare-policy",
    "apply-policy",
    "record-policy",
    "lock",
    "prepare-pause",
    "suspend-worker",
    "pause",
    "record-paused",
  ]);
});

test("idle pause passes the lifecycle-scoped Store through credential flush", async () => {
  const calls: string[] = [];
  const runtimeState = storedRuntime();
  const scopedStore = {
    async prepareEnvironmentIdlePause(environmentId: string) {
      assert.equal(environmentId, runtimeState.id);
      calls.push("prepare");
      return runtimeState;
    },
    async recordEnvironmentPaused(
      environmentId: string,
      sandboxId: string,
    ) {
      assert.equal(environmentId, runtimeState.id);
      assert.equal(sandboxId, runtimeState.sandboxId);
      calls.push("record");
    },
    async recordEnvironmentPauseFailure() {
      assert.fail("successful pause must not record a failure");
    },
  } as unknown as SandpiStore;
  const rootStore = {
    ...noRuntimeConfigCandidates,
    async environmentLifecyclePolicyCandidateIds() {
      return [];
    },
    async environmentIdlePauseCandidateIds() {
      return [runtimeState.id];
    },
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<unknown>,
    ) {
      assert.equal(environmentId, runtimeState.id);
      calls.push("lifecycle");
      return { acquired: true as const, value: await operation(scopedStore) };
    },
    async prepareEnvironmentIdlePause() {
      assert.fail("pause preparation must use the lifecycle-scoped Store");
    },
    async recordEnvironmentPaused() {
      assert.fail("pause completion must use the lifecycle-scoped Store");
    },
    async recordEnvironmentPauseFailure() {
      assert.fail("pause failure must use the lifecycle-scoped Store");
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment(received: StoredEnvironmentRuntime) {
      assert.strictEqual(received, runtimeState);
      calls.push("pause");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(rootStore, runtime, logger);
  const flushEnvironmentCredentials = async (
    environmentId: string,
    store: SandpiStore,
  ) => {
    assert.equal(environmentId, runtimeState.id);
    assert.strictEqual(store, scopedStore);
    calls.push("flush");
  };
  service.setBeforePause(flushEnvironmentCredentials);

  await service.reconcileOnce();
  await service.close();

  assert.deepEqual(calls, [
    "lifecycle",
    "prepare",
    "flush",
    "pause",
    "record",
  ]);
});

test("a replica that loses the advisory-lock election does no external work", async () => {
  let externalCalls = 0;
  const store = {
    ...noRuntimeConfigCandidates,
    async environmentLifecyclePolicyCandidateIds() {
      return [];
    },
    async environmentIdlePauseCandidateIds() {
      return ["environment-one"];
    },
    async withEnvironmentLifecycleLock() {
      return { acquired: false };
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment() {
      externalCalls += 1;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);

  await service.reconcileOnce();
  await service.close();

  assert.equal(externalCalls, 0);
});

test("a failed pause remains a durable retry instead of failing the scheduler", async () => {
  const runtimeState = storedRuntime();
  let recordedError = "";
  const store = {
    ...noRuntimeConfigCandidates,
    async environmentLifecyclePolicyCandidateIds() {
      return [];
    },
    async environmentIdlePauseCandidateIds() {
      return [runtimeState.id];
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      return { acquired: true, value: await operation() };
    },
    async prepareEnvironmentIdlePause() {
      return runtimeState;
    },
    async recordEnvironmentPaused() {
      assert.fail("failed pause must not be marked complete");
    },
    async recordEnvironmentPauseFailure(
      _environmentId: string,
      _sandboxId: string,
      error: string,
    ) {
      recordedError = error;
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment() {
      throw new Error("pause timed out");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);

  await service.reconcileOnce();
  await service.close();

  assert.equal(recordedError, "pause timed out");
});

test("quota pause is lifecycle-locked and records a distinct pause reason", async () => {
  const calls: string[] = [];
  const runtimeState = storedRuntime();
  const scopedStore = {
    async prepareEnvironmentQuotaPause(environmentId: string) {
      assert.equal(environmentId, runtimeState.id);
      calls.push("prepare");
      return runtimeState;
    },
    async recordEnvironmentPaused(
      environmentId: string,
      sandboxId: string,
      reason: string,
    ) {
      assert.equal(environmentId, runtimeState.id);
      assert.equal(sandboxId, runtimeState.sandboxId);
      assert.equal(reason, "quota");
      calls.push("record");
    },
    async recordEnvironmentQuotaPauseFailure() {
      assert.fail("successful quota pause must not record a failure");
    },
  } as unknown as SandpiStore;
  const rootStore = {
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: (store: SandpiStore) => Promise<void>,
    ) {
      assert.equal(environmentId, runtimeState.id);
      calls.push("lock");
      return { acquired: true, value: await operation(scopedStore) };
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment(received: StoredEnvironmentRuntime) {
      assert.strictEqual(received, runtimeState);
      calls.push("pause");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(rootStore, runtime, logger);
  service.setBeforePause((_environmentId, store) => {
    assert.strictEqual(store, scopedStore);
    calls.push("flush");
  });

  await service.pauseForQuota(runtimeState.id);
  await service.close();

  assert.deepEqual(calls, ["lock", "prepare", "flush", "pause", "record"]);
});

test("quota pause rechecks entitlement after taking the lifecycle lock", async () => {
  const calls: string[] = [];
  const runtimeState = storedRuntime();
  const store = {
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<void>,
    ) {
      calls.push("lock");
      return {
        acquired: true,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async prepareEnvironmentQuotaPause() {
      calls.push("prepare");
      return runtimeState;
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async pauseEnvironment() {
      calls.push("pause");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger, {
    quotaGate: {
      async assertEnvironmentRuntimeAllowed() {},
      async isEnvironmentRuntimeBlocked() {
        calls.push("quota");
        return false;
      },
    },
  });

  await service.pauseForQuota(runtimeState.id);
  await service.close();

  assert.deepEqual(calls, ["lock", "quota"]);
});
