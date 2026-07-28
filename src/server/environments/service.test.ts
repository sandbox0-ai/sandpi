import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore } from "@/server/store";
import { EnvironmentService } from "./service";

const environment = {
  id: "env-test",
  ownerId: "user-test",
  idlePauseTimeoutSeconds: 30 * 60,
  sandboxMemoryMiB: 2 * 1024,
  runtimeConfig: {
    status: "applied",
    desiredGeneration: 1,
    appliedGeneration: 1,
    appliedSandboxMemoryMiB: 2 * 1024,
  },
  workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
  status: "ready",
  networkPolicy: {
    mode: "allow-all",
    domainExceptions: [],
  },
} as unknown as Environment;

test("pending Environment reconciliation is coalesced within one server", async () => {
  let releaseProvisioning!: () => void;
  const provisioningGate = new Promise<void>((resolve) => {
    releaseProvisioning = resolve;
  });
  let listCalls = 0;
  let provisionCalls = 0;
  let readyCalls = 0;
  const store = {
    async environmentsNeedingProvisioning() {
      listCalls += 1;
      return listCalls === 1 ? [environment] : [{ ...environment, id: "env-second" }];
    },
    async getEnvironmentById(environmentId: string) {
      return { ...environment, id: environmentId };
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [];
    },
    async recordEnvironmentAllocation() {},
    async markEnvironmentReady(
      _environmentId: string,
      _resources: unknown,
      appliedConfig: { generation: number; sandboxMemoryMiB: number },
    ) {
      assert.deepEqual(appliedConfig, {
        generation: 1,
        sandboxMemoryMiB: 2 * 1024,
      });
      readyCalls += 1;
      return environment;
    },
  } as unknown as SandpiStore;
  const runtime = {
    async provisionEnvironment() {
      provisionCalls += 1;
      await provisioningGate;
      return {
        sandboxId: `sandbox-${provisionCalls}`,
        workspaceVolumeId: "volume-test",
        desiredState: "running",
      };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  });

  const first = service.reconcilePending();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = service.reconcilePending();
  assert.strictEqual(first, second);
  releaseProvisioning();
  await Promise.all([first, second]);

  assert.equal(listCalls, 2);
  assert.equal(provisionCalls, 2);
  assert.equal(readyCalls, 2);
});

test("persists network intent and starts reconciliation without waiting for Sandbox0", async () => {
  const steps: string[] = [];
  const nextPolicy: Environment["networkPolicy"] = {
    mode: "block-all",
    domainExceptions: ["github.com"],
  };
  const pending = {
    ...environment,
    networkPolicy: nextPolicy,
    runtimeConfig: {
      ...environment.runtimeConfig,
      status: "applying" as const,
      desiredGeneration: 2,
    },
  };
  const store = {
    async getManageableEnvironment() {
      steps.push("read");
      return environment;
    },
    async updateEnvironment() {
      steps.push("persist");
      return pending;
    },
  } as unknown as SandpiStore;
  const runtime = {
    async updateEnvironmentNetworkPolicy() {
      assert.fail("the request path must not call Sandbox0");
    },
    async updateEnvironmentMemory() {
      assert.fail("the request path must not call Sandbox0");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  });
  service.setRuntimeConfigReconciler(() => {
    steps.push("reconcile");
    return new Promise<void>(() => undefined);
  });

  const updated = await service.update("user-test", environment.id, {
    name: "Development",
    description: "",
    color: "#151515",
    idlePauseTimeoutSeconds: 30 * 60,
    sandboxMemoryMiB: 2 * 1024,
    workspaceBackup: environment.workspaceBackup,
    networkPolicy: nextPolicy,
  });

  assert.deepEqual(updated.networkPolicy, nextPolicy);
  assert.equal(updated.runtimeConfig.status, "applying");
  assert.deepEqual(steps, ["read", "persist", "reconcile"]);
});

test("persists an idle timeout without scheduling runtime configuration", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      steps.push("read");
      return environment;
    },
    async updateEnvironment(
      _userId: string,
      _environmentId: string,
      input: Environment,
    ) {
      steps.push("write");
      return { ...environment, ...input };
    },
  } as unknown as SandpiStore;
  const service = new EnvironmentService(
    store,
    {
      async updateEnvironmentNetworkPolicy() {
        assert.fail("an unchanged network policy must not be reapplied");
      },
    } as unknown as RuntimeAdapter,
    { info() {}, error() {} },
  );
  service.setRuntimeConfigReconciler(() => {
    steps.push("reconcile");
  });

  const updated = await service.update("user-test", environment.id, {
    name: "Development",
    description: "",
    color: "#151515",
    idlePauseTimeoutSeconds: 0,
    sandboxMemoryMiB: 2 * 1024,
    workspaceBackup: environment.workspaceBackup,
    networkPolicy: environment.networkPolicy,
  });

  assert.equal(updated.idlePauseTimeoutSeconds, 0);
  assert.deepEqual(steps, ["read", "write"]);
});

