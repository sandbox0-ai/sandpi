import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore } from "@/server/store";
import type { RuntimeQuotaGate } from "@/server/billing/quota-service";
import {
  ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
} from "./lifecycle-policy";

const RUNTIME_CONFIG_RETRY_BASE_MS = 5_000;
const RUNTIME_CONFIG_RETRY_MAX_MS = 5 * 60_000;

interface LifecycleLogger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Executes durable Environment policy and idle-pause timers. Runtime access is
 * resumed natively by Sandbox0; this service never owns a wake-up state machine.
 * PostgreSQL stores deadlines so any Sandpi replica can take over after a crash.
 */
export class EnvironmentLifecycleService {
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private reconciliationRequested = false;
  private closed = false;
  private started = false;
  private readonly controller = new AbortController();
  private beforePause?: (
    environmentId: string,
    store: SandpiStore,
  ) => Promise<void> | void;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: LifecycleLogger,
    private readonly options: {
      pollIntervalMs?: number;
      batchSize?: number;
      quotaGate?: RuntimeQuotaGate;
    } = {},
  ) {}

  setBeforePause(
    handler: (
      environmentId: string,
      store: SandpiStore,
    ) => Promise<void> | void,
  ) {
    this.beforePause = handler;
  }

  async start() {
    if (this.started || this.runtime.mode === "unconfigured") return;
    this.started = true;
    // One slow Sandbox0 transition must not gate the whole API server. The
    // durable rows make this initial pass safe to finish in the background.
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Initial Environment lifecycle reconciliation deferred",
      );
    });
    this.schedule();
  }

  async close() {
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.reconciliation;
  }

  reconcileOnce(): Promise<void> {
    if (this.closed || this.runtime.mode === "unconfigured") {
      return Promise.resolve();
    }
    this.reconciliationRequested = true;
    if (this.reconciliation) return this.reconciliation;
    const run = this.runRequestedReconciliations().finally(() => {
      if (this.reconciliation === run) this.reconciliation = undefined;
    });
    this.reconciliation = run;
    return run;
  }

  private async runRequestedReconciliations() {
    do {
      this.reconciliationRequested = false;
      await this.reconcileLifecycle();
    } while (this.reconciliationRequested && !this.closed);
  }

  async pauseForQuota(environmentId: string) {
    if (this.closed || this.runtime.mode === "unconfigured") return;
    await this.store.withEnvironmentLifecycleLock(
      environmentId,
      async (lockedStore) => {
        const scopedStore = lockedStore ?? this.store;
        if (
          this.options.quotaGate?.isEnvironmentRuntimeBlocked &&
          !(await this.options.quotaGate.isEnvironmentRuntimeBlocked(
            environmentId,
          ))
        ) {
          return;
        }
        const runtime =
          await scopedStore.prepareEnvironmentQuotaPause(environmentId);
        if (!runtime) return;
        try {
          await this.beforePause?.(environmentId, scopedStore);
          await this.runtime.pauseEnvironment(
            runtime,
            this.controller.signal,
          );
          await scopedStore.recordEnvironmentPaused(
            environmentId,
            runtime.sandboxId,
            "quota",
          );
          this.logger.info(
            { environmentId },
            "Quota-blocked Environment Sandbox paused",
          );
        } catch (error) {
          await scopedStore.recordEnvironmentQuotaPauseFailure(
            environmentId,
            runtime.sandboxId,
            errorMessage(error),
          );
          throw error;
        }
      },
    );
  }

  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.reconcileOnce()
        .catch((error) => {
          this.logger.warn(
            { error: errorMessage(error) },
            "Environment lifecycle reconciliation failed",
          );
        })
        .finally(() => this.schedule());
    }, this.options.pollIntervalMs ?? 5_000);
    this.timer.unref();
  }

  private async reconcileLifecycle() {
    const limit = this.options.batchSize ?? 50;
    const runtimeConfigCandidates =
      await this.store.environmentRuntimeConfigCandidateIds(limit);
    for (const environmentId of runtimeConfigCandidates) {
      await this.store.withEnvironmentLifecycleLock(
        environmentId,
        async (lockedStore) => {
          const scopedStore = lockedStore ?? this.store;
          const prepared =
            await scopedStore.prepareEnvironmentRuntimeConfig(environmentId);
          if (!prepared) return;
          try {
            const credentials =
              await scopedStore.listEnvironmentEgressCredentialsByEnvironmentId(
                environmentId,
              );
            // Apply the complete desired snapshot on every attempt. Both
            // Sandbox0 updates are idempotent, so a crash between either call
            // and the PostgreSQL acknowledgement is recoverable.
            await this.runtime.updateEnvironmentNetworkPolicy(
              prepared.runtime,
              prepared.networkPolicy,
              credentials,
            );
            await this.runtime.updateEnvironmentMemory(
              prepared.runtime,
              prepared.sandboxMemoryMiB,
            );
            const generationCurrent =
              await scopedStore.recordEnvironmentRuntimeConfigApplied(
                environmentId,
                prepared.runtime.sandboxId,
                prepared.generation,
                prepared.sandboxMemoryMiB,
              );
            this.logger.info(
              {
                environmentId,
                generation: prepared.generation,
                generationCurrent,
              },
              generationCurrent
                ? "Environment runtime configuration applied"
                : "Environment runtime configuration was superseded",
            );
          } catch (error) {
            const retryExponent = Math.min(
              prepared.runtime.runtimeConfigAttemptCount,
              6,
            );
            const retryDelayMs = Math.min(
              RUNTIME_CONFIG_RETRY_MAX_MS,
              RUNTIME_CONFIG_RETRY_BASE_MS * 2 ** retryExponent,
            );
            await scopedStore.recordEnvironmentRuntimeConfigFailure(
              environmentId,
              prepared.runtime.sandboxId,
              prepared.generation,
              errorMessage(error),
              new Date(Date.now() + retryDelayMs),
            );
            this.logger.warn(
              {
                environmentId,
                generation: prepared.generation,
                retryDelayMs,
                error: errorMessage(error),
              },
              "Environment runtime configuration deferred",
            );
          }
        },
      );
    }

    const policyCandidates =
      await this.store.environmentLifecyclePolicyCandidateIds(limit);
    for (const environmentId of policyCandidates) {
      await this.store.withEnvironmentLifecycleLock(environmentId, async (lockedStore) => {
        const scopedStore = lockedStore ?? this.store;
        const runtime =
          await scopedStore.prepareEnvironmentLifecyclePolicy(environmentId);
        if (!runtime) return;
        try {
          await this.runtime.applyEnvironmentLifecyclePolicy(runtime);
          await scopedStore.recordEnvironmentLifecyclePolicy(
            environmentId,
            runtime.sandboxId,
          );
          this.logger.info(
            {
              environmentId,
              policyVersion: ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
            },
            "Environment Sandbox lifecycle policy applied",
          );
        } catch (error) {
          await scopedStore.recordEnvironmentLifecycleError(
            environmentId,
            runtime.sandboxId,
            errorMessage(error),
          );
          this.logger.warn(
            { environmentId, error: errorMessage(error) },
            "Environment Sandbox lifecycle policy deferred",
          );
        }
      });
    }

    const pauseCandidates =
      await this.store.environmentIdlePauseCandidateIds(limit);
    for (const environmentId of pauseCandidates) {
      await this.store.withEnvironmentLifecycleLock(environmentId, async (lockedStore) => {
        const scopedStore = lockedStore ?? this.store;
        const runtime = await scopedStore.prepareEnvironmentIdlePause(
          environmentId,
        );
        if (!runtime) return;
        try {
          // Stop this replica's retained Supervisor stream before Sandbox0
          // closes it, so a concurrent wake cannot make the old worker treat
          // the intentional pause as a runtime failure that needs recovery.
          await this.beforePause?.(environmentId, scopedStore);
          await this.runtime.pauseEnvironment(runtime, this.controller.signal);
          await scopedStore.recordEnvironmentPaused(
            environmentId,
            runtime.sandboxId,
          );
          this.logger.info({ environmentId }, "Idle Environment Sandbox paused");
        } catch (error) {
          await scopedStore.recordEnvironmentPauseFailure(
            environmentId,
            runtime.sandboxId,
            errorMessage(error),
          );
          this.logger.warn(
            { environmentId, error: errorMessage(error) },
            "Environment Sandbox pause deferred",
          );
        }
      });
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
