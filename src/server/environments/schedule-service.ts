import { randomUUID } from "node:crypto";

import type {
  Environment,
  EnvironmentSchedule,
  EnvironmentScheduleRun,
} from "@/lib/types";
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
  type StoredEnvironmentScheduleRun,
} from "./schedule-store";

interface ScheduleLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

interface ScheduleCodex {
  ensureScheduledSession(
    input: Parameters<CodexService["ensureScheduledSession"]>[0],
  ): ReturnType<CodexService["ensureScheduledSession"]>;
  startTurn(
    input: Parameters<CodexService["startTurn"]>[0],
  ): ReturnType<CodexService["startTurn"]>;
  readScheduledTurnStatus(
    input: Parameters<CodexService["readScheduledTurnStatus"]>[0],
  ): ReturnType<CodexService["readScheduledTurnStatus"]>;
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
const SCHEDULE_RUNNING_RECHECK_MS = 5_000;
const SCHEDULE_TRANSIENT_RETRY_MS = 30_000;
const MAX_SCHEDULE_DISPATCH_ATTEMPTS = 100;

export class EnvironmentScheduleService {
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private closed = false;
  private started = false;

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
  ) {}

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
    const leaseToken = run.leaseToken;
    if (!leaseToken) return;
    try {
      if (!schedule.createdByUserId) {
        await this.failRun(run, leaseToken, "The Schedule owner no longer exists.");
        return;
      }
      if (
        run.dispatchAttemptCount >= MAX_SCHEDULE_DISPATCH_ATTEMPTS &&
        run.status === "claimed"
      ) {
        await this.failRun(
          run,
          leaseToken,
          "The Schedule run could not be delivered after repeated retries.",
        );
        return;
      }
      const environment = await this.store.getEnvironment(
        schedule.createdByUserId,
        schedule.environmentId,
      );
      const sessionId = await this.ensureRunSession(
        schedule,
        run,
        environment,
      );
      const observed = await this.codex.readScheduledTurnStatus({
        userId: schedule.createdByUserId,
        sessionId,
        clientMessageId: run.submission.clientMessageId,
      });
      if (observed.status === "succeeded") {
        await this.schedules.finishRun({
          runId: run.id,
          leaseToken,
          status: "succeeded",
          nativeTurnId: observed.nativeTurnId,
        });
        return;
      }
      if (observed.status === "failed") {
        await this.schedules.finishRun({
          runId: run.id,
          leaseToken,
          status: "failed",
          nativeTurnId: observed.nativeTurnId,
          error: observed.error,
        });
        return;
      }
      if (observed.status === "running") {
        await this.schedules.markRunRunning({
          runId: run.id,
          leaseToken,
          nativeTurnId: observed.nativeTurnId,
          retryAt: this.runningRecheckDeadline(),
        });
        return;
      }

      const submitted = await this.codex.startTurn({
        userId: schedule.createdByUserId,
        sessionId,
        text: run.prompt,
        images: [],
        modelId: run.modelId,
        reasoningEffort: run.reasoningEffort,
        collaborationMode: run.collaborationMode,
        serviceTier: run.serviceTier,
        clientMessageId: run.submission.clientMessageId,
        durableSubmission: run.submission,
      });
      if (submitted.nativeTurnStatus === "completed") {
        await this.schedules.finishRun({
          runId: run.id,
          leaseToken,
          status: "succeeded",
          nativeTurnId: submitted.nativeTurnId,
        });
        return;
      }
      if (
        submitted.nativeTurnStatus === "failed" ||
        submitted.nativeTurnStatus === "interrupted"
      ) {
        await this.schedules.finishRun({
          runId: run.id,
          leaseToken,
          status: "failed",
          nativeTurnId: submitted.nativeTurnId,
          error: "The scheduled Codex Turn did not complete.",
        });
        return;
      }
      if (submitted.nativeTurnId) {
        await this.schedules.markRunRunning({
          runId: run.id,
          leaseToken,
          nativeTurnId: submitted.nativeTurnId,
          retryAt: this.runningRecheckDeadline(),
        });
        return;
      }
      await this.schedules.deferRun({
        runId: run.id,
        leaseToken,
        error: "Waiting for Codex to confirm the scheduled Turn.",
        retryAt: this.runningRecheckDeadline(),
      });
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === "session_turn_in_progress"
      ) {
        await this.schedules.finishRun({
          runId: run.id,
          leaseToken,
          status: "skipped",
          error: "The target Session already has a Turn in progress.",
        });
        return;
      }
      if (isTerminalScheduleRunError(error)) {
        await this.failRun(run, leaseToken, errorMessage(error));
        return;
      }
      await this.schedules.deferRun({
        runId: run.id,
        leaseToken,
        error: errorMessage(error),
        retryAt: new Date(
          this.now().getTime() +
            (this.options.transientRetryMs ?? SCHEDULE_TRANSIENT_RETRY_MS),
        ),
      });
      this.logger.warn(
        {
          scheduleId: schedule.id,
          runId: run.id,
          error: errorMessage(error),
        },
        "Environment Schedule run deferred",
      );
    }
  }

  private async ensureRunSession(
    schedule: StoredEnvironmentSchedule,
    run: StoredEnvironmentScheduleRun,
    environment: Environment,
  ) {
    if (!run.sessionId) {
      throw new HttpError(
        500,
        "environment_schedule_run_session_missing",
        "The Schedule run has no reserved Session.",
      );
    }
    if (run.target.kind === "session") {
      const session = await this.store.getSession(
        schedule.createdByUserId!,
        run.target.sessionId,
      );
      if (session.environmentId !== schedule.environmentId) {
        throw new HttpError(
          409,
          "environment_schedule_target_invalid",
          "The target Session no longer belongs to this Environment.",
        );
      }
      if (session.archived) {
        throw new HttpError(
          409,
          "environment_schedule_target_archived",
          "The target Session is archived.",
        );
      }
      return run.target.sessionId;
    }
    await this.codex.ensureScheduledSession({
      userId: schedule.createdByUserId!,
      environment,
      sessionId: run.sessionId,
      scheduleRunId: run.id,
      title: run.title ?? schedule.name,
      modelId: run.modelId,
      reasoningEffort: run.reasoningEffort,
      collaborationMode: run.collaborationMode,
      serviceTier: run.serviceTier,
    });
    return run.sessionId;
  }

  private failRun(
    run: StoredEnvironmentScheduleRun,
    leaseToken: string,
    error: string,
  ) {
    return this.schedules.finishRun({
      runId: run.id,
      leaseToken,
      status: "failed",
      error,
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

  private runningRecheckDeadline() {
    return new Date(
      this.now().getTime() +
        (this.options.runningRecheckMs ?? SCHEDULE_RUNNING_RECHECK_MS),
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

function isTerminalScheduleRunError(error: unknown) {
  return (
    error instanceof HttpError &&
    [
      "environment_schedule_session_conflict",
      "environment_schedule_target_archived",
      "environment_schedule_target_invalid",
      "session_archived",
      "session_not_found",
      "native_session_failed",
    ].includes(error.code)
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