test("persists a Workspace backup policy without mutating Sandbox resources", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      steps.push("read");
      return environment;
    },
    async updateEnvironment(
      _userId: string,
      _environmentId: string,
      input: Environment,
    ) {
      steps.push("write");
      return { ...environment, ...input };
    },
  } as unknown as SandpiStore;
  const runtime = {
    async updateEnvironmentNetworkPolicy() {
      assert.fail("an unchanged network policy must not be reapplied");
    },
    async updateEnvironmentMemory() {
      assert.fail("an unchanged memory limit must not be reapplied");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  });

  const updated = await service.update("user-test", environment.id, {
    name: "Development",
    description: "",
    color: "#151515",
    idlePauseTimeoutSeconds: 30 * 60,
    sandboxMemoryMiB: 2 * 1024,
    workspaceBackup: { intervalSeconds: 86_400, retentionCount: 3 },
    networkPolicy: environment.networkPolicy,
  });

  assert.deepEqual(updated.workspaceBackup, {
    intervalSeconds: 86_400,
    retentionCount: 3,
  });
  assert.deepEqual(steps, ["read", "write"]);
});

test("persists a memory change as desired state after checking entitlement", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      steps.push("read");
      return environment;
    },
    async updateEnvironment(
      _userId: string,
      _environmentId: string,
      input: Environment,
    ) {
      steps.push("write");
      return {
        ...environment,
        ...input,
        runtimeConfig: {
          ...environment.runtimeConfig,
          status: "applying" as const,
          desiredGeneration: 2,
        },
      };
    },
  } as unknown as SandpiStore;
  const runtime = {
    async updateEnvironmentNetworkPolicy() {
      assert.fail("an unchanged network policy must not be reapplied");
    },
    async updateEnvironmentMemory(received: unknown, memoryMiB: number) {
      assert.fail(
        `the request path must not resize Sandbox0: ${String(received)} ${memoryMiB}`,
      );
    },
  } as unknown as RuntimeAdapter;
  const quota = {
    async environmentLimit() {
      return 1;
    },
    async assertMemoryConfigurationAllowed(
      _userId: string,
      currentMemoryMiB: number,
      requestedMemoryMiB: number,
    ) {
      assert.equal(currentMemoryMiB, 2 * 1024);
      assert.equal(requestedMemoryMiB, 4 * 1024);
      steps.push("quota");
    },
  };
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  }, quota);
  service.setRuntimeConfigReconciler(() => {
    steps.push("reconcile");
  });

  const updated = await service.update("user-test", environment.id, {
    name: "Development",
    description: "",
    color: "#151515",
    idlePauseTimeoutSeconds: 30 * 60,
    sandboxMemoryMiB: 4 * 1024,
    workspaceBackup: environment.workspaceBackup,
    networkPolicy: environment.networkPolicy,
  });

  assert.equal(updated.sandboxMemoryMiB, 4 * 1024);
  assert.equal(updated.runtimeConfig.status, "applying");
  assert.deepEqual(steps, ["read", "quota", "write", "reconcile"]);
});

test("rejects a disallowed memory change before persisting desired state", async () => {
  let quotaChecks = 0;
  let writes = 0;
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async updateEnvironment() {
      writes += 1;
      return environment;
    },
  } as unknown as SandpiStore;
  const quota = {
    async environmentLimit() {
      return 1;
    },
    async assertMemoryConfigurationAllowed() {
      quotaChecks += 1;
      throw new Error("plan changed");
    },
  };
  const service = new EnvironmentService(
    store,
    {} as RuntimeAdapter,
    { info() {}, error() {} },
    quota,
  );

  await assert.rejects(
    service.update("user-test", environment.id, {
      name: "Development",
      description: "",
      color: "#151515",
      idlePauseTimeoutSeconds: 30 * 60,
      sandboxMemoryMiB: 4 * 1024,
      workspaceBackup: environment.workspaceBackup,
      networkPolicy: environment.networkPolicy,
    }),
    /plan changed/,
  );

  assert.equal(quotaChecks, 1);
  assert.equal(writes, 0);
});

