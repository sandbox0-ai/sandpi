import type { Pool, QueryResultRow } from "pg";

import type {
  EnvironmentSchedule,
  EnvironmentScheduleRun,
  EnvironmentScheduleRunStatus,
} from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import { conflict, notFound } from "@/server/http-error";
import type { TurnSubmissionCoordinates } from "@/server/store";
import type { EnvironmentScheduleTiming } from "./schedule-timing";

export interface StoredEnvironmentSchedule {
  id: string;
  environmentId: string;
  createdByUserId?: string;
  name: string;
  prompt: string;
  timing: EnvironmentScheduleTiming;
  target:
    | { kind: "newSession" }
    | { kind: "session"; sessionId: string };
  overlapPolicy: "skip";
  enabled: boolean;
  title?: string;
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
  nextRunAt?: Date;
  lastScheduledFor?: Date;
  lastRunStatus?: EnvironmentScheduleRunStatus;
  lastError?: string;
  revision: number;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredEnvironmentScheduleRun {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  scheduledFor: Date;
  status: EnvironmentScheduleRunStatus;
  prompt: string;
  title?: string;
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
  target:
    | { kind: "newSession" }
    | { kind: "session"; sessionId: string };
  sessionId?: string;
  nativeTurnId?: string;
  submission: TurnSubmissionCoordinates;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  dispatchAttemptCount: number;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimedEnvironmentScheduleRun {
  schedule: StoredEnvironmentSchedule;
  run: StoredEnvironmentScheduleRun;
}

interface EnvironmentScheduleRow extends QueryResultRow {
  id: string;
  environment_id: string;
  created_by_user_id: string | null;
  name: string;
  prompt: string;
  timing_kind: "once" | "cron";
  run_at: Date | null;
  cron_expression: string | null;
  time_zone: string | null;
  target_kind: "new_session" | "session";
  target_session_id: string | null;
  overlap_policy: "skip";
  enabled: boolean;
  title: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  collaboration_mode: "plan" | null;
  service_tier: string | null;
  next_run_at: Date | null;
  last_scheduled_for: Date | null;
  last_run_status: EnvironmentScheduleRunStatus | null;
  last_error: string | null;
  revision: string | number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface EnvironmentScheduleRunRow extends QueryResultRow {
  id: string;
  schedule_id: string;
  schedule_revision: string | number;
  scheduled_for: Date;
  status: EnvironmentScheduleRunStatus;
  prompt: string;
  title: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  collaboration_mode: "plan" | null;
  service_tier: string | null;
  target_kind: "new_session" | "session";
  target_session_id: string | null;
  session_id: string | null;
  native_turn_id: string | null;
  request_id: string;
  client_message_id: string;
  stable_input_id: string;
  lease_token: string | null;
  lease_expires_at: Date | null;
  dispatch_attempt_count: number;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SCHEDULE_SELECT = `
  SELECT schedule.*
  FROM environment_schedules schedule
  JOIN environments environment ON environment.id = schedule.environment_id
`;

export class EnvironmentScheduleStore {
  constructor(private readonly pool: Pool) {}

  async list(userId: string, environmentId: string) {
    const result = await this.pool.query<EnvironmentScheduleRow>(
      `${SCHEDULE_SELECT}
       WHERE schedule.environment_id = $2
         AND environment.created_by_user_id = $1
         AND schedule.deleted_at IS NULL
       ORDER BY schedule.created_at DESC, schedule.id DESC`,
      [userId, environmentId],
    );
    return result.rows.map(scheduleFromRow);
  }

  async get(userId: string, environmentId: string, scheduleId: string) {
    const result = await this.pool.query<EnvironmentScheduleRow>(
      `${SCHEDULE_SELECT}
       WHERE schedule.environment_id = $2
         AND schedule.id = $3
         AND environment.created_by_user_id = $1
         AND schedule.deleted_at IS NULL`,
      [userId, environmentId, scheduleId],
    );
    const row = result.rows[0];
    if (!row) throw scheduleNotFound();
    return scheduleFromRow(row);
  }

  async create(input: {
    id: string;
    userId: string;
    environmentId: string;
    name: string;
    prompt: string;
    timing: EnvironmentScheduleTiming;
    target: StoredEnvironmentSchedule["target"];
    enabled: boolean;
    title?: string;
    modelId?: string;
    reasoningEffort?: string;
    collaborationMode?: "plan";
    serviceTier?: string;
    nextRunAt?: Date;
  }) {
    await this.pool.query(
      `INSERT INTO environment_schedules (
         id, environment_id, created_by_user_id, name, prompt,
         timing_kind, run_at, cron_expression, time_zone,
         target_kind, target_session_id, overlap_policy, enabled,
         title, model_id, reasoning_effort, collaboration_mode, service_tier,
         next_run_at
       )
       SELECT
         $1, environment.id, $2, $4, $5, $6, $7, $8, $9,
         $10, $11, 'skip', $12, $13, $14, $15, $16, $17, $18
       FROM environments environment
       WHERE environment.id = $3
         AND environment.created_by_user_id = $2`,
      [
        input.id,
        input.userId,
        input.environmentId,
        input.name,
        input.prompt,
        input.timing.kind,
        input.timing.kind === "once" ? input.timing.runAt : null,
        input.timing.kind === "cron" ? input.timing.expression : null,
        input.timing.kind === "cron" ? input.timing.timeZone : null,
        input.target.kind === "newSession" ? "new_session" : "session",
        input.target.kind === "session" ? input.target.sessionId : null,
        input.enabled,
        input.title ?? null,
        input.modelId ?? null,
        input.reasoningEffort ?? null,
        input.collaborationMode ?? null,
        input.serviceTier ?? null,
        input.nextRunAt ?? null,
      ],
    );
    return this.get(input.userId, input.environmentId, input.id);
  }

  async update(input: {
    userId: string;
    environmentId: string;
    scheduleId: string;
    expectedRevision: number;
    name: string;
    prompt: string;
    timing: EnvironmentScheduleTiming;
    target: StoredEnvironmentSchedule["target"];
    enabled: boolean;
    title?: string;
    modelId?: string;
    reasoningEffort?: string;
    collaborationMode?: "plan";
    serviceTier?: string;
    nextRunAt?: Date;
  }) {
    const result = await this.pool.query(
      `UPDATE environment_schedules schedule
       SET name = $5, prompt = $6, timing_kind = $7,
           run_at = $8, cron_expression = $9, time_zone = $10,
           target_kind = $11, target_session_id = $12,
           enabled = $13, title = $14, model_id = $15,
           reasoning_effort = $16, collaboration_mode = $17,
           service_tier = $18, next_run_at = $19,
           last_error = NULL, revision = schedule.revision + 1
       FROM environments environment
       WHERE schedule.id = $3 AND schedule.environment_id = $2
         AND schedule.environment_id = environment.id
         AND environment.created_by_user_id = $1
         AND schedule.revision = $4
         AND schedule.deleted_at IS NULL
       RETURNING schedule.id`,
      [
        input.userId,
        input.environmentId,
        input.scheduleId,
        input.expectedRevision,
        input.name,
        input.prompt,
        input.timing.kind,
        input.timing.kind === "once" ? input.timing.runAt : null,
        input.timing.kind === "cron" ? input.timing.expression : null,
        input.timing.kind === "cron" ? input.timing.timeZone : null,
        input.target.kind === "newSession" ? "new_session" : "session",
        input.target.kind === "session" ? input.target.sessionId : null,
        input.enabled,
        input.title ?? null,
        input.modelId ?? null,
        input.reasoningEffort ?? null,
        input.collaborationMode ?? null,
        input.serviceTier ?? null,
        input.nextRunAt ?? null,
      ],
    );
    if (!result.rowCount) {
      throw conflict(
        "environment_schedule_changed",
        "The Schedule changed while it was being updated.",
      );
    }
    return this.get(input.userId, input.environmentId, input.scheduleId);
  }

  async delete(userId: string, environmentId: string, scheduleId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT schedule.id
         FROM environment_schedules schedule
         JOIN environments environment
           ON environment.id = schedule.environment_id
         WHERE schedule.id = $3 AND schedule.environment_id = $2
           AND environment.created_by_user_id = $1
           AND schedule.deleted_at IS NULL
         FOR UPDATE OF schedule`,
        [userId, environmentId, scheduleId],
      );
      if (!selected.rowCount) throw scheduleNotFound();
      const active = await client.query(
        `SELECT 1 FROM environment_schedule_runs
         WHERE schedule_id = $1 AND status IN ('claimed', 'running')
         LIMIT 1`,
        [scheduleId],
      );
      if (active.rowCount) {
        await client.query(
          `UPDATE environment_schedules
           SET enabled = FALSE, next_run_at = NULL, deleted_at = NOW(),
               revision = revision + 1
           WHERE id = $1`,
          [scheduleId],
        );
      } else {
        await client.query(
          "DELETE FROM environment_schedules WHERE id = $1",
          [scheduleId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRuns(
    userId: string,
    environmentId: string,
    scheduleId: string,
    limit = 50,
  ) {
    const result = await this.pool.query<EnvironmentScheduleRunRow>(
      `SELECT run.*
       FROM environment_schedule_runs run
       JOIN environment_schedules schedule ON schedule.id = run.schedule_id
       JOIN environments environment ON environment.id = schedule.environment_id
       WHERE run.schedule_id = $3 AND schedule.environment_id = $2
         AND environment.created_by_user_id = $1
         AND schedule.deleted_at IS NULL
       ORDER BY run.scheduled_for DESC, run.id DESC
       LIMIT $4`,
      [userId, environmentId, scheduleId, limit],
    );
    return result.rows.map(publicRunFromRow);
  }

  async dueSchedules(now: Date, limit = 50) {
    const result = await this.pool.query<EnvironmentScheduleRow>(
      `${SCHEDULE_SELECT}
       WHERE schedule.enabled = TRUE
         AND schedule.deleted_at IS NULL
         AND schedule.next_run_at IS NOT NULL
         AND schedule.next_run_at <= $1
       ORDER BY schedule.next_run_at, schedule.id
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map(scheduleFromRow);
  }

  async claimOccurrence(input: {
    schedule: StoredEnvironmentSchedule;
    scheduledFor: Date;
    nextRunAt?: Date;
    runId: string;
    sessionId?: string;
    submission: TurnSubmissionCoordinates;
    leaseToken: string;
    leaseExpiresAt: Date;
  }): Promise<
    | { kind: "stale" }
    | { kind: "skipped"; run: StoredEnvironmentScheduleRun }
    | { kind: "claimed"; run: StoredEnvironmentScheduleRun }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<EnvironmentScheduleRow>(
        `SELECT *
         FROM environment_schedules
         WHERE id = $1 AND revision = $2 AND enabled = TRUE
           AND deleted_at IS NULL
           AND next_run_at IS NOT DISTINCT FROM $3
           AND next_run_at <= $4
         FOR UPDATE`,
        [
          input.schedule.id,
          input.schedule.revision,
          input.schedule.nextRunAt ?? null,
          input.scheduledFor,
        ],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { kind: "stale" };
      }
      const active = await client.query(
        `SELECT 1
         FROM environment_schedule_runs
         WHERE schedule_id = $1 AND status IN ('claimed', 'running')
         LIMIT 1`,
        [input.schedule.id],
      );
      const skipped = Boolean(active.rowCount);
      const status: EnvironmentScheduleRunStatus = skipped
        ? "skipped"
        : "claimed";
      const error = skipped
        ? "The previous Schedule run is still active."
        : null;
      const sessionId = skipped
        ? row.target_kind === "session"
          ? row.target_session_id
          : null
        : input.sessionId ?? null;
      const inserted = await client.query<EnvironmentScheduleRunRow>(
        `INSERT INTO environment_schedule_runs (
           id, schedule_id, schedule_revision, scheduled_for, status,
           prompt, title, model_id, reasoning_effort, collaboration_mode,
           service_tier, target_kind, target_session_id, session_id,
           request_id, client_message_id, stable_input_id,
           lease_token, lease_expires_at, error, finished_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17,
           $18, $19, $20, $21
         )
         ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
         RETURNING *`,
        [
          input.runId,
          row.id,
          row.revision,
          input.scheduledFor,
          status,
          row.prompt,
          row.title,
          row.model_id,
          row.reasoning_effort,
          row.collaboration_mode,
          row.service_tier,
          row.target_kind,
          row.target_session_id,
          sessionId,
          input.submission.requestId,
          input.submission.clientMessageId,
          input.submission.stableInputId,
          skipped ? null : input.leaseToken,
          skipped ? null : input.leaseExpiresAt,
          error,
          skipped ? new Date() : null,
        ],
      );
      const runRow = inserted.rows[0];
      if (!runRow) {
        await client.query("ROLLBACK");
        return { kind: "stale" };
      }
      await client.query(
        `UPDATE environment_schedules
         SET next_run_at = $2,
             enabled = CASE WHEN timing_kind = 'once' THEN FALSE ELSE enabled END,
             last_scheduled_for = $3, last_run_status = $4,
             last_error = $5, revision = revision + 1
         WHERE id = $1`,
        [
          row.id,
          input.nextRunAt ?? null,
          input.scheduledFor,
          status,
          error,
        ],
      );
      await client.query("COMMIT");
      return {
        kind: skipped ? "skipped" : "claimed",
        run: runFromRow(runRow),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async activeRunIds(now: Date, limit = 50) {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM environment_schedule_runs
       WHERE status IN ('claimed', 'running')
         AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
       ORDER BY COALESCE(lease_expires_at, created_at), scheduled_for, id
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => row.id);
  }

  async claimRunLease(
    runId: string,
    leaseToken: string,
    leaseExpiresAt: Date,
    now: Date,
  ): Promise<ClaimedEnvironmentScheduleRun | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<EnvironmentScheduleRunRow>(
        `UPDATE environment_schedule_runs
         SET lease_token = $2, lease_expires_at = $3,
             dispatch_attempt_count = dispatch_attempt_count + 1
         WHERE id = $1 AND status IN ('claimed', 'running')
           AND (lease_expires_at IS NULL OR lease_expires_at <= $4)
         RETURNING *`,
        [runId, leaseToken, leaseExpiresAt, now],
      );
      const run = claimed.rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const schedule = await client.query<EnvironmentScheduleRow>(
        "SELECT * FROM environment_schedules WHERE id = $1",
        [run.schedule_id],
      );
      const scheduleRow = schedule.rows[0];
      if (!scheduleRow) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query("COMMIT");
      return {
        schedule: scheduleFromRow(scheduleRow),
        run: runFromRow(run),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markRunRunning(input: {
    runId: string;
    leaseToken: string;
    nativeTurnId?: string;
    retryAt: Date;
  }) {
    const result = await this.pool.query<{
      schedule_id: string;
      scheduled_for: Date;
    }>(
      `UPDATE environment_schedule_runs
       SET status = 'running', native_turn_id = COALESCE($3, native_turn_id),
           started_at = COALESCE(started_at, NOW()),
           lease_token = NULL, lease_expires_at = $4, error = NULL
       WHERE id = $1 AND lease_token = $2
         AND status IN ('claimed', 'running')
       RETURNING schedule_id, scheduled_for`,
      [input.runId, input.leaseToken, input.nativeTurnId ?? null, input.retryAt],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.pool.query(
      `UPDATE environment_schedules
       SET last_run_status = 'running', last_error = NULL
       WHERE id = $1 AND last_scheduled_for = $2`,
      [row.schedule_id, row.scheduled_for],
    );
    return true;
  }

  async deferRun(input: {
    runId: string;
    leaseToken: string;
    error: string;
    retryAt: Date;
  }) {
    const result = await this.pool.query<{
      schedule_id: string;
      scheduled_for: Date;
    }>(
      `UPDATE environment_schedule_runs
       SET lease_token = NULL, lease_expires_at = $3, error = $4
       WHERE id = $1 AND lease_token = $2
         AND status IN ('claimed', 'running')
       RETURNING schedule_id, scheduled_for`,
      [
        input.runId,
        input.leaseToken,
        input.retryAt,
        input.error.slice(0, 2_000),
      ],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.pool.query(
      `UPDATE environment_schedules
       SET last_error = $3
       WHERE id = $1 AND last_scheduled_for = $2`,
      [row.schedule_id, row.scheduled_for, input.error.slice(0, 2_000)],
    );
    return true;
  }

  async finishRun(input: {
    runId: string;
    leaseToken: string;
    status: Extract<
      EnvironmentScheduleRunStatus,
      "succeeded" | "failed" | "skipped"
    >;
    nativeTurnId?: string;
    error?: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const finished = await client.query<{
        schedule_id: string;
        scheduled_for: Date;
      }>(
        `UPDATE environment_schedule_runs
         SET status = $3, native_turn_id = COALESCE($4, native_turn_id),
             error = $5, started_at = COALESCE(started_at, NOW()),
             finished_at = NOW(), lease_token = NULL, lease_expires_at = NULL
         WHERE id = $1 AND lease_token = $2
           AND status IN ('claimed', 'running')
         RETURNING schedule_id, scheduled_for`,
        [
          input.runId,
          input.leaseToken,
          input.status,
          input.nativeTurnId ?? null,
          input.error?.slice(0, 2_000) ?? null,
        ],
      );
      const row = finished.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE environment_schedules
         SET last_run_status = $3, last_error = $4
         WHERE id = $1 AND last_scheduled_for = $2`,
        [
          row.schedule_id,
          row.scheduled_for,
          input.status,
          input.error?.slice(0, 2_000) ?? null,
        ],
      );
      await client.query(
        `DELETE FROM environment_schedules schedule
         WHERE schedule.id = $1 AND schedule.deleted_at IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM environment_schedule_runs run
             WHERE run.schedule_id = schedule.id
               AND run.status IN ('claimed', 'running')
           )`,
        [row.schedule_id],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function publicEnvironmentSchedule(
  schedule: StoredEnvironmentSchedule,
): EnvironmentSchedule {
  return {
    id: schedule.id,
    environmentId: schedule.environmentId,
    name: schedule.name,
    prompt: schedule.prompt,
    timing:
      schedule.timing.kind === "once"
        ? { kind: "once", runAt: toUnixTimestamp(schedule.timing.runAt) }
        : {
            kind: "cron",
            expression: schedule.timing.expression,
            timeZone: schedule.timing.timeZone,
          },
    target: schedule.target,
    overlapPolicy: schedule.overlapPolicy,
    enabled: schedule.enabled,
    ...(schedule.title ? { title: schedule.title } : {}),
    ...(schedule.modelId ? { modelId: schedule.modelId } : {}),
    ...(schedule.reasoningEffort
      ? { reasoningEffort: schedule.reasoningEffort }
      : {}),
    ...(schedule.collaborationMode
      ? { collaborationMode: schedule.collaborationMode }
      : {}),
    ...(schedule.serviceTier ? { serviceTier: schedule.serviceTier } : {}),
    ...(schedule.nextRunAt
      ? { nextRunAt: toUnixTimestamp(schedule.nextRunAt) }
      : {}),
    ...(schedule.lastScheduledFor
      ? { lastScheduledFor: toUnixTimestamp(schedule.lastScheduledFor) }
      : {}),
    ...(schedule.lastRunStatus
      ? { lastRunStatus: schedule.lastRunStatus }
      : {}),
    ...(schedule.lastError ? { lastError: schedule.lastError } : {}),
    createdAt: toUnixTimestamp(schedule.createdAt),
    updatedAt: toUnixTimestamp(schedule.updatedAt),
  };
}

function scheduleFromRow(row: EnvironmentScheduleRow): StoredEnvironmentSchedule {
  const timing: EnvironmentScheduleTiming =
    row.timing_kind === "once"
      ? { kind: "once", runAt: requireDate(row.run_at, "run_at") }
      : {
          kind: "cron",
          expression: requireString(row.cron_expression, "cron_expression"),
          timeZone: requireString(row.time_zone, "time_zone"),
        };
  const target: StoredEnvironmentSchedule["target"] =
    row.target_kind === "new_session"
      ? { kind: "newSession" }
      : {
          kind: "session",
          sessionId: requireString(row.target_session_id, "target_session_id"),
        };
  return {
    id: row.id,
    environmentId: row.environment_id,
    ...(row.created_by_user_id
      ? { createdByUserId: row.created_by_user_id }
      : {}),
    name: row.name,
    prompt: row.prompt,
    timing,
    target,
    overlapPolicy: row.overlap_policy,
    enabled: row.enabled,
    ...(row.title ? { title: row.title } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.reasoning_effort
      ? { reasoningEffort: row.reasoning_effort }
      : {}),
    ...(row.collaboration_mode
      ? { collaborationMode: row.collaboration_mode }
      : {}),
    ...(row.service_tier ? { serviceTier: row.service_tier } : {}),
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_scheduled_for
      ? { lastScheduledFor: row.last_scheduled_for }
      : {}),
    ...(row.last_run_status ? { lastRunStatus: row.last_run_status } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    revision: Number(row.revision),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: EnvironmentScheduleRunRow): StoredEnvironmentScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleRevision: Number(row.schedule_revision),
    scheduledFor: row.scheduled_for,
    status: row.status,
    prompt: row.prompt,
    ...(row.title ? { title: row.title } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.reasoning_effort
      ? { reasoningEffort: row.reasoning_effort }
      : {}),
    ...(row.collaboration_mode
      ? { collaborationMode: row.collaboration_mode }
      : {}),
    ...(row.service_tier ? { serviceTier: row.service_tier } : {}),
    target:
      row.target_kind === "new_session"
        ? { kind: "newSession" }
        : {
            kind: "session",
            sessionId: requireString(
              row.target_session_id,
              "target_session_id",
            ),
          },
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}),
    submission: {
      requestId: row.request_id,
      clientMessageId: row.client_message_id,
      stableInputId: row.stable_input_id,
    },
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    dispatchAttemptCount: Number(row.dispatch_attempt_count),
    ...(row.error ? { error: row.error } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicRunFromRow(row: EnvironmentScheduleRunRow): EnvironmentScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduledFor: toUnixTimestamp(row.scheduled_for),
    status: row.status,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.started_at ? { startedAt: toUnixTimestamp(row.started_at) } : {}),
    ...(row.finished_at
      ? { finishedAt: toUnixTimestamp(row.finished_at) }
      : {}),
    createdAt: toUnixTimestamp(row.created_at),
    updatedAt: toUnixTimestamp(row.updated_at),
  };
}

function requireDate(value: Date | null, column: string) {
  if (!value) throw new Error(`Environment Schedule ${column} is missing.`);
  return value;
}

function requireString(value: string | null, column: string) {
  if (!value) throw new Error(`Environment Schedule ${column} is missing.`);
  return value;
}

function scheduleNotFound() {
  return notFound(
    "environment_schedule_not_found",
    "Environment Schedule not found.",
  );
}
