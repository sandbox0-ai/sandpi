import { setTimeout as delay } from "node:timers/promises";

import { HttpError } from "@/server/http-error";
import type { RuntimeQuotaGate } from "@/server/billing/quota-service";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type { SandpiStore, StoredEnvironmentRuntime } from "@/server/store";

const RUNTIME_ACCESS_LOCK_TIMEOUT_MS = 130_000;
const RUNTIME_ACCESS_LOCK_RETRY_MS = 250;

interface EnvironmentRuntimeAccessOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  quotaGate?: RuntimeQuotaGate;
}

type RuntimeAdmission<T> =
  | { kind: "ready"; value: T }
  | { kind: "repair" };

/**
 * Admits harness-neutral Workspace and Terminal operations without starting a
 * harness protocol. The native operation is the warm-path health check:
 * recovery only runs after that access reports a wake-up or Workspace portal
 * failure.
 */
export class EnvironmentRuntimeAccessService {
  private readonly repairs = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly options: EnvironmentRuntimeAccessOptions = {},
  ) {}

  async withRuntimeAccess<T>(
    userId: string,
    environmentId: string,
    operation: (runtime: StoredEnvironmentRuntime) => Promise<T>,
  ): Promise<T> {
    // Authorize before waiting on a lifecycle transition. The runtime is read
    // again under the shared lock so deletion and recovery cannot change its
    // coordinates while the operation is admitted.
    await this.store.getEnvironment(userId, environmentId);
    const deadline =
      Date.now() +
      (this.options.lockTimeoutMs ?? RUNTIME_ACCESS_LOCK_TIMEOUT_MS);
    let repaired = false;

    while (true) {
      const locked = await this.store.withEnvironmentRuntimeAccessLock(
        environmentId,
        async (lockedStore): Promise<RuntimeAdmission<T>> => {
          const scopedStore = lockedStore ?? this.store;
          const current = await scopedStore.getEnvironmentRuntime(
            userId,
            environmentId,
          );
          requireAccessibleEnvironment(current);
          await this.options.quotaGate?.assertEnvironmentRuntimeAllowed(
            environmentId,
          );

          let value: T;
          try {
            value = await operation(current);
          } catch (error) {
            if (
              repaired ||
              !isRecoverableEnvironmentAccessError(error)
            ) {
              throw error;
            }
            // Never repair while holding the shared admission lock. Repair can
            // pause the Sandbox to rebuild a disconnected Workspace portal,
            // which must own the lifecycle lock exclusively.
            return { kind: "repair" };
          }
          await scopedStore.recordEnvironmentRuntimeAccess(environmentId);
          return { kind: "ready", value };
        },
      );
      if (locked.acquired) {
        if (locked.value.kind === "ready") return locked.value.value;
        await this.repairEnvironmentRuntime(userId, environmentId, deadline);
        repaired = true;
        continue;
      }
      await this.waitForLifecycleLock(deadline);
    }
  }

  private async repairEnvironmentRuntime(
    userId: string,
    environmentId: string,
    deadline: number,
  ) {
    const pending = this.repairs.get(environmentId);
    if (pending) {
      await pending;
      return;
    }

    const repair = this.repairEnvironmentRuntimeWithLock(
      userId,
      environmentId,
      deadline,
    );
    this.repairs.set(environmentId, repair);
    void repair
      .finally(() => {
        if (this.repairs.get(environmentId) === repair) {
          this.repairs.delete(environmentId);
        }
      })
      .catch(() => undefined);
    await repair;
  }

  private async repairEnvironmentRuntimeWithLock(
    userId: string,
    environmentId: string,
    deadline: number,
  ) {
    while (true) {
      const locked = await this.store.withEnvironmentLifecycleLock(
        environmentId,
        async (lockedStore) => {
          const scopedStore = lockedStore ?? this.store;
          // Re-read through the user-scoped store boundary after acquiring the
          // exclusive lock. Deletion, ownership, and runtime coordinates may
          // all have changed since the failed shared admission.
          const current = await scopedStore.getEnvironmentRuntime(
            userId,
            environmentId,
          );
          requireAccessibleEnvironment(current);
          await this.options.quotaGate?.assertEnvironmentRuntimeAllowed(
            environmentId,
          );
          await this.runtime.ensureEnvironmentRuntimeAccess(current);
        },
      );
      if (locked.acquired) return;
      await this.waitForLifecycleLock(deadline);
    }
  }

  private async waitForLifecycleLock(deadline: number) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new HttpError(
        503,
        "environment_lifecycle_busy",
        "The Environment lifecycle is still changing. Try again shortly.",
      );
    }
    await delay(
      Math.min(
        remainingMs,
        this.options.lockRetryMs ?? RUNTIME_ACCESS_LOCK_RETRY_MS,
      ),
    );
  }

  /**
   * Best-effort keepalive for a live native connection. It never waits for a
   * lifecycle transition and never wakes Sandbox0; losing the shared lock just
   * skips this heartbeat.
   */
  async touchRunningRuntime(environmentId: string) {
    const locked = await this.store.withEnvironmentRuntimeAccessLock(
      environmentId,
      (lockedStore) =>
        (lockedStore ?? this.store).touchRunningEnvironmentRuntime(
          environmentId,
        ),
    );
    return locked.acquired && locked.value;
  }
}

function requireAccessibleEnvironment(runtime: StoredEnvironmentRuntime) {
  if (
    runtime.desiredState === "terminated" ||
    runtime.observedState === "terminated"
  ) {
    throw new HttpError(
      409,
      "environment_terminated",
      "The Environment is being deleted.",
    );
  }
}

function isRecoverableEnvironmentAccessError(error: unknown) {
  if (
    error instanceof HttpError &&
    error.code === "sandbox0_workspace_unavailable"
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("sandbox is waking up") ||
    message.includes("transport endpoint is not connected")
  );
}
