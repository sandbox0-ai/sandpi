import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore, StoredEnvironmentRuntime } from "@/server/store";
import { EnvironmentLifecycleService } from "./lifecycle-service";

const hardExpiresAt = new Date("2026-08-15T00:00:00.000Z");

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
    lifecyclePolicyVersion: 1,
    hardExpiresAt,
    ...overrides,
  };
}

const logger = {
  debug() {},
  info() {},
  warn() {},
};

test("one elected worker applies policy and pauses a due idle Environment", async () => {
  const calls: string[] = [];
  const policyRuntime = storedRuntime({ lifecyclePolicyVersion: 0 });
  const store = {
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
    async configureEnvironmentLifecycle(
      _runtime: StoredEnvironmentRuntime,
      hardTtlSeconds: number,
    ) {
      assert.ok(hardTtlSeconds > 0);
      calls.push("configure-policy");
      return { hardExpiresAt, resumed: false };
    },
    async pauseEnvironment() {
      calls.push("pause");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);
  service.setBeforePause(() => calls.push("suspend-worker"));

  await service.reconcileOnce();
  await service.close();

  assert.deepEqual(calls, [
    "lock",
    "prepare-policy",
    "configure-policy",
    "record-policy",
    "lock",
    "prepare-pause",
    "suspend-worker",
    "pause",
    "record-paused",
  ]);
});

test("a replica that loses the advisory-lock election does no external work", async () => {
  let externalCalls = 0;
  const store = {
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

test("a user access explicitly resumes a paused Environment under the same lock", async () => {
  const paused = storedRuntime({
    desiredState: "paused",
    observedState: "paused",
    pausedAt: new Date("2026-07-16T00:04:00.000Z"),
  });
  const running = storedRuntime();
  const calls: string[] = [];
  const store = {
    async getEnvironmentRuntime() {
      calls.push("authorize");
      return paused;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      calls.push("lock");
      return { acquired: true, value: await operation() };
    },
    async environmentRuntime() {
      return paused;
    },
    async requestEnvironmentRunning() {
      calls.push("request-running");
      return { ...paused, desiredState: "running" };
    },
    async recordEnvironmentResumed() {
      calls.push("record-running");
      return running;
    },
    async recordEnvironmentResumeFailure() {
      assert.fail("resume must not fail");
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async resumeEnvironment() {
      calls.push("resume");
      return { hardExpiresAt, resumed: true };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);

  const lease = await service.ensureEnvironmentRunning(
    "user-one",
    paused.id,
  );
  await service.close();

  assert.equal(lease.resumed, true);
  assert.equal(lease.runtime.observedState, "running");
  assert.deepEqual(calls, [
    "authorize",
    "lock",
    "request-running",
    "resume",
    "record-running",
  ]);
});

test("concurrent requests share one Environment wake-up", async () => {
  const paused = storedRuntime({
    desiredState: "paused",
    observedState: "paused",
  });
  const running = storedRuntime();
  let current = paused;
  let lockCalls = 0;
  let resumeCalls = 0;
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const store = {
    async environmentRuntime() {
      return current;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      lockCalls += 1;
      return { acquired: true, value: await operation() };
    },
    async requestEnvironmentRunning() {
      current = { ...paused, desiredState: "running" };
      return current;
    },
    async recordEnvironmentResumed() {
      current = running;
      return running;
    },
    async recordEnvironmentResumeFailure() {},
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async resumeEnvironment() {
      resumeCalls += 1;
      await resumeGate;
      return { hardExpiresAt, resumed: true };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentLifecycleService(store, runtime, logger);

  const leases = Array.from({ length: 12 }, () =>
    service.ensureEnvironmentRunningById(paused.id),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lockCalls, 1);
  assert.equal(resumeCalls, 1);
  releaseResume();

  assert.equal((await Promise.all(leases)).every((lease) => lease.resumed), true);
  await service.close();
});
