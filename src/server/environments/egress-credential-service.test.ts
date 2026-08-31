import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@/lib/types";
import type {
  RuntimeAdapter,
  RuntimeEnvironmentEgressCredential,
} from "@/server/runtime/types";
import type {
  SandpiStore,
  StoredEnvironmentEgressCredential,
} from "@/server/store";
import { EnvironmentEgressCredentialService } from "./egress-credential-service";

const environment = {
  id: "env-one",
  ownerId: "user-one",
  status: "ready",
  networkPolicy: { mode: "block-all", domainExceptions: [] },
} as unknown as Environment;

const runtimeRecord = {
  id: environment.id,
  sandboxId: "sandbox-one",
  runtimeGeneration: 1,
  decoder: {
    supervisorCursor: 0,
    tailBase64: "",
    runtimeGeneration: 1,
  },
};

const configuration = {
  name: "GitHub API",
  resolverKind: "static_headers" as const,
  projection: {
    type: "http_headers" as const,
    headers: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{ .secret }}",
      },
    ],
  },
  rule: {
    protocol: "https" as const,
    domains: ["api.github.com"],
    ports: [{ port: 443, protocol: "tcp" as const }],
    failurePolicy: "fail-closed" as const,
  },
  enabled: true,
};

const logger = {
  info() {},
  warn() {},
};

test("returns one secret-free Environment credential projection", async () => {
  const store = {
    async getEnvironmentEgressCredential(
      userId: string,
      environmentId: string,
      credentialId: string,
    ) {
      assert.equal(userId, "user-one");
      assert.equal(environmentId, environment.id);
      assert.equal(credentialId, "credential-one");
      return {
        id: credentialId,
        environmentId,
        sourceRef: "sandpi-credential-one",
        ...configuration,
        status: "active",
        currentVersion: 2,
        createdAt: 1,
        updatedAt: 2,
      };
    },
  } as unknown as SandpiStore;
  const service = new EnvironmentEgressCredentialService(
    store,
    {} as RuntimeAdapter,
    logger,
  );

  const result = await service.get(
    "user-one",
    environment.id,
    "credential-one",
  );

  assert.equal(result.id, "credential-one");
  assert.equal(result.currentVersion, 2);
  assert.equal("sourceRef" in result, false);
  assert.equal(JSON.stringify(result).includes("sandpi-credential-one"), false);
});

