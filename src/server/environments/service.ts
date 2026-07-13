import type { RuntimeAdapter } from "@/server/runtime/types";
import { SandpiStore } from "@/server/store";

interface ServiceLogger {
  info(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export class EnvironmentService {
  private reconciliation?: Promise<void>;
  private reconciliationRequested = false;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: ServiceLogger,
  ) {}

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

  async create(input: { userId: string; teamId: string; name: string }) {
    const environment = await this.store.createEnvironmentMetadata(input);
    // The logical Environment exists before its Workspace Volume is ready.
    // Return immediately so native harness login can run in an Auth Runner
    // while the Sandbox0 Volume is provisioned independently.
    void this.reconcilePending();
    return environment;
  }

  async retry(userId: string, environmentId: string) {
    const current = await this.store.getEnvironment(userId, environmentId);
    if (current.status === "ready") return current;
    const environment = await this.store.markEnvironmentProvisioning(
      userId,
      environmentId,
    );
    void this.reconcilePending();
    return environment;
  }

  private async provision(environmentId: string) {
    try {
      const resources = await this.runtime.provisionEnvironment();
      try {
        const environment = await this.store.markEnvironmentReady(
          environmentId,
          resources,
        );
        this.logger.info({ environmentId }, "Environment is ready");
        return environment;
      } catch (error) {
        await this.runtime.deleteEnvironmentResources(resources);
        throw error;
      }
    } catch (error) {
      await this.store.markEnvironmentFailed(environmentId, errorMessage(error));
      throw error;
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
