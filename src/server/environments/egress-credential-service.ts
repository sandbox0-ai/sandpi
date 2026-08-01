import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  CreateEnvironmentEgressCredentialInput,
  EnvironmentCredentialMaterial,
  EnvironmentEgressCredential,
  RotateEnvironmentEgressCredentialInput,
  UpdateEnvironmentEgressCredentialInput,
} from "@/lib/environment-credentials";
import { conflict, HttpError } from "@/server/http-error";
import type {
  RuntimeAdapter,
  RuntimeCredentialSourceMetadata,
} from "@/server/runtime/types";
import type {
  SandpiStore,
  StoredEnvironmentEgressCredential,
} from "@/server/store";

interface EnvironmentCredentialLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Owns Sandpi's per-Environment view of Sandbox0 egress credential sources.
 * Secret material only crosses this service on a create or rotate request and
 * is never persisted in Sandpi PostgreSQL.
 */
export class EnvironmentEgressCredentialService {
  private reconciliation?: Promise<void>;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: EnvironmentCredentialLogger,
  ) {}

  async list(
    userId: string,
    environmentId: string,
  ): Promise<EnvironmentEgressCredential[]> {
    const credentials = await this.store.listEnvironmentEgressCredentials(
      userId,
      environmentId,
    );
    return credentials.map(publicEnvironmentCredential);
  }

  async get(
    userId: string,
    environmentId: string,
    credentialId: string,
  ): Promise<EnvironmentEgressCredential> {
    return publicEnvironmentCredential(
      await this.store.getEnvironmentEgressCredential(
        userId,
        environmentId,
        credentialId,
      ),
    );
  }

  async create(
    userId: string,
    environmentId: string,
    input: CreateEnvironmentEgressCredentialInput,
  ): Promise<EnvironmentEgressCredential> {
    await this.store.getManageableEnvironment(userId, environmentId);
    this.assertConfigured();
    return this.waitForLifecycleLock(environmentId, async (scopedStore) => {
      await assertReadyEnvironment(scopedStore, userId, environmentId);
      const id = `credential_${randomUUID()}`;
      const stored = await scopedStore.createEnvironmentEgressCredential(
        environmentId,
        {
          id,
          sourceRef: `sandpi-${id}`,
          name: input.name,
          resolverKind: input.resolverKind,
          projection: input.projection,
          rule: input.rule,
          enabled: input.enabled,
        },
      );

      try {
        const metadata = await this.createOrDiscoverSource(
          stored,
          input.material,
        );
        await scopedStore.recordEnvironmentEgressCredentialSource(
          environmentId,
          id,
          metadata,
        );
        await this.applyEnvironmentPolicy(
          scopedStore,
          userId,
          environmentId,
        );
        await scopedStore.recordEnvironmentEgressCredentialStatus(
          environmentId,
          id,
          "active",
        );
      } catch (error) {
        await scopedStore
          .recordEnvironmentEgressCredentialStatus(
            environmentId,
            id,
            "error",
            errorMessage(error),
          )
          .catch(() => undefined);
        throw error;
      }

      this.logger.info(
        { environmentId, credentialId: id, resolverKind: input.resolverKind },
        "Environment egress credential created",
      );
      return publicEnvironmentCredential(
        await scopedStore.getEnvironmentEgressCredentialById(environmentId, id),
      );
    });
  }

  async update(
    userId: string,
    environmentId: string,
    credentialId: string,
    input: UpdateEnvironmentEgressCredentialInput,
  ): Promise<EnvironmentEgressCredential> {
    await this.store.getManageableEnvironment(userId, environmentId);
    this.assertConfigured();
    return this.waitForLifecycleLock(environmentId, async (scopedStore) => {
      await assertReadyEnvironment(scopedStore, userId, environmentId);
      const current = await scopedStore.getEnvironmentEgressCredential(
        userId,
        environmentId,
        credentialId,
      );
      if (current.resolverKind !== input.resolverKind) {
        throw new HttpError(
          400,
          "environment_credential_kind_immutable",
          "Credential type cannot be changed. Create another credential instead.",
        );
      }
      if (!current.currentVersion && input.enabled) {
        throw conflict(
          "environment_credential_material_missing",
          "Credential material is missing. Replace the secret before enabling it.",
        );
      }
      const updated =
        await scopedStore.updateEnvironmentEgressCredentialConfiguration(
          environmentId,
          credentialId,
          input,
        );
      try {
        await this.applyEnvironmentPolicy(
          scopedStore,
          userId,
          environmentId,
        );
        await scopedStore.recordEnvironmentEgressCredentialStatus(
          environmentId,
          credentialId,
          updated.currentVersion ? "active" : "error",
          updated.currentVersion
            ? undefined
            : "Credential material is missing. Replace the secret to retry.",
        );
      } catch (error) {
        await scopedStore.recordEnvironmentEgressCredentialStatus(
          environmentId,
          credentialId,
          "error",
          errorMessage(error),
        );
        throw error;
      }
      return publicEnvironmentCredential(
        await scopedStore.getEnvironmentEgressCredentialById(
          environmentId,
          credentialId,
        ),
      );
    });
  }

  async rotate(
    userId: string,
    environmentId: string,
    credentialId: string,
    input: RotateEnvironmentEgressCredentialInput,
  ): Promise<EnvironmentEgressCredential> {
    await this.store.getManageableEnvironment(userId, environmentId);
    this.assertConfigured();
    return this.waitForLifecycleLock(environmentId, async (scopedStore) => {
      await assertReadyEnvironment(scopedStore, userId, environmentId);
      const current = await scopedStore.getEnvironmentEgressCredential(
        userId,
        environmentId,
        credentialId,
      );
      if (current.resolverKind !== input.resolverKind) {
        throw new HttpError(
          400,
          "environment_credential_kind_immutable",
          "Credential type cannot be changed. Create another credential instead.",
        );
      }

      await scopedStore.recordEnvironmentEgressCredentialStatus(
        environmentId,
        credentialId,
        "provisioning",
      );
      try {
        const source = await this.runtime.getEnvironmentCredentialSource(
          current.sourceRef,
        );
        if (source && source.resolverKind !== current.resolverKind) {
          throw new HttpError(
            502,
            "sandbox0_credential_source_kind_mismatch",
            "Sandbox0 returned an incompatible credential source.",
          );
        }
        const metadata = assertUsableCredentialSource(
          current,
          source
            ? await this.runtime.updateEnvironmentCredentialSource(
                current.sourceRef,
                current.resolverKind,
                input.material,
              )
            : await this.runtime.createEnvironmentCredentialSource(
                current.sourceRef,
                current.resolverKind,
                input.material,
              ),
        );
        await scopedStore.recordEnvironmentEgressCredentialSource(
          environmentId,
          credentialId,
          metadata,
        );
        // Sandbox0 advances every existing binding when a source is replaced.
        // Only a recreated source needs the policy to restore its binding.
        if (!source) {
          await this.applyEnvironmentPolicy(
            scopedStore,
            userId,
            environmentId,
          );
        }
        await scopedStore.recordEnvironmentEgressCredentialStatus(
          environmentId,
          credentialId,
          "active",
        );
      } catch (error) {
        await scopedStore.recordEnvironmentEgressCredentialStatus(
          environmentId,
          credentialId,
          "error",
          errorMessage(error),
        );
        throw error;
      }
      this.logger.info(
        { environmentId, credentialId },
        "Environment egress credential rotated",
      );
      return publicEnvironmentCredential(
        await scopedStore.getEnvironmentEgressCredentialById(
          environmentId,
          credentialId,
        ),
      );
    });
  }

  async delete(
    userId: string,
    environmentId: string,
    credentialId: string,
  ): Promise<void> {
    await this.store.getManageableEnvironment(userId, environmentId);
    this.assertConfigured();
    await this.waitForLifecycleLock(environmentId, async (scopedStore) => {
      await assertReadyEnvironment(scopedStore, userId, environmentId);
      const current = await scopedStore.getEnvironmentEgressCredential(
        userId,
        environmentId,
        credentialId,
      );
      await scopedStore.recordEnvironmentEgressCredentialStatus(
        environmentId,
        credentialId,
        "deleting",
      );
      try {
        await this.applyEnvironmentPolicy(
          scopedStore,
          userId,
          environmentId,
        );
        const runtime = await scopedStore.getEnvironmentRuntime(
          userId,
          environmentId,
        );
        await this.runtime.deleteRetiredEnvironmentSandboxes(runtime);
        await this.runtime.deleteEnvironmentCredentialSource(current.sourceRef);
        await scopedStore.deleteEnvironmentEgressCredentialRecord(
          environmentId,
          credentialId,
        );
      } catch (error) {
        await scopedStore
          .recordEnvironmentEgressCredentialStatus(
            environmentId,
            credentialId,
            "deleting",
            errorMessage(error),
          )
          .catch(() => undefined);
        throw error;
      }
      this.logger.info(
        { environmentId, credentialId },
        "Environment egress credential deleted",
      );
    });
  }

  /**
   * Runs after the Environment Sandbox has been deleted, so Sandbox0 no longer
   * rejects source deletion because of a live binding.
   */
  async cleanupEnvironmentSources(
    environmentId: string,
    store: SandpiStore = this.store,
  ) {
    const environment = await store.getEnvironmentById(environmentId);
    const runtime = await store.getEnvironmentRuntime(
      environment.ownerId,
      environmentId,
    );
    await this.runtime.deleteRetiredEnvironmentSandboxes(runtime);
    const credentials =
      await store.listEnvironmentEgressCredentialsByEnvironmentId(environmentId);
    for (const credential of credentials) {
      await store.recordEnvironmentEgressCredentialStatus(
        environmentId,
        credential.id,
        "deleting",
      );
      try {
        await this.runtime.deleteEnvironmentCredentialSource(
          credential.sourceRef,
        );
      } catch (error) {
        await store.recordEnvironmentEgressCredentialStatus(
          environmentId,
          credential.id,
          "deleting",
          errorMessage(error),
        );
        throw error;
      }
    }
  }

  async reconcilePending() {
    if (this.runtime.mode === "unconfigured") return;
    if (this.reconciliation) return this.reconciliation;
    const run = this.runReconciliation().finally(() => {
      if (this.reconciliation === run) this.reconciliation = undefined;
    });
    this.reconciliation = run;
    return run;
  }

  private async runReconciliation() {
    const environmentIds =
      await this.store.environmentEgressCredentialReconciliationIds();
    for (const environmentId of environmentIds) {
      try {
        await this.waitForLifecycleLock(environmentId, async (scopedStore) => {
          const environment =
            await scopedStore.getEnvironmentById(environmentId);
          if (environment.status !== "ready") return;
          const credentials =
            await scopedStore.listEnvironmentEgressCredentialsByEnvironmentId(
              environmentId,
            );
          const environmentRuntime =
            await scopedStore.getEnvironmentRuntime(
              environment.ownerId,
              environmentId,
            );
          if (environmentRuntime.desiredState === "terminated") {
            await this.runtime.deleteRetiredEnvironmentSandboxes(
              environmentRuntime,
            );
            for (const credential of credentials) {
              await this.runtime.deleteEnvironmentCredentialSource(
                credential.sourceRef,
              );
              await scopedStore.deleteEnvironmentEgressCredentialRecord(
                environmentId,
                credential.id,
              );
            }
            return;
          }
          const deleting = credentials.filter(
            (credential) => credential.status === "deleting",
          );
          for (const credential of credentials) {
            if (credential.status === "deleting") continue;
            const metadata =
              await this.runtime.getEnvironmentCredentialSource(
                credential.sourceRef,
              );
            if (
              !metadata ||
              metadata.name !== credential.sourceRef ||
              metadata.resolverKind !== credential.resolverKind ||
              !metadata.currentVersion
            ) {
              await scopedStore.recordEnvironmentEgressCredentialSourceMissing(
                environmentId,
                credential.id,
                "Credential source is missing or incompatible. Replace the secret to retry.",
              );
              continue;
            }
            await scopedStore.recordEnvironmentEgressCredentialSource(
              environmentId,
              credential.id,
              metadata,
            );
          }

          await this.applyEnvironmentPolicy(
            scopedStore,
            environment.ownerId,
            environmentId,
          );
          if (deleting.length > 0) {
            await this.runtime.deleteRetiredEnvironmentSandboxes(
              environmentRuntime,
            );
          }
          const refreshed =
            await scopedStore.listEnvironmentEgressCredentialsByEnvironmentId(
              environmentId,
            );
          for (const credential of refreshed) {
            if (
              credential.status !== "deleting" &&
              credential.currentVersion
            ) {
              await scopedStore.recordEnvironmentEgressCredentialStatus(
                environmentId,
                credential.id,
                "active",
              );
            }
          }
          for (const credential of deleting) {
            await this.runtime.deleteEnvironmentCredentialSource(
              credential.sourceRef,
            );
            await scopedStore.deleteEnvironmentEgressCredentialRecord(
              environmentId,
              credential.id,
            );
          }
        });
      } catch (error) {
        this.logger.warn(
          { environmentId, error: errorMessage(error) },
          "Environment egress credential reconciliation deferred",
        );
      }
    }
  }

  private async createOrDiscoverSource(
    credential: StoredEnvironmentEgressCredential,
    material: EnvironmentCredentialMaterial,
  ) {
    try {
      return assertUsableCredentialSource(
        credential,
        await this.runtime.createEnvironmentCredentialSource(
          credential.sourceRef,
          credential.resolverKind,
          material,
        ),
      );
    } catch (createError) {
      const existing = await this.runtime
        .getEnvironmentCredentialSource(credential.sourceRef)
        .catch(() => undefined);
      if (existing) {
        return assertUsableCredentialSource(credential, existing);
      }
      throw createError;
    }
  }

  private async applyEnvironmentPolicy(
    store: SandpiStore,
    userId: string,
    environmentId: string,
  ) {
    const environment = await store.getManageableEnvironment(
      userId,
      environmentId,
    );
    const runtime = await store.getEnvironmentRuntime(userId, environmentId);
    const credentials =
      await store.listEnvironmentEgressCredentialsByEnvironmentId(environmentId);
    try {
      await this.runtime.updateEnvironmentNetworkPolicy(
        runtime,
        environment.networkPolicy,
        credentials,
      );
    } catch (error) {
      throw credentialPolicyError(error);
    }
  }

  private assertConfigured() {
    if (this.runtime.mode !== "unconfigured") return;
    throw new HttpError(
      503,
      "sandbox0_not_configured",
      "This Sandpi deployment has not configured Sandbox0.",
    );
  }

  private async waitForLifecycleLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline) {
      const result = await this.store.withEnvironmentLifecycleLock(
        environmentId,
        operation,
      );
      if (result.acquired) return result.value;
      await delay(250);
    }
    throw new HttpError(
      503,
      "environment_lifecycle_busy",
      "Timed out waiting for the Environment lifecycle lock.",
    );
  }
}

