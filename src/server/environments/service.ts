import { setTimeout as delay } from "node:timers/promises";

import type { Environment, NetworkPolicy } from "@/lib/types";
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
  private requestRuntimeConfigReconciliation?: () => Promise<void> | void;

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

  setRuntimeConfigReconciler(handler: () => Promise<void> | void) {
    this.requestRuntimeConfigReconciliation = handler;
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
    const memoryChanged = current.sandboxMemoryMiB !== input.sandboxMemoryMiB;
    if (memoryChanged) {
      await this.quota?.assertMemoryConfigurationAllowed(
        userId,
        current.sandboxMemoryMiB,
        input.sandboxMemoryMiB,
      );
    }
    // Persist desired state before any Sandbox0 call. The lifecycle reconciler
    // owns external mutation and can safely resume after a process restart.
    const updated = await this.store.updateEnvironment(
      userId,
      environmentId,
      input,
    );
    if (updated.runtimeConfig.status !== "applied") {
      this.triggerRuntimeConfigReconciliation(environmentId);
    }
    return updated;
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
        await this.store.markEnvironmentReady(
          environmentId,
          provisioned,
          {
            generation: environment.runtimeConfig.desiredGeneration,
            sandboxMemoryMiB: environment.sandboxMemoryMiB,
          },
        );
        this.triggerRuntimeConfigReconciliation(environmentId);
        this.logger.info({ environmentId }, "Environment is ready");
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

  private triggerRuntimeConfigReconciliation(environmentId: string) {
    void Promise.resolve()
      .then(() => this.requestRuntimeConfigReconciliation?.())
      .catch((error) => {
        this.logger.error(
          { environmentId, error: errorMessage(error) },
          "Environment runtime configuration reconciliation could not start",
        );
      });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
