import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore, StoredEnvironmentRuntime } from "@/server/store";
import {
  ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
} from "./lifecycle-policy";

interface LifecycleLogger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface EnvironmentRuntimeLease {
  runtime: StoredEnvironmentRuntime;
  /** True when the native harness must reconcile a new runtime generation. */
  resumed: boolean;
}

/**
 * Executes durable Environment lifecycle timers. PostgreSQL stores deadlines;
 * this process only scans due rows, so any Sandpi replica can take over after
 * a crash without owning a unique in-memory timer service.
 */
export class EnvironmentLifecycleService {
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private closed = false;
  private started = false;
  private readonly controller = new AbortController();
  private beforePause?: (environmentId: string) => void;
  private readonly wakeups = new Map<string, Promise<EnvironmentRuntimeLease>>();

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: LifecycleLogger,
    private readonly options: { pollIntervalMs?: number; batchSize?: number } = {},
  ) {}

  setBeforePause(handler: (environmentId: string) => void) {
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
    await Promise.allSettled(this.wakeups.values());
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

  async ensureEnvironmentRunning(
    userId: string,
    environmentId: string,
  ): Promise<EnvironmentRuntimeLease> {
    // Authorize before waiting on a shared advisory lock.
    const current = await this.store.getEnvironmentRuntime(userId, environmentId);
    if (
      current.desiredState === "running" &&
      current.observedState === "running"
    ) {
      return { runtime: current, resumed: false };
    }
    return this.ensureEnvironmentRunningById(environmentId);
  }

  async ensureEnvironmentRunningById(
    environmentId: string,
  ): Promise<EnvironmentRuntimeLease> {
    const current = await this.store.environmentRuntime(environmentId);
    if (
      current.desiredState === "running" &&
      current.observedState === "running"
    ) {
      return { runtime: current, resumed: false };
    }
    const active = this.wakeups.get(environmentId);
    if (active) return active;
    const wakeup = this.performEnvironmentWake(environmentId).finally(() => {
      if (this.wakeups.get(environmentId) === wakeup) {
        this.wakeups.delete(environmentId);
      }
    });
    this.wakeups.set(environmentId, wakeup);
    return wakeup;
  }

  private async performEnvironmentWake(
    environmentId: string,
  ): Promise<EnvironmentRuntimeLease> {
    const deadline = Date.now() + 130_000;
    while (!this.closed) {
      const current = await this.store.environmentRuntime(environmentId);
      if (
        current.desiredState === "running" &&
        current.observedState === "running"
      ) {
        return { runtime: current, resumed: false };
      }
      const result = await this.store.withEnvironmentLifecycleLock(
        environmentId,
        async () => {
          const before = await this.store.environmentRuntime(environmentId);
          if (
            before.desiredState === "running" &&
            before.observedState === "running"
          ) {
            return { runtime: before, resumed: false };
          }

          const requested = await this.store.requestEnvironmentRunning(
            environmentId,
          );
          try {
            const lifecycle = await this.runtime.resumeEnvironment(
              requested,
              this.controller.signal,
            );
            const runtime = await this.store.recordEnvironmentResumed(
              environmentId,
              requested.sandboxId,
              lifecycle.hardExpiresAt,
            );
            this.logger.info({ environmentId }, "Environment Sandbox resumed");
            return {
              runtime,
              resumed: lifecycle.resumed || before.observedState !== "running",
            };
          } catch (error) {
            await this.store.recordEnvironmentResumeFailure(
              environmentId,
              requested.sandboxId,
              errorMessage(error),
            );
            throw error;
          }
        },
      );
      if (result.acquired) return result.value;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Environment lifecycle lock");
      }
      // Do not queue PostgreSQL sessions behind a slow external resume. One
      // short try-lock per replica keeps the connection pool available to all
      // control-plane and bootstrap requests.
      await delay(250);
    }
    throw new Error("Environment lifecycle service is closed");
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
      await this.store.withEnvironmentLifecycleLock(environmentId, async () => {
        const runtime =
          await this.store.prepareEnvironmentLifecyclePolicy(environmentId);
        if (!runtime) return;
        const target = runtime.hardExpiresAt;
        if (!target) return;
        try {
          // Retrying after a process crash preserves the original absolute
          // target instead of silently granting a fresh 30-day lifetime.
          const remainingSeconds = Math.max(
            1,
            Math.ceil((target.getTime() - Date.now()) / 1_000),
          );
          const configured = await this.runtime.configureEnvironmentLifecycle(
            runtime,
            remainingSeconds,
          );
          await this.store.recordEnvironmentLifecyclePolicy(
            environmentId,
            runtime.sandboxId,
            configured.hardExpiresAt,
          );
          this.logger.info(
            {
              environmentId,
              policyVersion: ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
              hardExpiresAt: configured.hardExpiresAt.toISOString(),
            },
            "Environment Sandbox lifecycle policy applied",
          );
        } catch (error) {
          await this.store.recordEnvironmentLifecycleError(
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
      await this.store.withEnvironmentLifecycleLock(environmentId, async () => {
        const runtime = await this.store.prepareEnvironmentIdlePause(
          environmentId,
        );
        if (!runtime) return;
        try {
          // Stop this replica's retained Supervisor stream before Sandbox0
          // closes it, so a concurrent wake cannot make the old worker treat
          // the intentional pause as a runtime failure that needs recovery.
          this.beforePause?.(environmentId);
          await this.runtime.pauseEnvironment(runtime, this.controller.signal);
          await this.store.recordEnvironmentPaused(
            environmentId,
            runtime.sandboxId,
          );
          this.logger.info({ environmentId }, "Idle Environment Sandbox paused");
        } catch (error) {
          await this.store.recordEnvironmentPauseFailure(
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

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
