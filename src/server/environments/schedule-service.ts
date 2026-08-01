import { randomUUID } from "node:crypto";

import type { EnvironmentSchedule, EnvironmentScheduleRun } from "@/lib/types";
import { EnvironmentAutomationExecutor } from "@/server/automations/executor";
import { HttpError } from "@/server/http-error";
import type { CodexService } from "@/server/harnesses/codex/service";
import type { SandpiStore } from "@/server/store";
import {
  dueEnvironmentScheduleOccurrence,
  firstEnvironmentScheduleRunAt,
  normalizeEnvironmentScheduleTiming,
  type EnvironmentScheduleTiming,
} from "./schedule-timing";
import {
  EnvironmentScheduleStore,
  publicEnvironmentSchedule,
  type ClaimedEnvironmentScheduleRun,
  type StoredEnvironmentSchedule,
} from "./schedule-store";

interface ScheduleLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

interface ScheduleCodex {
  ensureAutomationSession(
    input: Parameters<CodexService["ensureAutomationSession"]>[0],
  ): ReturnType<CodexService["ensureAutomationSession"]>;
  startTurn(
    input: Parameters<CodexService["startTurn"]>[0],
  ): ReturnType<CodexService["startTurn"]>;
  readAutomationTurnStatus(
    input: Parameters<CodexService["readAutomationTurnStatus"]>[0],
  ): ReturnType<CodexService["readAutomationTurnStatus"]>;
}

export interface EnvironmentScheduleConfiguration {
  name: string;
  prompt: string;
  timing: EnvironmentScheduleTiming;
  target:
    | { kind: "newSession" }
    | { kind: "session"; sessionId: string };
  enabled: boolean;
  title?: string;
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
}

const SCHEDULE_POLL_INTERVAL_MS = 5_000;
const SCHEDULE_RUN_LEASE_MS = 30_000;

export class EnvironmentScheduleService {
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private closed = false;
  private started = false;
  private readonly executor: EnvironmentAutomationExecutor;

  constructor(
    private readonly schedules: EnvironmentScheduleStore,
    private readonly store: SandpiStore,
    private readonly codex: ScheduleCodex,
    private readonly logger: ScheduleLogger,
    private readonly options: {
      pollIntervalMs?: number;
      runLeaseMs?: number;
      runningRecheckMs?: number;
      transientRetryMs?: number;
      batchSize?: number;
      now?: () => Date;
    } = {},
  ) {
    this.executor = new EnvironmentAutomationExecutor(
      store,
      codex,
      logger,
      options,
    );
  }

