import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore, StoredEnvironmentRuntime } from "@/server/store";
import { ENVIRONMENT_IDLE_PAUSE_DELAY_MS } from "./lifecycle-policy";
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
    lifecyclePolicyVersion: 2,
    hardExpiresAt,
    ...overrides,
  };
}

const logger = {
  debug() {},
  info() {},
  warn() {},
};

test("Environment idle pause waits thirty minutes", () => {
  assert.equal(ENVIRONMENT_IDLE_PAUSE_DELAY_MS, 30 * 60 * 1_000);
});

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
      return { hardExpiresAt };
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
