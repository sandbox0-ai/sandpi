import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore, StoredEnvironmentRuntime } from "@/server/store";
import { EnvironmentRuntimeAccessService } from "./runtime-access-service";

const environmentRuntime: StoredEnvironmentRuntime = {
  id: "environment-test",
  sandboxId: "sandbox-test",
  workspaceVolumeId: "volume-test",
  runtimeGeneration: 1,
  decoder: {
    supervisorCursor: 0,
    tailBase64: "",
    runtimeGeneration: 1,
  },
  version: 1,
  desiredState: "running",
  lifecyclePolicyVersion: 1,
};

test("executes a warm Environment access without a runtime probe", async () => {
  const calls: string[] = [];
  const store = {
    async getEnvironment() {
      calls.push("authorize");
      return {};
    },
    async getEnvironmentRuntime() {
      calls.push("runtime");
      return environmentRuntime;
    },
    async withEnvironmentRuntimeAccessLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      calls.push("lock");
      return { acquired: true as const, value: await operation() };
    },
    async recordEnvironmentRuntimeAccess() {
      calls.push("record");
      return environmentRuntime;
    },
  } as unknown as SandpiStore;
  const runtime = {
    async ensureEnvironmentRuntimeAccess() {
      calls.push("ensure");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentRuntimeAccessService(store, runtime);

  const value = await service.withRuntimeAccess(
    "user-test",
    environmentRuntime.id,
    async (current) => {
      calls.push("operation");
      assert.strictEqual(current, environmentRuntime);
      return "ready";
    },
  );

  assert.equal(value, "ready");
  assert.deepEqual(calls, [
    "authorize",
    "lock",
    "runtime",
    "operation",
    "record",
  ]);
});

test("rejects passive access while the Environment is paused", async () => {
  let operationCalls = 0;
  let accessRecords = 0;
  const store = runtimeAccessStore({
    runtime: { ...environmentRuntime, desiredState: "paused" as const },
    async recordEnvironmentRuntimeAccess() {
      accessRecords += 1;
      return environmentRuntime;
    },
  });
  const service = new EnvironmentRuntimeAccessService(
    store,
    {} as RuntimeAdapter,
  );

  await assert.rejects(
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        operationCalls += 1;
      },
      { wakePaused: false },
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "environment_paused",
  );
  assert.equal(operationCalls, 0);
  assert.equal(accessRecords, 0);
});

test("keeps explicit access able to wake a paused Environment", async () => {
  let operationCalls = 0;
  const paused = { ...environmentRuntime, desiredState: "paused" as const };
  const store = runtimeAccessStore({ runtime: paused });
  const service = new EnvironmentRuntimeAccessService(
    store,
    {} as RuntimeAdapter,
  );

  await service.withRuntimeAccess(
    "user-test",
    environmentRuntime.id,
    async (current) => {
      operationCalls += 1;
      assert.strictEqual(current, paused);
    },
  );
  assert.equal(operationCalls, 1);
});

