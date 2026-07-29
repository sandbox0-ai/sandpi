import { setTimeout as delay } from "node:timers/promises";

import type {
  Environment,
  NetworkPolicy,
  SandpiBootstrap,
  SandpiDeploymentSummary,
} from "@/lib/types";
import { conflict, HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { SandpiStore } from "@/server/store";
import type {
  EnvironmentQuotaPolicy,
  RuntimeQuotaGate,
} from "@/server/billing/quota-service";

interface ServiceLogger {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export class EnvironmentService {
  private reconciliation?: Promise<void>;
  private reconciliationRequested = false;
  private beforeDelete?: (
    userId: string,
    environmentId: string,
  ) => Promise<void> | void;
  private afterRuntimeDelete?: (
    userId: string,
    environmentId: string,
    store: SandpiStore,
  ) => Promise<void> | void;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: ServiceLogger,
    private readonly quota?: EnvironmentQuotaPolicy,
    private readonly runtimeQuotaGate?: RuntimeQuotaGate,
  ) {}

  setBeforeDelete(
    handler: (userId: string, environmentId: string) => Promise<void> | void,
  ) {
    this.beforeDelete = handler;
  }

  setAfterRuntimeDelete(
    handler: (
      userId: string,
      environmentId: string,
      store: SandpiStore,
    ) => Promise<void> | void,
  ) {
    this.afterRuntimeDelete = handler;
  }

  async getBootstrap(
    userId: string,
    deployment: SandpiDeploymentSummary,
    requestedEnvironmentId?: string,
    requestedSessionId?: string,
    preferNewSession = false,
  ): Promise<SandpiBootstrap> {
    const bootstrap = await this.store.getBootstrap(
      userId,
      deployment,
      requestedEnvironmentId,
      requestedSessionId,
      preferNewSession,
    );
    return {
      ...bootstrap,
      environments: await Promise.all(
        bootstrap.environments.map((environment) =>
          this.authoritativeEnvironment(environment),
        ),
      ),
    };
  }

  async list(userId: string) {
    const environments = await this.store.listEnvironments(userId);
    return Promise.all(
      environments.map((environment) =>
        this.authoritativeEnvironment(environment),
      ),
    );
  }

  /**
   * Resolves the public lifecycle field from Sandbox0 at read time. Sandpi
   * owns provisioning metadata before a Sandbox exists, but never caches a
   * ready Sandbox's observed lifecycle state in PostgreSQL.
   */
  async authoritativeEnvironment<T extends Environment>(
    environment: T,
  ): Promise<T> {
    if (environment.status !== "ready" || !environment.sandboxId) {
      return environment;
    }
    return {
      ...environment,
      sandboxState: await this.runtime.getEnvironmentSandboxState(
        environment.sandboxId,
      ),
    };
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
    name: string;
  }) {
    const environmentLimit = await this.quota?.environmentLimit(input.userId);
    const environment = await this.store.createEnvironmentMetadata({
      ...input,
      environmentLimit,
    });
    // The logical Environment exists before its Workspace Volume is ready.
    // Return immediately so native harness login can run in an Auth Runner
    // while the Sandbox0 Volume is provisioned independently.
    void this.reconcilePending();
    return this.authoritativeEnvironment(environment);
  }

  async retry(userId: string, environmentId: string) {
    const current = await this.store.getManageableEnvironment(userId, environmentId);
    if (current.status === "ready") {
      return this.authoritativeEnvironment(current);
    }
    const environment = await this.store.markEnvironmentProvisioning(
      userId,
      environmentId,
    );
    void this.reconcilePending();
    return this.authoritativeEnvironment(environment);
  }

  async update(
    userId: string,
    environmentId: string,
    input: {
      name: string;
      description: string;
      color: string;
      idlePauseTimeoutSeconds: number;
      sandboxMemoryMiB: number;
      workspaceBackup: Pick<
        Environment["workspaceBackup"],
        "intervalSeconds" | "retentionCount"
      >;
      networkPolicy: NetworkPolicy;
    },
  ): Promise<Environment> {
    const current = await this.store.getManageableEnvironment(userId, environmentId);
    const networkChanged =
      JSON.stringify(current.networkPolicy) !== JSON.stringify(input.networkPolicy);
    const idlePauseChanged =
      current.idlePauseTimeoutSeconds !== input.idlePauseTimeoutSeconds;
    const memoryChanged = current.sandboxMemoryMiB !== input.sandboxMemoryMiB;
    if (memoryChanged) {
      await this.quota?.assertMemoryConfigurationAllowed(
        userId,
        current.sandboxMemoryMiB,
        input.sandboxMemoryMiB,
      );
    }
    const backupPolicyChanged =
      current.workspaceBackup.intervalSeconds !==
        input.workspaceBackup.intervalSeconds ||
      current.workspaceBackup.retentionCount !==
        input.workspaceBackup.retentionCount;
    if (
      !networkChanged &&
      !idlePauseChanged &&
      !memoryChanged &&
      !backupPolicyChanged
    ) {
      return this.authoritativeEnvironment(
        await this.store.updateEnvironment(userId, environmentId, input),
      );
    }

    const updateWhileLifecycleLocked = async (scopedStore: SandpiStore) => {
      const locked = await scopedStore.getManageableEnvironment(
        userId,
        environmentId,
      );
      const lockedNetworkChanged =
        JSON.stringify(locked.networkPolicy) !== JSON.stringify(input.networkPolicy);
      const lockedMemoryChanged =
        locked.sandboxMemoryMiB !== input.sandboxMemoryMiB;
      if (lockedMemoryChanged) {
        await this.quota?.assertMemoryConfigurationAllowed(
          userId,
          locked.sandboxMemoryMiB,
          input.sandboxMemoryMiB,
        );
      }
      if (lockedNetworkChanged || lockedMemoryChanged) {
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
          // The Sandbox is owned by the Environment, so runtime edits apply to
          // the existing Sandbox instead of waiting for a future Session.
          if (lockedNetworkChanged) {
            const credentials =
              await scopedStore.listEnvironmentEgressCredentialsByEnvironmentId(
                environmentId,
              );
            await this.runtime.updateEnvironmentNetworkPolicy(
              runtime,
              input.networkPolicy,
              credentials,
            );
          }
          if (lockedMemoryChanged) {
            await this.runtime.updateEnvironmentMemory(
              runtime,
              input.sandboxMemoryMiB,
            );
          }
        }
      }
      return scopedStore.updateEnvironment(userId, environmentId, input);
    };

    // Runtime edits use the lifecycle lock so they cannot race a pause,
    // snapshot, resume, reprovision or deletion.
    const updated = await this.waitForLifecycleLock(
      environmentId,
      updateWhileLifecycleLocked,
    );
    return this.authoritativeEnvironment(updated);
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
        await this.afterRuntimeDelete?.(
          userId,
          environmentId,
          scopedStore,
        );
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

  private async provision(environmentId: string) {
    let resources: Parameters<RuntimeAdapter["deleteEnvironmentResources"]>[0] = {};
    try {
      const environment = await this.store.getEnvironmentById(environmentId);
      await this.runtimeQuotaGate?.assertEnvironmentRuntimeAllowed(
        environmentId,
      );
      const credentials =
        await this.store.listEnvironmentEgressCredentialsByEnvironmentId(
          environmentId,
        );
      const provisioned = await this.runtime.provisionEnvironment({
        environment,
        credentials,
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
