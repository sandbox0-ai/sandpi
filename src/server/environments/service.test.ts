import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore } from "@/server/store";
import {
  EnvironmentService,
  type EnvironmentNetworkPolicyApplier,
} from "./service";

const environment = {
  id: "env-test",
  ownerId: "user-test",
  visibility: "team",
  idlePauseTimeoutSeconds: 30 * 60,
  sandboxMemoryMiB: 2 * 1024,
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
    async recordEnvironmentAllocation() {},
    async markEnvironmentReady() {
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
    async withEnvironmentMcpMutationLock(
      _environmentId: string,
      operation: () => Promise<Environment>,
    ) {
      return {
        acquired: true as const,
        value: await operation(),
      };
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
    visibility: "team",
    idlePauseTimeoutSeconds: 30 * 60,
    sandboxMemoryMiB: 2 * 1024,
    networkPolicy: nextPolicy,
  });

  assert.deepEqual(applied, [nextPolicy]);
  assert.deepEqual(updated.networkPolicy, nextPolicy);
});

test("lets only the creator change a Team Environment's visibility", async () => {
  let updates = 0;
  const store = {
    async getManageableEnvironment() {
      return { ...environment, ownerId: "user-creator" };
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
    service.update("user-admin", environment.id, {
      name: "Development",
      description: "",
      color: "#151515",
      visibility: "private",
      idlePauseTimeoutSeconds: 30 * 60,
      sandboxMemoryMiB: 2 * 1024,
      networkPolicy: environment.networkPolicy,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_visibility_forbidden",
  );
  assert.equal(updates, 0);
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
    async withEnvironmentMcpMutationLock() {
      assert.fail("an idle timeout change must not take the MCP mutation lock");
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
    visibility: "team",
    idlePauseTimeoutSeconds: 0,
    sandboxMemoryMiB: 2 * 1024,
    networkPolicy: environment.networkPolicy,
  });

  assert.equal(updated.idlePauseTimeoutSeconds, 0);
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
    async withEnvironmentMcpMutationLock() {
      assert.fail("a memory change must not take the MCP mutation lock");
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
    visibility: "team",
    idlePauseTimeoutSeconds: 30 * 60,
    sandboxMemoryMiB: 4 * 1024,
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

test("network updates nest lifecycle locking through the MCP-scoped Store", async () => {
  const steps: string[] = [];
  const nextPolicy: Environment["networkPolicy"] = {
    mode: "block-all",
    domainExceptions: ["github.com"],
  };
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
  let mutationLockActive = false;
  let lifecycleLockActive = false;
  const lifecycleStore = {
    async getManageableEnvironment(userId: string, environmentId: string) {
      assert.equal(userId, "user-test");
      assert.equal(environmentId, environment.id);
      assert.equal(mutationLockActive, true);
      assert.equal(lifecycleLockActive, true);
      steps.push("L-read-environment");
      return environment;
    },
    async getEnvironmentRuntime(userId: string, environmentId: string) {
      assert.equal(userId, "user-test");
      assert.equal(environmentId, environment.id);
      assert.equal(mutationLockActive, true);
      assert.equal(lifecycleLockActive, true);
      steps.push("L-read-runtime");
      return runtimeRecord;
    },
    async updateEnvironment(
      userId: string,
      environmentId: string,
      input: {
        name: string;
        description: string;
        color: string;
        visibility: Environment["visibility"];
        idlePauseTimeoutSeconds: number;
        sandboxMemoryMiB: number;
        networkPolicy: Environment["networkPolicy"];
      },
    ) {
      assert.equal(userId, "user-test");
      assert.equal(environmentId, environment.id);
      assert.equal(mutationLockActive, true);
      assert.equal(lifecycleLockActive, true);
      steps.push("L-write");
      return { ...environment, ...input };
    },
  } as unknown as SandpiStore;
  const mutationStore = {
    async withEnvironmentLifecycleLock(
      environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      assert.equal(environmentId, environment.id);
      assert.equal(mutationLockActive, true);
      steps.push("L");
      lifecycleLockActive = true;
      try {
        return {
          acquired: true as const,
          value: await operation(lifecycleStore),
        };
      } finally {
        lifecycleLockActive = false;
      }
    },
    async getManageableEnvironment() {
      assert.fail("network reads must use the lifecycle-scoped Store");
    },
    async getEnvironmentRuntime() {
      assert.fail("runtime reads must use the lifecycle-scoped Store");
    },
    async updateEnvironment() {
      assert.fail("network writes must use the lifecycle-scoped Store");
    },
  } as unknown as SandpiStore;
  const rootStore = {
    async getManageableEnvironment() {
      steps.push("root-read");
      return environment;
    },
    async withEnvironmentMcpMutationLock(
      environmentId: string,
      operation: (lockedStore: SandpiStore) => Promise<Environment>,
    ) {
      assert.equal(environmentId, environment.id);
      assert.equal(mutationLockActive, false);
      steps.push("M");
      mutationLockActive = true;
      try {
        return {
          acquired: true as const,
          value: await operation(mutationStore),
        };
      } finally {
        mutationLockActive = false;
      }
    },
    async withEnvironmentLifecycleLock() {
      assert.fail("lifecycle lock must be acquired through the MCP-scoped Store");
    },
  } as unknown as SandpiStore;
  const runtime = {
    async updateEnvironmentNetworkPolicy(
      received: unknown,
      policy: Environment["networkPolicy"],
    ) {
      assert.strictEqual(received, runtimeRecord);
      assert.strictEqual(policy, nextPolicy);
      assert.equal(mutationLockActive, true);
      assert.equal(lifecycleLockActive, true);
      steps.push("apply");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentService(rootStore, runtime, {
    info() {},
    error() {},
  });

  const updated = await service.update("user-test", environment.id, {
    name: "Development",
    description: "",
    color: "#151515",
    visibility: "team",
    idlePauseTimeoutSeconds: 30 * 60,
    sandboxMemoryMiB: 2 * 1024,
    networkPolicy: nextPolicy,
  });

  assert.deepEqual(steps, [
    "root-read",
    "M",
    "L",
    "L-read-environment",
    "L-read-runtime",
    "apply",
    "L-write",
  ]);
  assert.deepEqual(updated.networkPolicy, nextPolicy);
});

test("uses the injected network policy applier instead of the legacy runtime method", async () => {
  const nextPolicy: Environment["networkPolicy"] = {
    mode: "block-all",
    domainExceptions: ["api.githubcopilot.com"],
  };
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
      return environment;
    },
    async withEnvironmentMcpMutationLock(
      _environmentId: string,
      operation: () => Promise<Environment>,
    ) {
      return {
        acquired: true as const,
        value: await operation(),
      };
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
      return runtimeRecord;
    },
    async updateEnvironment() {
      return { ...environment, networkPolicy: nextPolicy };
    },
  } as unknown as SandpiStore;
  let legacyCalls = 0;
  const runtime = {
    async updateEnvironmentNetworkPolicy() {
      legacyCalls += 1;
    },
  } as unknown as RuntimeAdapter;
  const applied: Parameters<EnvironmentNetworkPolicyApplier>[0][] = [];
  const service = new EnvironmentService(
    store,
    runtime,
    {
      info() {},
      error() {},
    },
    async (input) => {
      applied.push(input);
    },
  );

  const updated = await service.update("user-test", environment.id, {
    name: "Development",
    description: "",
    color: "#151515",
    visibility: "team",
    idlePauseTimeoutSeconds: 30 * 60,
    sandboxMemoryMiB: 2 * 1024,
    networkPolicy: nextPolicy,
  });

  assert.equal(legacyCalls, 0);
  assert.deepEqual(applied, [
    {
      userId: "user-test",
      environmentId: environment.id,
      runtime: runtimeRecord,
      userPolicy: nextPolicy,
    },
  ]);
  assert.deepEqual(updated.networkPolicy, nextPolicy);
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
    async withEnvironmentMcpMutationLock(
      _environmentId: string,
      operation: () => Promise<Environment>,
    ) {
      return { acquired: true as const, value: await operation() };
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
      visibility: "team",
      idlePauseTimeoutSeconds: 30 * 60,
      sandboxMemoryMiB: 2 * 1024,
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

  await service.delete("user-test", environment.id);

  assert.deepEqual(steps, [
    "lock",
    "prepare",
    "workers",
    "lock",
    "prepare",
    "resources",
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
