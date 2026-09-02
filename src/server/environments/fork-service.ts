import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { HttpError, conflict } from "@/server/http-error";
import type { RuntimeAdapter } from "@/server/runtime/types";
import type { EnvironmentQuotaPolicy } from "@/server/billing/quota-service";
import {
  type EnvironmentForkOperation,
  SandpiStore,
} from "@/server/store";

const ENVIRONMENT_FORK_IDEMPOTENCY_OPERATION = "environment-fork-v2";
const ENVIRONMENT_FORK_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const ENVIRONMENT_FORK_RECOVERY_INTERVAL_MS = 30_000;

interface EnvironmentForkLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Joins Sandpi metadata to Sandbox0's deterministic RootFS fork. Both sides
 * use stable operation identities, so a lost response resumes the same paused
 * child instead of creating a second Sandbox.
 */
export class EnvironmentForkService {
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryPromise?: Promise<void>;
  private beforeFork?: (
    environmentId: string,
    store: SandpiStore,
  ) => Promise<void> | void;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: EnvironmentForkLogger,
    private readonly quota?: EnvironmentQuotaPolicy,
  ) {}

  setBeforeFork(
    handler: (
      environmentId: string,
      store: SandpiStore,
    ) => Promise<void> | void,
  ) {
    this.beforeFork = handler;
  }

  start() {
    if (this.runtime.mode === "unconfigured" || this.recoveryTimer) return;
    const recover = () => {
      if (this.recoveryPromise) return;
      this.recoveryPromise = this.reconcilePending()
        .catch((error) => {
          this.logger.warn({ err: error }, "Environment fork recovery deferred");
        })
        .finally(() => {
          this.recoveryPromise = undefined;
        });
    };
    recover();
    this.recoveryTimer = setInterval(
      recover,
      ENVIRONMENT_FORK_RECOVERY_INTERVAL_MS,
    );
    this.recoveryTimer.unref();
  }

  async close() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.recoveryPromise;
  }

  async reconcilePending() {
    const operations = await this.store.environmentForkOperationsNeedingRecovery();
    for (const operation of operations) {
      if (!operation.sourceEnvironmentId && operation.phase !== "native-ready") {
        const message =
          "The source Environment was deleted before its native fork completed.";
        await this.store.failEnvironmentFork(
          operation.targetEnvironmentId,
          message,
        );
        this.logger.warn(
          { environmentId: operation.targetEnvironmentId },
          "Environment fork recovery failed because its source is gone",
        );
        continue;
      }
      const lockEnvironmentId =
        operation.sourceEnvironmentId ?? operation.targetEnvironmentId;
      try {
        await this.waitForLifecycleLock(lockEnvironmentId, (scopedStore) =>
          this.resumeOperation(scopedStore, operation.userId, operation),
        );
      } catch (error) {
        this.logger.warn(
          { err: error, environmentId: operation.targetEnvironmentId },
          "Environment fork recovery deferred",
        );
      }
    }
  }

  async create(input: {
    userId: string;
    sourceEnvironmentId: string;
    sourceSnapshotId?: string;
    name: string;
    idempotencyKey: string;
  }) {
    if (this.runtime.mode === "unconfigured") {
      throw new HttpError(
        503,
        "sandbox0_not_configured",
        "This Sandpi deployment has not configured Sandbox0.",
      );
    }
    await this.store.getManageableEnvironment(
      input.userId,
      input.sourceEnvironmentId,
    );
    const fingerprint = JSON.stringify({
      sourceEnvironmentId: input.sourceEnvironmentId,
      sourceSnapshotId: input.sourceSnapshotId ?? null,
      name: input.name,
    });
    const claim = await this.store.claimIdempotentResource({
      userId: input.userId,
      operation: ENVIRONMENT_FORK_IDEMPOTENCY_OPERATION,
      key: input.idempotencyKey,
      requestFingerprint: fingerprint,
      resourceId: `env_${randomUUID()}`,
      expiresAt: new Date(Date.now() + ENVIRONMENT_FORK_IDEMPOTENCY_TTL_MS),
    });
    if (claim.status === "completed") {
      return this.store.getEnvironment(input.userId, claim.resourceId);
    }
    if (claim.status === "failed") {
      throw new HttpError(
        claim.responseStatus ?? 500,
        objectString(claim.responseBody, "code") ?? "environment_fork_failed",
        objectString(claim.responseBody, "message") ??
          "The Environment fork failed.",
      );
    }

    const environment = await this.waitForLifecycleLock(
      input.sourceEnvironmentId,
      async (scopedStore) => {
        let operation = await readOptionalForkOperation(
          scopedStore,
          claim.resourceId,
        );
        if (!operation) {
          const policy = await this.quota?.environmentCreationPolicy(
            input.userId,
          );
          try {
            operation = await scopedStore.createEnvironmentForkTarget({
              userId: input.userId,
              sourceEnvironmentId: input.sourceEnvironmentId,
              targetEnvironmentId: claim.resourceId,
              name: input.name,
              operationId: `sandpi-environment-fork-${claim.resourceId}`,
              sourceSnapshotId: input.sourceSnapshotId,
              environmentLimit: policy?.environmentLimit,
            });
          } catch (error) {
            // A concurrent retry can win the metadata insert after both saw a
            // fresh idempotency row. Resolve that race from the durable saga.
            operation = await readOptionalForkOperation(
              scopedStore,
              claim.resourceId,
            );
            if (!operation) throw error;
          }
        }
        if (operation.sourceEnvironmentId !== input.sourceEnvironmentId) {
          throw conflict(
            "environment_fork_source_changed",
            "The Environment fork is bound to a different source.",
          );
        }
        if (operation.sourceSnapshotId !== input.sourceSnapshotId) {
          throw conflict(
            "environment_fork_snapshot_changed",
            "The Environment fork is bound to a different source snapshot.",
          );
        }
        return this.resumeOperation(scopedStore, input.userId, operation);
      },
    );

    await this.store.completeIdempotentResource({
      userId: input.userId,
      operation: ENVIRONMENT_FORK_IDEMPOTENCY_OPERATION,
      key: input.idempotencyKey,
      requestFingerprint: fingerprint,
      resourceId: claim.resourceId,
    });
    return environment;
  }

  private async resumeOperation(
    scopedStore: SandpiStore,
    userId: string,
    initialOperation: EnvironmentForkOperation,
  ) {
    const operation = await scopedStore.getEnvironmentForkOperation(
      initialOperation.targetEnvironmentId,
    );
    if (operation.phase === "failed") {
      throw new HttpError(
        502,
        "environment_fork_failed",
        operation.lastError ?? "The Environment fork failed.",
      );
    }
    if (operation.phase === "completed") {
      return scopedStore.getEnvironment(userId, operation.targetEnvironmentId);
    }

    let targetRuntime;
    if (operation.phase === "native-ready" && operation.sandboxId) {
      targetRuntime = await scopedStore.getEnvironmentRuntime(
        userId,
        operation.targetEnvironmentId,
      );
    } else {
      if (!operation.sourceEnvironmentId) {
        throw conflict(
          "environment_fork_source_deleted",
          "The source Environment was deleted before its native fork completed.",
        );
      }
      const sourceRuntime = await scopedStore.getEnvironmentRuntime(
        userId,
        operation.sourceEnvironmentId,
      );
      await this.beforeFork?.(operation.sourceEnvironmentId, scopedStore);
      await scopedStore.markEnvironmentForkStarted(
        operation.targetEnvironmentId,
      );
      const forked = await this.runtime.forkEnvironment({
        source: sourceRuntime,
        sourceSnapshotId: operation.sourceSnapshotId,
        operationId: operation.operationId,
      });
      await scopedStore.recordEnvironmentForkSandbox(
        operation.targetEnvironmentId,
        forked.sandboxId,
        forked.runtimeGeneration,
      );
      targetRuntime = await scopedStore.getEnvironmentRuntime(
        userId,
        operation.targetEnvironmentId,
      );
    }

    const target = await scopedStore.getManageableEnvironment(
      userId,
      operation.targetEnvironmentId,
    );
    // Sandbox0 forks inherit native configuration, including credential
    // source references. The child stays paused and is not published until
    // Sandpi removes those references and reapplies the cloned non-secret
    // policy stored on the target Environment.
    await this.runtime.updateEnvironmentNetworkPolicy(
      targetRuntime,
      target.networkPolicy,
      [],
    );
    await scopedStore.completeEnvironmentFork(operation.targetEnvironmentId);
    this.logger.info(
      {
        sourceEnvironmentId: operation.sourceEnvironmentId,
        sourceSnapshotId: operation.sourceSnapshotId,
        environmentId: operation.targetEnvironmentId,
        sandboxId: targetRuntime.sandboxId,
      },
      "Environment fork completed",
    );
    return scopedStore.getEnvironment(userId, operation.targetEnvironmentId);
  }

  private async waitForLifecycleLock<T>(
    sourceEnvironmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ) {
    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline) {
      const result = await this.store.withEnvironmentLifecycleLock(
        sourceEnvironmentId,
        operation,
      );
      if (result.acquired) return result.value;
      await delay(250);
    }
    this.logger.warn(
      { sourceEnvironmentId },
      "Timed out waiting to fork Environment",
    );
    throw new HttpError(
      503,
      "environment_lifecycle_busy",
      "Timed out waiting for the Environment lifecycle lock.",
    );
  }
}

async function readOptionalForkOperation(
  store: SandpiStore,
  targetEnvironmentId: string,
) {
  try {
    return await store.getEnvironmentForkOperation(targetEnvironmentId);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.code === "environment_fork_not_found"
    ) {
      return undefined;
    }
    throw error;
  }
}

function objectString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}