async function assertReadyEnvironment(
  store: SandpiStore,
  userId: string,
  environmentId: string,
) {
  const environment = await store.getManageableEnvironment(userId, environmentId);
  const runtime = await store.getEnvironmentRuntime(userId, environmentId);
  if (runtime.desiredState === "terminated") {
    throw conflict(
      "environment_terminated",
      "The Environment is being deleted.",
    );
  }
  if (environment.status !== "ready") {
    throw conflict(
      "environment_runtime_not_ready",
      "Wait for Environment provisioning to finish before changing credentials.",
    );
  }
  return environment;
}

function publicEnvironmentCredential(
  credential: StoredEnvironmentEgressCredential,
): EnvironmentEgressCredential {
  return {
    id: credential.id,
    environmentId: credential.environmentId,
    name: credential.name,
    resolverKind: credential.resolverKind,
    projection: credential.projection,
    rule: credential.rule,
    enabled: credential.enabled,
    status: credential.status,
    ...(credential.currentVersion
      ? { currentVersion: credential.currentVersion }
      : {}),
    ...(credential.sourceStatus
      ? { sourceStatus: credential.sourceStatus }
      : {}),
    ...(credential.error ? { error: credential.error } : {}),
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function credentialPolicyError(error: unknown) {
  if (
    error instanceof HttpError &&
    [
      "sandbox0_invalid_api_key",
      "sandbox0_permission_denied",
      "sandbox0_unavailable",
    ].includes(error.code)
  ) {
    return error;
  }
  return new HttpError(
    error instanceof HttpError ? error.statusCode : 502,
    "sandbox0_credential_policy_apply_failed",
    "Sandbox0 could not apply the Environment credential policy.",
  );
}

function assertUsableCredentialSource(
  credential: Pick<
    StoredEnvironmentEgressCredential,
    "sourceRef" | "resolverKind"
  >,
  metadata: RuntimeCredentialSourceMetadata,
) {
  if (
    metadata.name !== credential.sourceRef ||
    metadata.resolverKind !== credential.resolverKind ||
    !metadata.currentVersion
  ) {
    throw new HttpError(
      502,
      "sandbox0_credential_source_invalid",
      "Sandbox0 did not return a usable credential source version.",
    );
  }
  return metadata;
}
