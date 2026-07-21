import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore } from "@/server/store";
import {
  ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
} from "./lifecycle-policy";

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
    private readonly options: { pollIntervalMs?: number; batchSize?: number } = {},
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

  async reconcileOnce() {
    if (this.closed || this.runtime.mode === "unconfigured") return;
    if (this.reconciliation) return this.reconciliation;
    const run = this.reconcileLifecycle().finally(() => {
      if (this.reconciliation === run) this.reconciliation = undefined;
    });
    this.reconciliation = run;
    return run;
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
