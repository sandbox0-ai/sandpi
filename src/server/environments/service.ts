import { setTimeout as delay } from "node:timers/promises";

import type { Environment, NetworkPolicy } from "@/lib/types";
import { conflict, HttpError } from "@/server/http-error";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
} from "@/server/runtime/types";
import { SandpiStore } from "@/server/store";

interface ServiceLogger {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export type EnvironmentNetworkPolicyApplier = (input: {
  userId: string;
  environmentId: string;
  runtime: EnvironmentRuntimeRecord;
  userPolicy: NetworkPolicy;
}) => Promise<void>;

export class EnvironmentService {
  private reconciliation?: Promise<void>;
  private reconciliationRequested = false;
  private beforeDelete?: (
    userId: string,
    environmentId: string,
  ) => Promise<void> | void;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: ServiceLogger,
    private readonly networkPolicyApplier?: EnvironmentNetworkPolicyApplier,
  ) {}

  setBeforeDelete(
    handler: (userId: string, environmentId: string) => Promise<void> | void,
  ) {
    this.beforeDelete = handler;
  }

  reconcilePending() {
    this.reconciliationRequested = true;
    this.reconciliation ??= this.runRequestedReconciliations().finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }

  private async runRequestedReconciliations() {
    do {
      this.reconciliationRequested = false;
      await this.runReconciliation();
    } while (this.reconciliationRequested);
  }

  private async runReconciliation() {
    const environments = await this.store.environmentsNeedingProvisioning();
    for (const environment of environments) {
      try {
        await this.provision(environment.id);
      } catch (error) {
        this.logger.error(
          { environmentId: environment.id, error: errorMessage(error) },
          "Environment provisioning failed",
        );
      }
    }
  }

  async create(input: {
    userId: string;
    teamId: string;
    name: string;
    visibility: Environment["visibility"];
  }) {
    const environment = await this.store.createEnvironmentMetadata(input);
    // The logical Environment exists before its Workspace Volume is ready.
    // Return immediately so native harness login can run in an Auth Runner
    // while the Sandbox0 Volume is provisioned independently.
    void this.reconcilePending();
    return environment;
  }

  async retry(userId: string, environmentId: string) {
    const current = await this.store.getManageableEnvironment(userId, environmentId);
    if (current.status === "ready") return current;
    const environment = await this.store.markEnvironmentProvisioning(
      userId,
      environmentId,
    );
    void this.reconcilePending();
    return environment;
  }

  async update(
    userId: string,
    environmentId: string,
    input: {
      name: string;
      description: string;
      color: string;
      visibility: Environment["visibility"];
      idlePauseTimeoutSeconds: number;
      networkPolicy: NetworkPolicy;
    },
  ): Promise<Environment> {
    const current = await this.store.getManageableEnvironment(userId, environmentId);
    if (current.visibility !== input.visibility && current.ownerId !== userId) {
      throw conflict(
        "environment_visibility_forbidden",
        "Only the Environment creator can change its visibility.",
      );
    }
    const networkChanged =
      JSON.stringify(current.networkPolicy) !== JSON.stringify(input.networkPolicy);
    const idlePauseChanged =
      current.idlePauseTimeoutSeconds !== input.idlePauseTimeoutSeconds;
    if (!networkChanged && !idlePauseChanged) {
      return this.store.updateEnvironment(userId, environmentId, input);
    }

    const updateWhileLifecycleLocked = async (scopedStore: SandpiStore) => {
      const locked = await scopedStore.getManageableEnvironment(
        userId,
        environmentId,
      );
      if (locked.visibility !== input.visibility && locked.ownerId !== userId) {
        throw conflict(
          "environment_visibility_forbidden",
          "Only the Environment creator can change its visibility.",
        );
      }
      const lockedNetworkChanged =
        JSON.stringify(locked.networkPolicy) !== JSON.stringify(input.networkPolicy);
      if (lockedNetworkChanged) {
          const runtime = await scopedStore.getEnvironmentRuntime(
            userId,
            environmentId,
          );
          if (runtime.desiredState === "terminated") {
            throw new HttpError(
              409,
              "environment_terminated",
              "The Environment is being deleted.",
            );
          }
          if (locked.status === "ready") {
            // The Sandbox is owned by the Environment, so policy edits apply to
            // the running runtime instead of being deferred to a future Session
            // claim.
            if (this.networkPolicyApplier) {
              await this.networkPolicyApplier({
                userId,
                environmentId,
                runtime,
                userPolicy: input.networkPolicy,
              });
            } else {
              await this.runtime.updateEnvironmentNetworkPolicy(
                runtime,
                input.networkPolicy,
              );
            }
          }
      }
      return scopedStore.updateEnvironment(userId, environmentId, input);
    };

    // Network policy is a whole-resource Sandbox0 replacement. Serialize its
    // read, external apply and PostgreSQL update with credential-binding
    // mutations and Environment deletion across every Sandpi replica. Idle
    // timeout changes need only the lifecycle lock so they cannot race a pause.
    if (networkChanged) {
      return this.waitForMcpMutationLock(environmentId, (mcpStore) =>
        this.waitForLifecycleLock(
          environmentId,
          updateWhileLifecycleLocked,
          mcpStore,
        ),
      );
    }
    return this.waitForLifecycleLock(
      environmentId,
      updateWhileLifecycleLocked,
    );
  }