test("rejects network policy changes after the Environment deletion gate", async () => {
  const nextPolicy: Environment["networkPolicy"] = {
    mode: "block-all",
    domainExceptions: [],
  };
  let updates = 0;
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async updateEnvironment() {
      updates += 1;
      throw Object.assign(new Error("The Environment is being deleted."), {
        code: "environment_terminated",
      });
    },
  } as unknown as SandpiStore;
  const service = new EnvironmentService(
    store,
    {} as RuntimeAdapter,
    { info() {}, error() {} },
  );

  await assert.rejects(
    service.update("user-test", environment.id, {
      name: "Development",
      description: "",
      color: "#151515",
      idlePauseTimeoutSeconds: 30 * 60,
      sandboxMemoryMiB: 2 * 1024,
      workspaceBackup: environment.workspaceBackup,
      networkPolicy: nextPolicy,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_terminated",
  );
  assert.equal(updates, 1);
});

test("deletes Environment-owned resources before removing metadata", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<void>,
    ) {
      steps.push("lock");
      await operation();
      return { acquired: true as const, value: undefined };
    },
    async prepareEnvironmentDeletion() {
      steps.push("prepare");
      return {
        sandboxId: "sandbox-test",
        workspaceVolumeId: "volume-test",
        rootfsSnapshotId: "snapshot-test",
      };
    },
    async deleteEnvironmentMetadata() {
      steps.push("metadata");
    },
    async recordEnvironmentDeletionFailure() {
      steps.push("failure");
    },
  } as unknown as SandpiStore;
  const runtime = {
    async deleteEnvironmentResources(resources: {
      sandboxId?: string;
      workspaceVolumeId?: string;
      rootfsSnapshotId?: string;
    }) {
      assert.deepEqual(resources, {
        sandboxId: "sandbox-test",
        workspaceVolumeId: "volume-test",
        rootfsSnapshotId: "snapshot-test",
      });
      steps.push("resources");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {
      steps.push("logged");
    },
    error() {},
  });
  service.setBeforeDelete(() => {
    steps.push("workers");
  });
  service.setAfterRuntimeDelete(() => {
    steps.push("credential-sources");
  });

  await service.delete("user-test", environment.id);

  assert.deepEqual(steps, [
    "lock",
    "prepare",
    "workers",
    "lock",
    "prepare",
    "resources",
    "credential-sources",
    "metadata",
    "logged",
  ]);
});

test("publishes the deletion gate before Environment-owned cleanup", async () => {
  let deletionPrepared = false;
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<void>,
    ) {
      await operation();
      return { acquired: true as const, value: undefined };
    },
    async prepareEnvironmentDeletion() {
      deletionPrepared = true;
      return {};
    },
    async deleteEnvironmentMetadata() {},
    async recordEnvironmentDeletionFailure() {},
  } as unknown as SandpiStore;
  const runtime = {
    async deleteEnvironmentResources() {},
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  });
  service.setBeforeDelete(() => {
    assert.equal(deletionPrepared, true);
  });

  await service.delete("user-test", environment.id);
});

test("keeps the terminal gate when Environment-owned cleanup fails", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<void>,
    ) {
      steps.push("lock");
      await operation();
      return { acquired: true as const, value: undefined };
    },
    async prepareEnvironmentDeletion() {
      steps.push("prepare");
      return {};
    },
    async recordEnvironmentDeletionFailure(
      _environmentId: string,
      message: string,
    ) {
      steps.push(`failure:${message}`);
    },
  } as unknown as SandpiStore;
  const service = new EnvironmentService(
    store,
    {} as RuntimeAdapter,
    { info() {}, error() {} },
  );
  service.setBeforeDelete(() => {
    steps.push("cleanup");
    throw new Error("credential cleanup failed");
  });

  await assert.rejects(
    service.delete("user-test", environment.id),
    /credential cleanup failed/,
  );
  assert.deepEqual(steps, [
    "lock",
    "prepare",
    "cleanup",
    "failure:credential cleanup failed",
  ]);
});

test("keeps Environment metadata retryable when resource deletion fails", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: () => Promise<void>,
    ) {
      await operation();
      return { acquired: true as const, value: undefined };
    },
    async prepareEnvironmentDeletion() {
      return { sandboxId: "sandbox-test", workspaceVolumeId: "volume-test" };
    },
    async deleteEnvironmentMetadata() {
      steps.push("metadata");
    },
    async recordEnvironmentDeletionFailure(_environmentId: string, error: string) {
      steps.push(`failure:${error}`);
    },
  } as unknown as SandpiStore;
  const runtime = {
    async deleteEnvironmentResources() {
      throw new Error("volume cleanup failed");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  });

  await assert.rejects(
    service.delete("user-test", environment.id),
    /volume cleanup failed/,
  );
  assert.deepEqual(steps, ["failure:volume cleanup failed"]);
});

test("checks runtime quota before provisioning Sandbox0 resources", async () => {
  const failures: string[] = [];
  const store = {
    async environmentsNeedingProvisioning() {
      return [environment];
    },
    async getEnvironmentById() {
      return environment;
    },
    async markEnvironmentFailed(_environmentId: string, error: string) {
      failures.push(error);
    },
  } as unknown as SandpiStore;
  const runtime = {
    async provisionEnvironment() {
      assert.fail("quota-blocked provisioning must not call Sandbox0");
    },
  } as unknown as RuntimeAdapter;
  const runtimeQuotaGate = {
    async assertEnvironmentRuntimeAllowed(environmentId: string) {
      assert.equal(environmentId, environment.id);
      throw new Error("runtime quota exhausted");
    },
  };
  const service = new EnvironmentService(
    store,
    runtime,
    { info() {}, error() {} },
    undefined,
    runtimeQuotaGate,
  );

  await service.reconcilePending();

  assert.deepEqual(failures, ["runtime quota exhausted"]);
});
