import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore } from "@/server/store";
import { EnvironmentService } from "./service";

const environment = {
  id: "env-test",
  status: "ready",
  networkPolicy: {
    mode: "allow-all",
    allowedDomains: [],
    logDeniedRequests: true,
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
    mode: "restricted",
    allowedDomains: ["github.com"],
    logDeniedRequests: true,
  };
  const store = {
    async getEnvironment() {
      return environment;
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
    networkPolicy: nextPolicy,
  });

  assert.deepEqual(applied, [nextPolicy]);
  assert.deepEqual(updated.networkPolicy, nextPolicy);
});