test("rechecks passive admission before repairing a newly paused Environment", async () => {
  let runtimeReads = 0;
  let ensureCalls = 0;
  const store = runtimeAccessStore({
    async getEnvironmentRuntime() {
      runtimeReads += 1;
      return runtimeReads === 1
        ? environmentRuntime
        : { ...environmentRuntime, desiredState: "paused" as const };
    },
  });
  const runtime = {
    async ensureEnvironmentRuntimeAccess() {
      ensureCalls += 1;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentRuntimeAccessService(store, runtime);

  await assert.rejects(
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        throw new HttpError(
          503,
          "sandbox0_workspace_unavailable",
          "Workspace unavailable.",
        );
      },
      { wakePaused: false },
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "environment_paused",
  );
  assert.equal(runtimeReads, 2);
  assert.equal(ensureCalls, 0);
});

test("repairs and retries a recoverable native Environment access once", async () => {
  const recoverableErrors = [
    new HttpError(
      503,
      "sandbox0_unavailable",
      "The Sandbox is waking up.",
    ),
    new HttpError(
      503,
      "sandbox0_workspace_unavailable",
      "The Workspace portal is unavailable.",
    ),
    new Error("transport endpoint is not connected"),
  ];

  for (const recoverableError of recoverableErrors) {
    let operationCalls = 0;
    let ensureCalls = 0;
    let accessRecords = 0;
    let sharedLockDepth = 0;
    let lifecycleLockDepth = 0;
    const store = runtimeAccessStore({
      async withEnvironmentRuntimeAccessLock(_environmentId, operation) {
        sharedLockDepth += 1;
        try {
          return { acquired: true as const, value: await operation() };
        } finally {
          sharedLockDepth -= 1;
        }
      },
      async withEnvironmentLifecycleLock(_environmentId, operation) {
        assert.equal(sharedLockDepth, 0);
        lifecycleLockDepth += 1;
        try {
          return { acquired: true as const, value: await operation() };
        } finally {
          lifecycleLockDepth -= 1;
        }
      },
      async recordEnvironmentRuntimeAccess() {
        accessRecords += 1;
        return environmentRuntime;
      },
    });
    const runtime = {
      async ensureEnvironmentRuntimeAccess(current: StoredEnvironmentRuntime) {
        ensureCalls += 1;
        assert.equal(sharedLockDepth, 0);
        assert.equal(lifecycleLockDepth, 1);
        assert.strictEqual(current, environmentRuntime);
      },
    } as unknown as RuntimeAdapter;
    const service = new EnvironmentRuntimeAccessService(store, runtime);

    const value = await service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        operationCalls += 1;
        if (operationCalls === 1) throw recoverableError;
        return "recovered";
      },
    );

    assert.equal(value, "recovered");
    assert.equal(operationCalls, 2);
    assert.equal(ensureCalls, 1);
    assert.equal(accessRecords, 1);
  }
});

test("coalesces concurrent native repairs outside shared admission", async () => {
  let ensureCalls = 0;
  let lifecycleLockCalls = 0;
  let sharedLockDepth = 0;
  let releaseRepair!: () => void;
  const repairCanFinish = new Promise<void>((resolve) => {
    releaseRepair = resolve;
  });
  let repairStarted!: () => void;
  const didStartRepair = new Promise<void>((resolve) => {
    repairStarted = resolve;
  });
  const store = runtimeAccessStore({
    async withEnvironmentRuntimeAccessLock(_environmentId, operation) {
      sharedLockDepth += 1;
      try {
        return { acquired: true as const, value: await operation() };
      } finally {
        sharedLockDepth -= 1;
      }
    },
    async withEnvironmentLifecycleLock(_environmentId, operation) {
      lifecycleLockCalls += 1;
      assert.equal(sharedLockDepth, 0);
      return { acquired: true as const, value: await operation() };
    },
  });
  const runtime = {
    async ensureEnvironmentRuntimeAccess() {
      ensureCalls += 1;
      repairStarted();
      await repairCanFinish;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentRuntimeAccessService(store, runtime);
  const attempts = new Map<string, number>();
  const access = (requestId: string) =>
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        const attempt = (attempts.get(requestId) ?? 0) + 1;
        attempts.set(requestId, attempt);
        if (attempt === 1) {
          throw new HttpError(
            503,
            "sandbox0_workspace_unavailable",
            "Workspace unavailable.",
          );
        }
        return requestId;
      },
    );

  const first = access("first");
  const second = access("second");
  await didStartRepair;
  releaseRepair();

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(ensureCalls, 1);
  assert.equal(lifecycleLockCalls, 1);
  assert.deepEqual([...attempts.entries()], [
    ["first", 2],
    ["second", 2],
  ]);
});

test("retries an unavailable exclusive lifecycle lock before repairing", async () => {
  let lifecycleLockAttempts = 0;
  let ensureCalls = 0;
  const store = runtimeAccessStore({
    async withEnvironmentLifecycleLock(_environmentId, operation) {
      lifecycleLockAttempts += 1;
      if (lifecycleLockAttempts < 3) return { acquired: false as const };
      return { acquired: true as const, value: await operation() };
    },
  });
  const runtime = {
    async ensureEnvironmentRuntimeAccess() {
      ensureCalls += 1;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentRuntimeAccessService(store, runtime, {
    lockTimeoutMs: 100,
    lockRetryMs: 0,
  });
  let operationCalls = 0;

  assert.equal(
    await service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        operationCalls += 1;
        if (operationCalls === 1) {
          throw new Error("transport endpoint is not connected");
        }
        return "ready";
      },
    ),
    "ready",
  );
  assert.equal(lifecycleLockAttempts, 3);
  assert.equal(ensureCalls, 1);
  assert.equal(operationCalls, 2);
});