  /**
   * Permanently deletes one Environment and every resource it owns. External
   * resources are removed before PostgreSQL metadata so a partial failure can
   * be retried without losing the Sandbox0 coordinates needed for cleanup.
   */
  async delete(userId: string, environmentId: string) {
    let environment = await this.store.getManageableEnvironment(
      userId,
      environmentId,
    );
    if (environment.status === "updating" && this.reconciliation) {
      await this.reconciliation;
      environment = await this.store.getManageableEnvironment(
        userId,
        environmentId,
      );
    }
    if (environment.status === "updating") {
      throw conflict(
        "environment_provisioning_in_progress",
        "Wait for Environment provisioning to finish before deleting it.",
      );
    }

    // Publish the terminal intent before cleanup releases the lifecycle lock.
    // MCP credential/OAuth mutations use this durable gate to reject new
    // external resources while deletion is in progress.
    await this.waitForLifecycleLock(environmentId, async (lockedStore) => {
      await lockedStore.prepareEnvironmentDeletion(userId, environmentId);
    });
    try {
      // Environment-owned cleanup may query PostgreSQL and call external APIs,
      // so it runs after the short gate transaction without pinning a lock
      // connection.
      await this.beforeDelete?.(userId, environmentId);
    } catch (error) {
      await this.store
        .recordEnvironmentDeletionFailure(environmentId, errorMessage(error))
        .catch(() => undefined);
      throw error;
    }

    await this.waitForLifecycleLock(environmentId, async (scopedStore) => {
      const resources = await scopedStore.prepareEnvironmentDeletion(
        userId,
        environmentId,
      );
      try {
        await this.runtime.deleteEnvironmentResources(resources);
        await scopedStore.deleteEnvironmentMetadata(userId, environmentId);
        this.logger.info({ environmentId }, "Environment deleted");
      } catch (error) {
        await scopedStore.recordEnvironmentDeletionFailure(
          environmentId,
          errorMessage(error),
        );
        throw error;
      }
    });
  }

  private async waitForLifecycleLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
    lockStore: SandpiStore = this.store,
  ): Promise<T> {
    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline) {
      const result = await lockStore.withEnvironmentLifecycleLock(
        environmentId,
        (lockedStore) => operation(lockedStore ?? this.store),
      );
      if (result.acquired) return result.value;
      // A pause, runtime recovery, or Turn admission already owns this
      // Environment. Poll without pinning a PostgreSQL connection behind the
      // external operation.
      await delay(250);
    }
    throw new HttpError(
      503,
      "environment_lifecycle_busy",
      "Timed out waiting for the Environment lifecycle lock.",
    );
  }

  private async waitForMcpMutationLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline) {
      const result = await this.store.withEnvironmentMcpMutationLock(
        environmentId,
        (lockedStore) => operation(lockedStore ?? this.store),
      );
      if (result.acquired) return result.value;
      await delay(250);
    }
    throw new HttpError(
      503,
      "environment_mcp_mutation_busy",
      "Timed out waiting to update the Environment network policy.",
    );
  }

  private async provision(environmentId: string) {
    let resources: Parameters<RuntimeAdapter["deleteEnvironmentResources"]>[0] = {};
    try {
      const environment = await this.store.getEnvironmentById(environmentId);
      const provisioned = await this.runtime.provisionEnvironment({
        environment,
        onResourcesAllocated: async (allocated) => {
          resources = { ...resources, ...allocated };
          await this.store.recordEnvironmentAllocation(environmentId, allocated);
        },
      });
      resources = provisioned;
      try {
        const ready = await this.store.markEnvironmentReady(
          environmentId,
          provisioned,
        );
        this.logger.info({ environmentId }, "Environment is ready");
        return ready;
      } catch (error) {
        await this.runtime.deleteEnvironmentResources(provisioned);
        throw error;
      }
    } catch (error) {
      if (resources.sandboxId) {
        await this.runtime.deleteEnvironmentResources({
          sandboxId: resources.sandboxId,
        }).catch(() => undefined);
        await this.store.clearEnvironmentSandboxAllocation(
          environmentId,
          resources.sandboxId,
        );
      }
      await this.store.markEnvironmentFailed(environmentId, errorMessage(error));
      throw error;
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
