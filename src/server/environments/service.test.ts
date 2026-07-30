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
  workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
  status: "ready",
  networkPolicy: {
    mode: "allow-all",
    domainExceptions: [],
  },
} as unknown as Environment;

test("returns ready Environment lifecycle state from Sandbox0 instead of PostgreSQL", async () => {
  const stored = {
    ...environment,
    sandboxId: "sandbox-test",
    sandboxState: "running",
  };
  const bootstrap = {
    environments: [stored],
  } as unknown as Awaited<ReturnType<SandpiStore["getBootstrap"]>>;
  const store = {
    async listEnvironments() {
      return [stored];
    },
    async getBootstrap() {
      return bootstrap;
    },
  } as unknown as SandpiStore;
  const reads: string[] = [];
  const runtime = {
    async getEnvironmentSandboxState(sandboxId: string) {
      reads.push(sandboxId);
      return "paused" as const;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  });

  assert.equal((await service.list("user-test"))[0]?.sandboxState, "paused");
  assert.equal(
    (
      await service.getBootstrap(
        "user-test",
        {} as Parameters<SandpiStore["getBootstrap"]>[1],
      )
    ).environments[0]?.sandboxState,
    "paused",
  );
  assert.deepEqual(reads, ["sandbox-test", "sandbox-test"]);
  assert.equal(stored.sandboxState, "running");
});