test("reports a busy lifecycle when repair cannot acquire the exclusive lock", async () => {
  let operationCalls = 0;
  let ensureCalls = 0;
  const store = runtimeAccessStore({
    async withEnvironmentLifecycleLock() {
      return { acquired: false as const };
    },
  });
  const runtime = {
    async ensureEnvironmentRuntimeAccess() {
      ensureCalls += 1;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentRuntimeAccessService(store, runtime, {
    lockTimeoutMs: 0,
    lockRetryMs: 0,
  });

  await assert.rejects(
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        operationCalls += 1;
        throw new HttpError(
          503,
          "sandbox0_workspace_unavailable",
          "Workspace unavailable.",
        );
      },
    ),
    (error: unknown) => {
      assert.equal((error as HttpError).statusCode, 503);
      assert.equal((error as HttpError).code, "environment_lifecycle_busy");
      return true;
    },
  );
  assert.equal(operationCalls, 1);
  assert.equal(ensureCalls, 0);
});

test("does not repair or record a failed non-recoverable access", async () => {
  let ensureCalls = 0;
  let accessRecords = 0;
  const store = runtimeAccessStore({
    async recordEnvironmentRuntimeAccess() {
      accessRecords += 1;
      return environmentRuntime;
    },
  });
  const runtime = {
    async ensureEnvironmentRuntimeAccess() {
      ensureCalls += 1;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentRuntimeAccessService(store, runtime);
  const error = new HttpError(404, "workspace_file_not_found", "Missing.");

  await assert.rejects(
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        throw error;
      },
    ),
    (thrown: unknown) => thrown === error,
  );
  assert.equal(ensureCalls, 0);
  assert.equal(accessRecords, 0);
});

test("rejects a terminated Environment before native access", async () => {
  let operationCalls = 0;
  let ensureCalls = 0;
  const store = runtimeAccessStore({
    runtime: {
      ...environmentRuntime,
      desiredState: "terminated",
    },
  });
  const runtime = {
    async ensureEnvironmentRuntimeAccess() {
      ensureCalls += 1;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentRuntimeAccessService(store, runtime);

  await assert.rejects(
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        operationCalls += 1;
      },
    ),
    (error: unknown) => {
      assert.equal((error as HttpError).statusCode, 409);
      assert.equal((error as HttpError).code, "environment_terminated");
      return true;
    },
  );
  assert.equal(operationCalls, 0);
  assert.equal(ensureCalls, 0);
});

test("waits for the shared runtime-access lock without holding a connection", async () => {
  let lockAttempts = 0;
  const store = runtimeAccessStore({
    async withEnvironmentRuntimeAccessLock(
      _environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      lockAttempts += 1;
      if (lockAttempts < 3) return { acquired: false as const };
      return { acquired: true as const, value: await operation() };
    },
  });
  const service = new EnvironmentRuntimeAccessService(
    store,
    {} as RuntimeAdapter,
    { lockTimeoutMs: 100, lockRetryMs: 0 },
  );

  assert.equal(
    await service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => "ready",
    ),
    "ready",
  );
  assert.equal(lockAttempts, 3);
});

test("reports a busy lifecycle when the shared lock deadline expires", async () => {
  const store = runtimeAccessStore({
    async withEnvironmentRuntimeAccessLock() {
      return { acquired: false as const };
    },
  });
  const service = new EnvironmentRuntimeAccessService(
    store,
    {} as RuntimeAdapter,
    { lockTimeoutMs: 0, lockRetryMs: 0 },
  );

  await assert.rejects(
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => "unreachable",
    ),
    (error: unknown) => {
      assert.equal((error as HttpError).statusCode, 503);
      assert.equal((error as HttpError).code, "environment_lifecycle_busy");
      return true;
    },
  );
});