  async start() {
    if (this.started) return;
    this.started = true;
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Initial Environment Schedule reconciliation deferred",
      );
    });
    this.schedule();
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.reconciliation;
  }

  async list(userId: string, environmentId: string) {
    await this.store.getEnvironment(userId, environmentId);
    return (await this.schedules.list(userId, environmentId)).map(
      publicEnvironmentSchedule,
    );
  }

  async create(
    userId: string,
    environmentId: string,
    input: EnvironmentScheduleConfiguration,
  ): Promise<EnvironmentSchedule> {
    await this.store.getEnvironment(userId, environmentId);
    const configuration = await this.normalizeConfiguration(
      userId,
      environmentId,
      input,
    );
    const now = this.now();
    const schedule = await this.schedules.create({
      id: `schedule_${randomUUID()}`,
      userId,
      environmentId,
      ...configuration,
      nextRunAt: configuration.enabled
        ? firstEnvironmentScheduleRunAt(configuration.timing, now)
        : undefined,
    });
    this.wake();
    return publicEnvironmentSchedule(schedule);
  }

  async update(
    userId: string,
    environmentId: string,
    scheduleId: string,
    input: EnvironmentScheduleConfiguration,
  ): Promise<EnvironmentSchedule> {
    const current = await this.schedules.get(
      userId,
      environmentId,
      scheduleId,
    );
    const configuration = await this.normalizeConfiguration(
      userId,
      environmentId,
      input,
    );
    const now = this.now();
    const schedule = await this.schedules.update({
      userId,
      environmentId,
      scheduleId,
      expectedRevision: current.revision,
      ...configuration,
      nextRunAt: configuration.enabled
        ? firstEnvironmentScheduleRunAt(configuration.timing, now)
        : undefined,
    });
    this.wake();
    return publicEnvironmentSchedule(schedule);
  }

  async delete(userId: string, environmentId: string, scheduleId: string) {
    await this.schedules.delete(userId, environmentId, scheduleId);
  }

  async listRuns(
    userId: string,
    environmentId: string,
    scheduleId: string,
    limit?: number,
  ): Promise<EnvironmentScheduleRun[]> {
    await this.schedules.get(userId, environmentId, scheduleId);
    return this.schedules.listRuns(
      userId,
      environmentId,
      scheduleId,
      limit,
    );
  }

  async reconcileOnce() {
    if (this.closed) return;
    if (this.reconciliation) return this.reconciliation;
    const run = this.reconcile().finally(() => {
      if (this.reconciliation === run) this.reconciliation = undefined;
    });
    this.reconciliation = run;
    return run;
  }

  private async normalizeConfiguration(
    userId: string,
    environmentId: string,
    input: EnvironmentScheduleConfiguration,
  ) {
    const now = this.now();
    const timing = normalizeEnvironmentScheduleTiming(input.timing, now);
    if (input.target.kind === "session") {
      const session = await this.store.getSession(
        userId,
        input.target.sessionId,
      );
      if (session.environmentId !== environmentId) {
        throw new HttpError(
          400,
          "environment_schedule_target_invalid",
          "The target Session must belong to this Environment.",
        );
      }
      if (session.archived) {
        throw new HttpError(
          409,
          "environment_schedule_target_archived",
          "Unarchive the target Session before scheduling it.",
        );
      }
    }
    return {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      timing,
      target: input.target,
      enabled: input.enabled,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.modelId?.trim() ? { modelId: input.modelId.trim() } : {}),
      ...(input.reasoningEffort?.trim()
        ? { reasoningEffort: input.reasoningEffort.trim() }
        : {}),
      ...(input.collaborationMode
        ? { collaborationMode: input.collaborationMode }
        : {}),
      ...(input.serviceTier?.trim()
        ? { serviceTier: input.serviceTier.trim() }
        : {}),
    };
  }

  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.reconcileOnce()
        .catch((error) => {
          this.logger.warn(
            { error: errorMessage(error) },
            "Environment Schedule reconciliation failed",
          );
        })
        .finally(() => this.schedule());
    }, this.options.pollIntervalMs ?? SCHEDULE_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  private wake() {
    if (!this.started || this.closed) return;
    void this.reconcileOnce().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error) },
        "Environment Schedule wake-up reconciliation failed",
      );
    });
  }

  private async reconcile() {
    const now = this.now();
    const limit = this.options.batchSize ?? 50;
    const activeRunIds = await this.schedules.activeRunIds(now, limit);
    for (const runId of activeRunIds) {
      await this.reconcileActiveRun(runId);
    }

    const dueSchedules = await this.schedules.dueSchedules(this.now(), limit);
    for (const schedule of dueSchedules) {
      await this.claimDueSchedule(schedule);
    }
  }

  private async claimDueSchedule(schedule: StoredEnvironmentSchedule) {
    if (!schedule.nextRunAt) return;
    const now = this.now();
    const occurrence = dueEnvironmentScheduleOccurrence(
      schedule.timing,
      schedule.nextRunAt,
      now,
    );
    const runId = `schedule_run_${randomUUID()}`;
    const sessionId =
      schedule.target.kind === "newSession"
        ? `session_${randomUUID()}`
        : schedule.target.sessionId;
    const leaseToken = randomUUID();
    const claimed = await this.schedules.claimOccurrence({
      schedule,
      scheduledFor: occurrence.scheduledFor,
      nextRunAt: occurrence.nextRunAt,
      runId,
      sessionId,
      submission: scheduleRunSubmission(runId),
      leaseToken,
      leaseExpiresAt: this.leaseDeadline(now),
    });
    if (claimed.kind !== "claimed") return;
    await this.executeClaimedRun({
      schedule,
      run: claimed.run,
    });
  }

  private async reconcileActiveRun(runId: string) {
    const now = this.now();
    const claimed = await this.schedules.claimRunLease(
      runId,
      randomUUID(),
      this.leaseDeadline(now),
      now,
    );
    if (!claimed) return;
    await this.executeClaimedRun(claimed);
  }

  private async executeClaimedRun(claimed: ClaimedEnvironmentScheduleRun) {
    const { schedule, run } = claimed;
    if (run.status !== "claimed" && run.status !== "running") return;
    await this.executor.execute({
      definition: {
        id: schedule.id,
        sourceKind: "schedule",
        environmentId: schedule.environmentId,
        createdByUserId: schedule.createdByUserId,
        name: schedule.name,
        overlapPolicy: "skip",
      },
      run: { ...run, status: run.status },
      persistence: {
        markRunning: (input) => this.schedules.markRunRunning(input),
        defer: (input) => this.schedules.deferRun(input),
        finish: (input) => this.schedules.finishRun(input),
      },
    });
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private leaseDeadline(now = this.now()) {
    return new Date(
      now.getTime() + (this.options.runLeaseMs ?? SCHEDULE_RUN_LEASE_MS),
    );
  }
}

function scheduleRunSubmission(runId: string) {
  return {
    requestId: `schedule-turn:${runId}`,
    clientMessageId: `sandpi-schedule:${runId}`,
    stableInputId: `schedule-turn-input:${runId}`,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