test("creates a server-namespaced source and returns no sourceRef or secret", async () => {
  let stored: StoredEnvironmentEgressCredential | undefined;
  const applied: RuntimeEnvironmentEgressCredential[][] = [];
  const scopedStore = {
    async getManageableEnvironment() {
      return environment;
    },
    async createEnvironmentEgressCredential(
      environmentId: string,
      input: typeof configuration & { id: string; sourceRef: string },
    ) {
      assert.equal(environmentId, environment.id);
      assert.match(input.id, /^credential_/);
      assert.equal(input.sourceRef, `sandpi-${input.id}`);
      stored = {
        ...input,
        environmentId,
        status: "provisioning",
        createdAt: 1,
        updatedAt: 1,
      };
      return stored;
    },
    async recordEnvironmentEgressCredentialSource(
      _environmentId: string,
      _credentialId: string,
      metadata: { currentVersion?: number; status?: string },
    ) {
      stored = {
        ...stored!,
        currentVersion: metadata.currentVersion,
        sourceStatus: metadata.status,
      };
    },
    async recordEnvironmentEgressCredentialStatus(
      _environmentId: string,
      _credentialId: string,
      status: StoredEnvironmentEgressCredential["status"],
      error?: string,
    ) {
      stored = { ...stored!, status, error };
    },
    async getEnvironmentRuntime() {
      return runtimeRecord;
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return stored ? [stored] : [];
    },
    async getEnvironmentEgressCredentialById() {
      return stored!;
    },
  } as unknown as SandpiStore;
  const store = {
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
    async createEnvironmentCredentialSource(
      sourceRef: string,
      resolverKind: string,
      material: { type: string; values: Record<string, string> },
    ) {
      assert.match(sourceRef, /^sandpi-credential_/);
      assert.equal(resolverKind, "static_headers");
      assert.deepEqual(material, {
        type: "static_headers",
        values: { secret: "github-secret" },
      });
      return {
        name: sourceRef,
        resolverKind: "static_headers" as const,
        currentVersion: 1,
        status: "active",
      };
    },
    async updateEnvironmentNetworkPolicy(
      _runtime: unknown,
      policy: Environment["networkPolicy"],
      credentials: RuntimeEnvironmentEgressCredential[],
    ) {
      assert.deepEqual(policy, environment.networkPolicy);
      applied.push(credentials);
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  const result = await service.create("user-one", environment.id, {
    ...configuration,
    material: {
      type: "static_headers",
      values: { secret: "github-secret" },
    },
  });

  assert.equal(result.status, "active");
  assert.equal(result.currentVersion, 1);
  assert.equal("sourceRef" in result, false);
  assert.equal(JSON.stringify(result).includes("github-secret"), false);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.[0]?.sourceRef, stored?.sourceRef);
});

test("authorizes the Environment before calling the Sandbox0 credential API", async () => {
  let runtimeCalled = false;
  const store = {
    async getManageableEnvironment() {
      throw new Error("Environment not found.");
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async createEnvironmentCredentialSource() {
      runtimeCalled = true;
      throw new Error("must not run");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  await assert.rejects(
    service.create("other-user", environment.id, {
      ...configuration,
      material: {
        type: "static_headers",
        values: { secret: "secret" },
      },
    }),
    /Environment not found/,
  );
  assert.equal(runtimeCalled, false);
});

test("rejects credential creation after Environment deletion is published", async () => {
  let metadataCreated = false;
  let sourceCreated = false;
  const scopedStore = {
    async getManageableEnvironment() {
      return environment;
    },
    async getEnvironmentRuntime() {
      return { ...runtimeRecord, desiredState: "terminated" };
    },
    async createEnvironmentEgressCredential() {
      metadataCreated = true;
      throw new Error("must not run");
    },
  } as unknown as SandpiStore;
  const store = {
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
    async createEnvironmentCredentialSource() {
      sourceCreated = true;
      throw new Error("must not run");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  await assert.rejects(
    service.create("user-one", environment.id, {
      ...configuration,
      material: {
        type: "static_headers",
        values: { secret: "secret" },
      },
    }),
    /being deleted/,
  );
  assert.equal(metadataCreated, false);
  assert.equal(sourceCreated, false);
});

test("rotates an existing source without replaying the Sandbox policy", async () => {
  let stored: StoredEnvironmentEgressCredential = {
    id: "credential-one",
    environmentId: environment.id,
    sourceRef: "sandpi-credential-one",
    ...configuration,
    status: "active",
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const scopedStore = {
    async getManageableEnvironment() {
      return environment;
    },
    async getEnvironmentRuntime() {
      return runtimeRecord;
    },
    async getEnvironmentEgressCredential() {
      return stored;
    },
    async recordEnvironmentEgressCredentialStatus(
      _environmentId: string,
      _credentialId: string,
      status: StoredEnvironmentEgressCredential["status"],
      error?: string,
    ) {
      stored = { ...stored, status, error };
    },
    async recordEnvironmentEgressCredentialSource(
      _environmentId: string,
      _credentialId: string,
      metadata: { currentVersion?: number; status?: string },
    ) {
      stored = {
        ...stored,
        currentVersion: metadata.currentVersion,
        sourceStatus: metadata.status,
      };
    },
    async getEnvironmentEgressCredentialById() {
      return stored;
    },
  } as unknown as SandpiStore;
  const store = {
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
    async getEnvironmentCredentialSource() {
      return {
        name: stored.sourceRef,
        resolverKind: stored.resolverKind,
        currentVersion: 1,
        status: "active",
      };
    },
    async updateEnvironmentCredentialSource() {
      return {
        name: stored.sourceRef,
        resolverKind: stored.resolverKind,
        currentVersion: 2,
        status: "active",
      };
    },
    async updateEnvironmentNetworkPolicy() {
      assert.fail("existing source rotation must not replay network policy");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  const result = await service.rotate("user-one", environment.id, stored.id, {
    resolverKind: "static_headers",
    material: {
      type: "static_headers",
      values: { secret: "rotated" },
    },
  });

  assert.equal(result.currentVersion, 2);
  assert.equal(result.status, "active");
});

test("recreates a missing source and restores its Sandbox policy binding", async () => {
  const steps: string[] = [];
  let stored: StoredEnvironmentEgressCredential = {
    id: "credential-missing",
    environmentId: environment.id,
    sourceRef: "sandpi-credential-missing",
    ...configuration,
    status: "error",
    createdAt: 1,
    updatedAt: 1,
  };
  const scopedStore = {
    async getManageableEnvironment() {
      return environment;
    },
    async getEnvironmentRuntime() {
      return runtimeRecord;
    },
    async getEnvironmentEgressCredential() {
      return stored;
    },
    async recordEnvironmentEgressCredentialStatus(
      _environmentId: string,
      _credentialId: string,
      status: StoredEnvironmentEgressCredential["status"],
      error?: string,
    ) {
      stored = { ...stored, status, error };
    },
    async recordEnvironmentEgressCredentialSource(
      _environmentId: string,
      _credentialId: string,
      metadata: { currentVersion?: number; status?: string },
    ) {
      stored = {
        ...stored,
        currentVersion: metadata.currentVersion,
        sourceStatus: metadata.status,
      };
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [stored];
    },
    async getEnvironmentEgressCredentialById() {
      return stored;
    },
  } as unknown as SandpiStore;
  const store = {
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
    async getEnvironmentCredentialSource() {
      return undefined;
    },
    async createEnvironmentCredentialSource() {
      steps.push("source");
      return {
        name: stored.sourceRef,
        resolverKind: stored.resolverKind,
        currentVersion: 1,
        status: "active",
      };
    },
    async updateEnvironmentNetworkPolicy(
      _runtime: unknown,
      _policy: unknown,
      credentials: RuntimeEnvironmentEgressCredential[],
    ) {
      assert.equal(credentials[0]?.currentVersion, 1);
      steps.push("policy");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  const result = await service.rotate("user-one", environment.id, stored.id, {
    resolverKind: "static_headers",
    material: {
      type: "static_headers",
      values: { secret: "replacement" },
    },
  });

  assert.deepEqual(steps, ["source", "policy"]);
  assert.equal(result.currentVersion, 1);
  assert.equal(result.status, "active");
});

test("unbinds a credential before deleting its Sandbox0 source", async () => {
  const steps: string[] = [];
  let stored: StoredEnvironmentEgressCredential = {
    id: "credential-one",
    environmentId: environment.id,
    sourceRef: "sandpi-credential-one",
    ...configuration,
    status: "active",
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const scopedStore = {
    async getManageableEnvironment() {
      return environment;
    },
    async getEnvironmentEgressCredential() {
      return stored;
    },
    async recordEnvironmentEgressCredentialStatus(
      _environmentId: string,
      _credentialId: string,
      status: StoredEnvironmentEgressCredential["status"],
      error?: string,
    ) {
      stored = { ...stored, status, error };
      steps.push(`status:${status}`);
    },
    async getEnvironmentRuntime() {
      return runtimeRecord;
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [stored];
    },
    async deleteEnvironmentEgressCredentialRecord() {
      steps.push("metadata");
    },
  } as unknown as SandpiStore;
  const store = {
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
    async updateEnvironmentNetworkPolicy(
      _runtime: unknown,
      _policy: unknown,
      credentials: RuntimeEnvironmentEgressCredential[],
    ) {
      assert.equal(credentials[0]?.status, "deleting");
      steps.push("unbind");
    },
    async deleteEnvironmentCredentialSource(sourceRef: string) {
      assert.equal(sourceRef, stored.sourceRef);
      steps.push("source");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  await service.delete("user-one", environment.id, stored.id);

  assert.deepEqual(steps, [
    "status:deleting",
    "unbind",
    "source",
    "metadata",
  ]);
});

test("allows a missing source to be disabled without requiring new material", async () => {
  let stored: StoredEnvironmentEgressCredential = {
    id: "credential-missing",
    environmentId: environment.id,
    sourceRef: "sandpi-credential-missing",
    ...configuration,
    status: "error",
    error: "Credential material is missing.",
    createdAt: 1,
    updatedAt: 1,
  };
  const applied: RuntimeEnvironmentEgressCredential[][] = [];
  const scopedStore = {
    async getManageableEnvironment() {
      return environment;
    },
    async getEnvironmentEgressCredential() {
      return stored;
    },
    async updateEnvironmentEgressCredentialConfiguration(
      _environmentId: string,
      _credentialId: string,
      input: typeof configuration,
    ) {
      stored = {
        ...stored,
        ...input,
        status: "provisioning",
        error: undefined,
      };
      return stored;
    },
    async getEnvironmentRuntime() {
      return runtimeRecord;
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [stored];
    },
    async recordEnvironmentEgressCredentialStatus(
      _environmentId: string,
      _credentialId: string,
      status: StoredEnvironmentEgressCredential["status"],
      error?: string,
    ) {
      stored = { ...stored, status, error };
    },
    async getEnvironmentEgressCredentialById() {
      return stored;
    },
  } as unknown as SandpiStore;
  const store = {
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
    async updateEnvironmentNetworkPolicy(
      _runtime: unknown,
      _policy: unknown,
      credentials: RuntimeEnvironmentEgressCredential[],
    ) {
      applied.push(credentials);
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  const result = await service.update(
    "user-one",
    environment.id,
    stored.id,
    { ...configuration, enabled: false },
  );

  assert.equal(result.enabled, false);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /Replace the secret/);
  assert.equal(applied[0]?.[0]?.enabled, false);
});

test("removes Environment sources only after the caller deletes the Sandbox", async () => {
  const steps: string[] = [];
  const credential = {
    id: "credential-one",
    environmentId: environment.id,
    sourceRef: "sandpi-credential-one",
    ...configuration,
    status: "active",
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  } satisfies StoredEnvironmentEgressCredential;
  const store = {
    async getEnvironmentById() {
      return environment;
    },
    async getEnvironmentRuntime() {
      return runtimeRecord;
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [credential];
    },
    async recordEnvironmentEgressCredentialStatus() {
      steps.push("deleting");
    },
  } as unknown as SandpiStore;
  const runtime = {
    mode: "sandbox0",
    async deleteEnvironmentCredentialSource() {
      steps.push("source");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  steps.push("sandbox");
  await service.cleanupEnvironmentSources(environment.id);

  assert.deepEqual(steps, [
    "sandbox",
    "deleting",
    "source",
  ]);
});

test("finishes source cleanup without reapplying policy for a terminated Environment", async () => {
  const steps: string[] = [];
  const credential = {
    id: "credential-one",
    environmentId: environment.id,
    sourceRef: "sandpi-credential-one",
    ...configuration,
    status: "deleting",
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  } satisfies StoredEnvironmentEgressCredential;
  const scopedStore = {
    async getEnvironmentById() {
      return environment;
    },
    async listEnvironmentEgressCredentialsByEnvironmentId() {
      return [credential];
    },
    async getEnvironmentRuntime() {
      return { ...runtimeRecord, desiredState: "terminated" };
    },
    async deleteEnvironmentEgressCredentialRecord() {
      steps.push("metadata");
    },
  } as unknown as SandpiStore;
  const store = {
    async environmentEgressCredentialReconciliationIds() {
      return [environment.id];
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
    async deleteEnvironmentCredentialSource() {
      steps.push("source");
    },
    async updateEnvironmentNetworkPolicy() {
      steps.push("unexpected-policy");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentEgressCredentialService(
    store,
    runtime,
    logger,
  );

  await service.reconcilePending();

  assert.deepEqual(steps, ["source", "metadata"]);
});
