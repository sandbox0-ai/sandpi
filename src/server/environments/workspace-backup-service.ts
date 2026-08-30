import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Environment,
  EnvironmentWorkspaceBackup,
} from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import { conflict, HttpError } from "@/server/http-error";
import type {
  RuntimeAdapter,
  RuntimeWorkspaceBackupSnapshot,
} from "@/server/runtime/types";
import type { SandpiStore } from "@/server/store";

interface WorkspaceBackupLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Creates native Sandbox rootfs snapshots and reconciles their retention.
 * PostgreSQL owns scheduling and the Sandpi-created snapshot journal, while
 * Sandbox0 remains authoritative for snapshot bytes and storage metering.
 */
export class EnvironmentWorkspaceBackupService {
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private closed = false;
  private started = false;
  private beforeRestore?: (
    environmentId: string,
    store: SandpiStore,
  ) => Promise<void> | void;
  private afterRestoreAttempt?: (
    environmentId: string,
    result: { nativeRestored: boolean; resumeAfterRestore: boolean },
  ) => Promise<void> | void;

  constructor(
    private readonly store: SandpiStore,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: WorkspaceBackupLogger,
    private readonly options: { pollIntervalMs?: number; batchSize?: number } = {},
  ) {}

  setRestoreHooks(input: {
    before: (
      environmentId: string,
      store: SandpiStore,
    ) => Promise<void> | void;
    afterAttempt: (
      environmentId: string,
      result: { nativeRestored: boolean; resumeAfterRestore: boolean },
    ) => Promise<void> | void;
  }) {
    this.beforeRestore = input.before;
    this.afterRestoreAttempt = input.afterAttempt;
  }

