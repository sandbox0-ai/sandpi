import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type {
  EnvironmentForkOperation,
  SandpiStore,
} from "@/server/store";
import { EnvironmentForkService } from "./fork-service";

const source = {
  id: "env-source",
  ownerId: "user-test",
  name: "Source",
  status: "ready",
  sandboxId: "sandbox-source",
  sandboxMemoryMiB: 4096,
  networkPolicy: { mode: "allow-all", domainExceptions: [] },
} as unknown as Environment;

const target = {
  ...source,
  id: "env-target",
  name: "Source fork",
  sandboxId: "sandbox-target",
  sandboxState: "paused",
} as Environment;

test("forks one paused Sandbox idempotently and strips inherited credentials", async () => {
  const steps: string[] = [];
  let operation: EnvironmentForkOperation | undefined;
  let completedIdempotency = false;
  const store = {
    async getManageableEnvironment(_userId: string, environmentId: string) {
      return environmentId === source.id ? source : target;
    },
    async getEnvironment(_userId: string, environmentId: string) {
      assert.equal(environmentId, target.id);
      return target;
    },
    async claimIdempotentResource() {
      return {
        claimed: true,
        status: "processing" as const,
        resourceId: target.id,
      };
    },
    async withEnvironmentLifecycleLock(
      environmentId: string,
      callback: (scoped: SandpiStore) => Promise<Environment>,
    ) {
      assert.equal(environmentId, source.id);
      return {
        acquired: true as const,
        value: await callback(store as unknown as SandpiStore),
      };
    },
    async getEnvironmentForkOperation() {
      if (!operation) {
        throw new HttpError(
          404,
          "environment_fork_not_found",
          "Environment fork operation not found.",
        );
      }
      return operation;
    },
    async createEnvironmentForkTarget(input: {
      operationId: string;
      sourceEnvironmentId: string;
      targetEnvironmentId: string;
      sourceSnapshotId?: string;
      environmentLimit?: number | null;
    }) {
      assert.equal(input.sourceEnvironmentId, source.id);
      assert.equal(input.targetEnvironmentId, target.id);
      assert.equal(input.sourceSnapshotId, "snapshot-source");
      assert.equal(input.environmentLimit, 4);
      operation = {
        sourceEnvironmentId: source.id,
        sourceSnapshotId: input.sourceSnapshotId,
        targetEnvironmentId: target.id,
        operationId: input.operationId,
        phase: "prepared",
      };
      steps.push("metadata");
      return operation;
    },
    async getEnvironmentRuntime(_userId: string, environmentId: string) {
      if (environmentId === source.id) {
        return {
          id: source.id,
          sandboxId: source.sandboxId,
          runtimeGeneration: 7,
          decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 7 },
        };
      }
      return {
        id: target.id,
        sandboxId: target.sandboxId,
        runtimeGeneration: 0,
        decoder: { supervisorCursor: 0, tailBase64: "", runtimeGeneration: 0 },
      };
    },
    async markEnvironmentForkStarted() {
      steps.push("started");
      operation = { ...operation!, phase: "forking" };
    },
    async recordEnvironmentForkSandbox(
      _environmentId: string,
      sandboxId: string,
      runtimeGeneration: number,
    ) {
      assert.equal(sandboxId, target.sandboxId);
      assert.equal(runtimeGeneration, 0);
      steps.push("native-ready");
      operation = {
        ...operation!,
        sandboxId,
        phase: "native-ready",
      };
    },
    async completeEnvironmentFork() {
      steps.push("completed");
      operation = { ...operation!, phase: "completed" };
    },
    async completeIdempotentResource() {
      completedIdempotency = true;
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0" as const,
    async forkEnvironment(input: {
      operationId: string;
      sourceSnapshotId?: string;
    }) {
      assert.match(input.operationId, /^sandpi-environment-fork-env-target$/);
      assert.equal(input.sourceSnapshotId, "snapshot-source");
      steps.push("fork");
      return { sandboxId: target.sandboxId, runtimeGeneration: 0 };
    },
    async updateEnvironmentNetworkPolicy(
      _runtime: unknown,
      policy: Environment["networkPolicy"],
      credentials: unknown[],
    ) {
      assert.deepEqual(policy, source.networkPolicy);
      assert.deepEqual(credentials, []);
      steps.push("network");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentForkService(
    store,
    runtime,
    { info() {}, warn() {} },
    {
      async environmentCreationPolicy() {
        return { environmentLimit: 4, fixedSandboxMemoryMiB: null };
      },
      async assertMemoryConfigurationAllowed() {},
    },
  );

  const created = await service.create({
    userId: "user-test",
    sourceEnvironmentId: source.id,
    sourceSnapshotId: "snapshot-source",
    name: target.name,
    idempotencyKey: "fork-idempotency-key-1",
  });

  assert.equal(created.id, target.id);
  assert.deepEqual(steps, [
    "metadata",
    "started",
    "fork",
    "native-ready",
    "network",
    "completed",
  ]);
  assert.equal(completedIdempotency, true);
});