test("records live runtime activity only while holding the shared lifecycle lock", async () => {
  let sharedDepth = 0;
  let touches = 0;
  const store = runtimeAccessStore({
    async withEnvironmentRuntimeAccessLock(_environmentId, operation) {
      sharedDepth += 1;
      try {
        return { acquired: true as const, value: await operation() };
      } finally {
        sharedDepth -= 1;
      }
    },
    async touchRunningEnvironmentActivity() {
      assert.equal(sharedDepth, 1);
      touches += 1;
      return true;
    },
  });
  const service = new EnvironmentRuntimeAccessService(
    store,
    {} as RuntimeAdapter,
  );

  assert.equal(
    await service.touchRunningRuntimeActivity(environmentRuntime.id),
    true,
  );
  assert.equal(touches, 1);
});

test("skips live runtime activity when lifecycle transition owns the lock", async () => {
  let touches = 0;
  const store = runtimeAccessStore({
    async withEnvironmentRuntimeAccessLock() {
      return { acquired: false as const };
    },
    async touchRunningEnvironmentActivity() {
      touches += 1;
      return true;
    },
  });
  const service = new EnvironmentRuntimeAccessService(
    store,
    {} as RuntimeAdapter,
  );

  assert.equal(
    await service.touchRunningRuntimeActivity(environmentRuntime.id),
    false,
  );
  assert.equal(touches, 0);
});

test("quota admission rejects a runtime operation while holding the shared lock", async () => {
  let operationCalls = 0;
  let quotaChecks = 0;
  const store = runtimeAccessStore();
  const service = new EnvironmentRuntimeAccessService(
    store,
    {} as RuntimeAdapter,
    {
      quotaGate: {
        async assertEnvironmentRuntimeAllowed(environmentId: string) {
          quotaChecks += 1;
          assert.equal(environmentId, environmentRuntime.id);
          throw new HttpError(
            429,
            "sandbox_runtime_quota_exhausted",
            "Runtime quota exhausted.",
          );
        },
      },
    },
  );

  await assert.rejects(
    service.withRuntimeAccess(
      "user-test",
      environmentRuntime.id,
      async () => {
        operationCalls += 1;
      },
    ),
    (error) =>
      error instanceof HttpError &&
      error.code === "sandbox_runtime_quota_exhausted",
  );

  assert.equal(quotaChecks, 1);
  assert.equal(operationCalls, 0);
});

function runtimeAccessStore(
  overrides: {
    runtime?: StoredEnvironmentRuntime;
    getEnvironmentRuntime?: () => Promise<StoredEnvironmentRuntime>;
    withEnvironmentRuntimeAccessLock?: (
      environmentId: string,
      operation: () => Promise<unknown>,
    ) => Promise<
      { acquired: false } | { acquired: true; value: unknown }
    >;
    withEnvironmentLifecycleLock?: (
      environmentId: string,
      operation: () => Promise<unknown>,
    ) => Promise<
      { acquired: false } | { acquired: true; value: unknown }
    >;
    recordEnvironmentRuntimeAccess?: (
      environmentId: string,
    ) => Promise<StoredEnvironmentRuntime>;
    touchRunningEnvironmentActivity?: (
      environmentId: string,
    ) => Promise<boolean>;
  } = {},
) {
  const current = overrides.runtime ?? environmentRuntime;
  return {
    async getEnvironment() {
      return {};
    },
    async getEnvironmentRuntime() {
      return overrides.getEnvironmentRuntime
        ? overrides.getEnvironmentRuntime()
        : current;
    },
    async withEnvironmentRuntimeAccessLock(
      environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      if (overrides.withEnvironmentRuntimeAccessLock) {
        return overrides.withEnvironmentRuntimeAccessLock(
          environmentId,
          operation,
        );
      }
      return { acquired: true as const, value: await operation() };
    },
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: () => Promise<unknown>,
    ) {
      if (overrides.withEnvironmentLifecycleLock) {
        return overrides.withEnvironmentLifecycleLock(
          environmentId,
          operation,
        );
      }
      return { acquired: true as const, value: await operation() };
    },
    async recordEnvironmentRuntimeAccess(environmentId: string) {
      return overrides.recordEnvironmentRuntimeAccess
        ? overrides.recordEnvironmentRuntimeAccess(environmentId)
        : current;
    },
    async touchRunningEnvironmentActivity(environmentId: string) {
      return overrides.touchRunningEnvironmentActivity
        ? overrides.touchRunningEnvironmentActivity(environmentId)
        : true;
    },
  } as unknown as SandpiStore;
}