  async start() {
    if (this.started || this.runtime.mode === "unconfigured") return;
    this.started = true;
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Initial Environment Workspace backup reconciliation deferred",
      );
    });
    this.schedule();
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.reconciliation;
  }

  async reconcileOnce() {
    if (this.closed || this.runtime.mode === "unconfigured") return;
    if (this.reconciliation) return this.reconciliation;
    const run = this.reconcileDueBackups().finally(() => {
      if (this.reconciliation === run) this.reconciliation = undefined;
    });
    this.reconciliation = run;
    return run;
  }

  async list(userId: string, environmentId: string) {
    return this.store.listEnvironmentWorkspaceBackups(userId, environmentId);
  }

  async createNow(
    userId: string,
    environmentId: string,
  ): Promise<{
    backup: EnvironmentWorkspaceBackup;
    environment: Environment;
  }> {
    if (this.runtime.mode === "unconfigured") {
      throw new HttpError(
        503,
        "sandbox0_not_configured",
        "This Sandpi deployment has not configured Sandbox0.",
      );
    }
    await this.store.getManageableEnvironment(userId, environmentId);
    return this.waitForLifecycleLock(environmentId, async (scopedStore) => {
      await scopedStore.getManageableEnvironment(userId, environmentId);
      await scopedStore.assertEnvironmentWorkspaceQuiescent(environmentId);
      const backup = await this.runBackup(scopedStore, environmentId, true);
      if (!backup) {
        throw conflict(
          "environment_runtime_not_ready",
          "The Environment Workspace is not ready to back up.",
        );
      }
      return {
        backup,
        environment: await scopedStore.getManageableEnvironment(
          userId,
          environmentId,
        ),
      };
    });
  }

  async restore(
    userId: string,
    environmentId: string,
    snapshotId: string,
    confirmation: string,
  ): Promise<{
    backup: EnvironmentWorkspaceBackup;
    environment: Environment;
    unavailableSessionCount: number;
  }> {
    if (this.runtime.mode === "unconfigured") {
      throw new HttpError(
        503,
        "sandbox0_not_configured",
        "This Sandpi deployment has not configured Sandbox0.",
      );
    }
    const environment = await this.store.getManageableEnvironment(
      userId,
      environmentId,
    );
    assertRestoreConfirmation(environment, confirmation);

    return this.waitForLifecycleLock(environmentId, async (scopedStore) => {
      const lockedEnvironment = await scopedStore.getManageableEnvironment(
        userId,
        environmentId,
      );
      assertRestoreConfirmation(lockedEnvironment, confirmation);
      if (lockedEnvironment.status !== "ready") {
        throw conflict(
          "environment_runtime_not_ready",
          "The Environment Workspace is not ready to restore.",
        );
      }
      const prepared = await scopedStore.prepareEnvironmentWorkspaceRestore(
        environmentId,
        snapshotId,
      );
      let lifecycleStarted = false;
      let nativeRestored = false;
      try {
        await this.beforeRestore?.(environmentId, scopedStore);
        lifecycleStarted = true;
        await this.runtime.pauseEnvironment(prepared.runtime);
        await this.runtime.restoreEnvironmentWorkspaceBackup(
          prepared.runtime,
          snapshotId,
        );
        nativeRestored = true;
        const sessionResult =
          await scopedStore.recordEnvironmentWorkspaceRestored(
            environmentId,
            prepared.runtime.sandboxId,
            snapshotId,
          );

        if (prepared.resumeAfterRestore) {
          // A supported Workspace access is Sandbox0's native auto-resume
          // boundary. Sandpi deliberately does not race it with an explicit
          // resume request.
          await this.runtime.ensureEnvironmentRuntimeAccess(prepared.runtime);
          await scopedStore.recordEnvironmentRuntimeAccess(environmentId);
        } else {
          await scopedStore.recordEnvironmentPaused(
            environmentId,
            prepared.runtime.sandboxId,
          );
        }
        const refreshed = await scopedStore.getManageableEnvironment(
          userId,
          environmentId,
        );
        this.logger.info(
          {
            environmentId,
            snapshotId,
            unavailableSessionCount: sessionResult.unavailableSessionCount,
          },
          "Environment Workspace backup restored",
        );
        return {
          backup: prepared.backup,
          environment: refreshed,
          unavailableSessionCount: sessionResult.unavailableSessionCount,
        };
      } catch (error) {
        if (lifecycleStarted && prepared.resumeAfterRestore) {
          await this.runtime
            .ensureEnvironmentRuntimeAccess(prepared.runtime)
            .then(() => scopedStore.recordEnvironmentRuntimeAccess(environmentId))
            .catch((recoveryError) => {
              this.logger.warn(
                {
                  environmentId,
                  error: errorMessage(recoveryError),
                },
                "Environment runtime recovery after Workspace restore failure deferred",
              );
            });
        }
        throw error;
      } finally {
        if (lifecycleStarted) {
          await Promise.resolve(
            this.afterRestoreAttempt?.(environmentId, {
              nativeRestored,
              resumeAfterRestore: prepared.resumeAfterRestore,
            }),
          ).catch((error: unknown) => {
            this.logger.warn(
              { environmentId, error: errorMessage(error) },
              "Workspace restore client invalidation deferred",
            );
          });
        }
      }
    });
  }

  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.reconcileOnce()
        .catch((error) => {
          this.logger.warn(
            { error: errorMessage(error) },
            "Environment Workspace backup reconciliation failed",
          );
        })
        .finally(() => this.schedule());
    }, this.options.pollIntervalMs ?? 5_000);
    this.timer.unref();
  }

  private async reconcileDueBackups() {
    const candidates = await this.store.environmentWorkspaceBackupCandidateIds(
      this.options.batchSize ?? 20,
    );
    for (const environmentId of candidates) {
      await this.store.withEnvironmentLifecycleLock(
        environmentId,
        async (lockedStore) => {
          const scopedStore = lockedStore ?? this.store;
          try {
            await this.runBackup(scopedStore, environmentId, false);
          } catch (error) {
            this.logger.warn(
              { environmentId, error: errorMessage(error) },
              "Environment Workspace backup deferred",
            );
          }
        },
      );
    }
  }

  private async runBackup(
    store: SandpiStore,
    environmentId: string,
    forceCreate: boolean,
  ): Promise<EnvironmentWorkspaceBackup | undefined> {
    const prepared = await store.prepareEnvironmentWorkspaceBackup(
      environmentId,
      forceCreate,
    );
    if (!prepared) return undefined;

    const kind = forceCreate ? "manual" : "automatic";
    let backup: EnvironmentWorkspaceBackup | undefined;
    if (prepared.createBackup) {
      let snapshot: RuntimeWorkspaceBackupSnapshot;
      try {
        snapshot = await this.runtime.createEnvironmentWorkspaceBackup(
          prepared.runtime,
          workspaceBackupIdentity(environmentId, kind),
        );
      } catch (error) {
        await store
          .recordEnvironmentWorkspaceBackupFailure(
            environmentId,
            prepared.runtime.sandboxId,
            errorMessage(error),
          )
          .catch(() => undefined);
        throw error;
      }

      try {
        await store.recordEnvironmentWorkspaceBackup(
          environmentId,
          prepared.runtime.sandboxId,
          snapshot,
          kind,
        );
      } catch (error) {
        await this.runtime
          .deleteEnvironmentWorkspaceBackup(prepared.runtime, snapshot.id)
          .catch((cleanupError) => {
            this.logger.warn(
              {
                environmentId,
                snapshotId: snapshot.id,
                error: errorMessage(cleanupError),
              },
              "Unrecorded Workspace backup cleanup deferred to Sandbox0",
            );
          });
        await store
          .recordEnvironmentWorkspaceBackupFailure(
            environmentId,
            prepared.runtime.sandboxId,
            errorMessage(error),
          )
          .catch(() => undefined);
        throw error;
      }

      backup = {
        id: snapshot.id,
        environmentId,
        name: snapshot.name,
        kind,
        createdAt: toUnixTimestamp(snapshot.createdAt),
      };
      this.logger.info(
        { environmentId, snapshotId: snapshot.id, kind },
        "Environment Workspace backup created",
      );
    }

    try {
      const expired = await store.environmentWorkspaceBackupsBeyondRetention(
        environmentId,
        prepared.retentionCount,
      );
      for (const candidate of expired) {
        await this.runtime.deleteEnvironmentWorkspaceBackup(
          prepared.runtime,
          candidate.id,
        );
        await store.deleteEnvironmentWorkspaceBackupRecord(
          environmentId,
          candidate.id,
        );
      }
      await store.recordEnvironmentWorkspaceBackupHealthy(
        environmentId,
        prepared.runtime.sandboxId,
      );
    } catch (error) {
      await store
        .recordEnvironmentWorkspaceBackupFailure(
          environmentId,
          prepared.runtime.sandboxId,
          `Retention cleanup failed: ${errorMessage(error)}`,
        )
        .catch(() => undefined);
      // A newly created backup remains a successful user action. Persist the
      // cleanup failure for the scheduler instead of hiding that backup behind
      // a failed manual response.
      if (!backup) throw error;
      this.logger.warn(
        { environmentId, error: errorMessage(error) },
        "Environment Workspace backup retention deferred",
      );
    }
    return backup;
  }

  private async waitForLifecycleLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline) {
      const result = await this.store.withEnvironmentLifecycleLock(
        environmentId,
        (lockedStore) => operation(lockedStore ?? this.store),
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

function workspaceBackupIdentity(
  environmentId: string,
  kind: EnvironmentWorkspaceBackup["kind"],
) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const suffix = randomUUID().slice(0, 8);
  return {
    name: `sandpi-workspace-${timestamp}-${suffix}`,
    description: `Sandpi ${kind} Environment rootfs backup for Environment ${environmentId}.`,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertRestoreConfirmation(
  environment: Environment,
  confirmation: string,
) {
  if (confirmation !== environment.name) {
    throw new HttpError(
      400,
      "environment_workspace_restore_confirmation_mismatch",
      "Type the current Environment name exactly to confirm this restore.",
    );
  }
}
