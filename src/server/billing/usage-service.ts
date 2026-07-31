import type { RuntimeAdapter } from "@/server/runtime/types";

import type { BillingQuotaService } from "./quota-service";
import type {
  BillingRepository,
  UsageWindowImport,
} from "./repository";

const USAGE_SOURCE = "sandbox0";
const RUNTIME_WINDOW_TYPE = "sandbox.runtime_mib_milliseconds";
const MAX_IMPORT_PAGES_PER_TICK = 100;

interface UsageServiceLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export class SandboxUsageService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private closed = false;
  private pauseForQuota?: (environmentId: string) => Promise<void>;
  private reconcilePlanMemory?: (environmentId: string) => Promise<void>;

  constructor(
    private readonly repository: BillingRepository,
    private readonly quota: BillingQuotaService,
    private readonly runtime: RuntimeAdapter,
    private readonly logger: UsageServiceLogger,
    private readonly intervalMs: number,
  ) {}

  setPauseForQuota(handler: (environmentId: string) => Promise<void>) {
    this.pauseForQuota = handler;
  }

  setReconcilePlanMemory(
    handler: (environmentId: string) => Promise<void>,
  ) {
    this.reconcilePlanMemory = handler;
  }

  start() {
    if (this.closed || this.timer || this.running) return;
    this.schedule(0);
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  async runOnce() {
    let importError: unknown;
    try {
      await this.importUsageWindows();
    } catch (error) {
      importError = error;
    }
    await this.enforcePlan();
    if (importError) throw importError;
  }

  private schedule(delayMs: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runOnce()
        .catch((error) => {
          this.logger.warn(
            { err: error },
            "Sandbox usage synchronization failed",
          );
        })
        .finally(() => {
          this.running = undefined;
          if (!this.closed) this.schedule(this.intervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }

  private async importUsageWindows() {
    if (this.runtime.mode !== "sandbox0") return;
    let cursor = await this.repository.usageCursor(USAGE_SOURCE);
    let imported = 0;
    for (let pageNumber = 0; pageNumber < MAX_IMPORT_PAGES_PER_TICK; pageNumber += 1) {
      const page = await this.runtime.listUsageWindows({
        cursor: cursor || undefined,
        limit: 1_000,
        windowType: RUNTIME_WINDOW_TYPE,
      });
      if (page.windows.length === 0) break;
      const nextCursor = page.nextCursor || cursor;
      const windows = page.windows
        .filter(
          (window) =>
            window.windowType === RUNTIME_WINDOW_TYPE &&
            window.unit === "mib_milliseconds" &&
            Boolean(window.sandboxId),
        )
        .map(
          (window): UsageWindowImport => ({
            windowId: window.windowId,
            sandboxId: window.sandboxId!,
            windowType: window.windowType,
            windowStartsAt: window.windowStart,
            windowEndsAt: window.windowEnd,
            value: window.value,
            unit: window.unit,
            recordedAt: window.recordedAt,
          }),
        );
      await this.repository.importUsageWindows(
        USAGE_SOURCE,
        nextCursor,
        windows,
      );
      imported += windows.length;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    if (imported > 0) {
      this.logger.info(
        { imported },
        "Imported Sandbox0 runtime usage windows",
      );
    }
  }

  private async enforcePlan() {
    const enforcement = await this.quota.environmentPlanEnforcement();
    for (const environmentId of enforcement.reconcileMemoryEnvironmentIds) {
      if (!this.reconcilePlanMemory) break;
      try {
        await this.reconcilePlanMemory(environmentId);
      } catch (error) {
        this.logger.warn(
          { err: error, environmentId },
          "Failed to reconcile plan-fixed Sandbox memory",
        );
      }
    }
    for (const environmentId of enforcement.pauseEnvironmentIds) {
      if (!this.pauseForQuota) break;
      try {
        await this.pauseForQuota(environmentId);
      } catch (error) {
        this.logger.warn(
          { err: error, environmentId },
          "Failed to pause a quota-blocked Environment",
        );
      }
    }
  }
}