test("pending Environment reconciliation is coalesced within one server", async () => {
  let releaseProvisioning!: () => void;
  const provisioningGate = new Promise<void>((resolve) => {
    releaseProvisioning = resolve;
  });
  let listCalls = 0;
  let provisionCalls = 0;
  let readyCalls = 0;
  const pendingEnvironment = {
    ...environment,
    status: "updating" as const,
    sandboxId: "",
    workspaceVolumeId: "",
  };
  const store = {
    async environmentsNeedingProvisioning() {
      listCalls += 1;
      return listCalls === 1
        ? [pendingEnvironment]
        : [{ ...pendingEnvironment, id: "env-second" }];
    },
    async getEnvironmentById(environmentId: string) {
      return { ...pendingEnvironment, id: environmentId };
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [];
    },
    async recordEnvironmentAllocation() {},
    async markEnvironmentReady() {
      readyCalls += 1;
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
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

test("rechecks a stale provisioning candidate after taking the lifecycle lock", async () => {
  let provisionCalls = 0;
  const store = {
    async environmentsNeedingProvisioning() {
      return [{ ...environment, status: "updating" }];
    },
    async getEnvironmentById() {
      return {
        ...environment,
        status: "ready",
        sandboxId: "sandbox-winner",
        workspaceVolumeId: "volume-winner",
      };
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
  } as unknown as SandpiStore;
  const runtime = {
    async provisionEnvironment() {
      provisionCalls += 1;
      throw new Error("must not provision a stale candidate");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(store, runtime, {
    info() {},
    error() {},
  });

  await service.reconcilePending();

  assert.equal(provisionCalls, 0);
});

test("applies a changed network policy to the shared Environment Sandbox", async () => {
  const applied: Environment["networkPolicy"][] = [];
  const nextPolicy: Environment["networkPolicy"] = {
    mode: "block-all",
    domainExceptions: ["github.com"],
  };
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async getEnvironmentRuntime() {
      return {
        id: environment.id,
        sandboxId: "sandbox-test",
        workspaceVolumeId: "volume-test",
        runtimeGeneration: 1,
        decoder: {
          supervisorCursor: 0,
          tailBase64: "",
          runtimeGeneration: 1,
        },
      };
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [];
    },
    async updateEnvironment() {
      return { ...environment, networkPolicy: nextPolicy };
    },
  } as unknown as SandpiStore;
  const runtime = {
    async updateEnvironmentNetworkPolicy(
      _runtime: unknown,
      policy: Environment["networkPolicy"],
    ) {
      applied.push(policy);
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
    workspaceBackup: environment.workspaceBackup,
    networkPolicy: nextPolicy,
  });

  assert.deepEqual(applied, [nextPolicy]);
  assert.deepEqual(updated.networkPolicy, nextPolicy);
});

test("serializes an idle timeout change with Environment lifecycle transitions", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      steps.push("read");
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      steps.push("lifecycle-lock");
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async getEnvironmentRuntime() {
      assert.fail("an idle timeout change does not need a runtime policy apply");
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
  assert.deepEqual(steps, ["read", "lifecycle-lock", "read", "write"]);
});

test("serializes a Workspace backup policy change without mutating Sandbox resources", async () => {
  const steps: string[] = [];
  const store = {
    async getManageableEnvironment() {
      steps.push("read");
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      steps.push("lifecycle-lock");
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async getEnvironmentRuntime() {
      assert.fail("backup policy persistence does not mutate Sandbox resources");
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
  assert.deepEqual(steps, ["read", "lifecycle-lock", "read", "write"]);
});

test("applies a memory change to the shared Sandbox under the lifecycle lock", async () => {
  const steps: string[] = [];
  const runtimeRecord = {
    id: environment.id,
    sandboxId: "sandbox-test",
    workspaceVolumeId: "volume-test",
    desiredState: "running",
    runtimeGeneration: 1,
    decoder: {
      supervisorCursor: 0,
      tailBase64: "",
      runtimeGeneration: 1,
    },
  };
  const store = {
    async getManageableEnvironment() {
      steps.push("read");
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      steps.push("lifecycle-lock");
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async getEnvironmentRuntime() {
      steps.push("runtime");
      return runtimeRecord;
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
    async updateEnvironmentMemory(received: unknown, memoryMiB: number) {
      assert.strictEqual(received, runtimeRecord);
      assert.equal(memoryMiB, 4 * 1024);
      steps.push("memory");
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
    sandboxMemoryMiB: 4 * 1024,
    workspaceBackup: environment.workspaceBackup,
    networkPolicy: environment.networkPolicy,
  });

  assert.equal(updated.sandboxMemoryMiB, 4 * 1024);
  assert.deepEqual(steps, [
    "read",
    "lifecycle-lock",
    "read",
    "runtime",
    "memory",
    "write",
  ]);
});

test("rechecks the memory entitlement after acquiring the lifecycle lock", async () => {
  let quotaChecks = 0;
  let runtimeUpdates = 0;
  let writes = 0;
  const store = {
    async getManageableEnvironment() {
      return environment;
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async getEnvironmentRuntime() {
      return { desiredState: "running" };
    },
    async updateEnvironment() {
      writes += 1;
      return environment;
    },
  } as unknown as SandpiStore;
  const runtime = {
    async updateEnvironmentMemory() {
      runtimeUpdates += 1;
    },
  } as unknown as RuntimeAdapter;
  const quota = {
    async environmentLimit() {
      return 1;
    },
    async assertMemoryConfigurationAllowed() {
      quotaChecks += 1;
      if (quotaChecks === 2) throw new Error("plan changed");
    },
  };
  const service = new EnvironmentService(
    store,
    runtime,
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

  assert.equal(quotaChecks, 2);
  assert.equal(runtimeUpdates, 0);
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
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
    },
    async getEnvironmentRuntime() {
      return { desiredState: "terminated" };
    },
    async updateEnvironment() {
      updates += 1;
      return environment;
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
  assert.equal(updates, 0);
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
  const pendingEnvironment = {
    ...environment,
    status: "updating" as const,
    sandboxId: "",
    workspaceVolumeId: "",
  };
  const store = {
    async environmentsNeedingProvisioning() {
      return [pendingEnvironment];
    },
    async getEnvironmentById() {
      return pendingEnvironment;
    },
    async markEnvironmentFailed(_environmentId: string, error: string) {
      failures.push(error);
    },
    async withEnvironmentLifecycleLock(
      _environmentId: string,
      operation: (store: SandpiStore) => Promise<unknown>,
    ) {
      return {
        acquired: true as const,
        value: await operation(store as unknown as SandpiStore),
      };
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
