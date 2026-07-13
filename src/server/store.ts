import { randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import type { CodexEventEnvelope, CodexHarnessState } from "@/harnesses/codex/types";
import type {
  CodingSession,
  Environment,
  MembershipPlanAssignment,
  NetworkPolicy,
  SandpiBootstrap,
  SandpiDeploymentSummary,
  SandpiPlan,
  SandpiPreferences,
  SandpiUser,
  Team,
  TeamMembership,
} from "@/lib/types";
import { HttpError, notFound } from "@/server/http-error";
import type {
  CodexDecoderState,
  DecodedCodexRecord,
} from "@/server/harnesses/codex/jsonl";
import type {
  ProvisionedEnvironment,
  ProvisionedSession,
  RuntimeSessionRecord,
} from "@/server/runtime/types";

export const SANDPI_PLANS: SandpiPlan[] = [
  {
    id: "free",
    name: "Free",
    execution: { weeklyLimitMinutes: 600, concurrentSessionLimit: 1 },
    storage: { snapshotLimitGiB: 5 },
  },
  {
    id: "pro",
    name: "Pro",
    execution: { weeklyLimitMinutes: 1_800, concurrentSessionLimit: 3 },
    storage: { snapshotLimitGiB: 20 },
  },
  {
    id: "max",
    name: "Max",
    execution: { weeklyLimitMinutes: 7_200, concurrentSessionLimit: 12 },
    storage: { snapshotLimitGiB: 80 },
  },
];

export interface EnvironmentRecord extends Environment {
  provisioningError?: string;
}

export interface StoredRuntime extends RuntimeSessionRecord {
  decoder: CodexDecoderState;
  attemptId?: string;
  runtimeGeneration: number;
  provisioningError?: string;
}

export type TurnCheckpointClaim =
  | { state: "claimed"; id: string; ordinal: number }
  | { state: "ready" }
  | { state: "creating" };

export interface RetryableTurnCheckpoint {
  turnId: string;
  userMessageItemId: string;
  nativeHeadTurnId: string;
}

export interface InterruptedTurnMutation {
  runtime: StoredRuntime;
  headSnapshotId: string;
  originalThreadId: string;
}

export interface RuntimeCleanupRecord extends Partial<ProvisionedSession> {
  id: string;
}

export interface TurnMutationContext {
  selectedTurnId: string;
  selectedOrdinal: number;
  boundarySequence: number;
  upperSequence: number;
  restoreSnapshotId: string;
  headSnapshotId: string;
  branchThroughTurnId?: string;
}

export interface TurnForkPoint {
  selectedTurnId: string;
  selectedOrdinal: number;
  selectedSnapshotId: string;
  upperSequence: number;
}

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  name: string;
  avatar_initials: string;
}

interface EnvironmentRow extends QueryResultRow {
  id: string;
  team_id: string;
  name: string;
  description: string;
  color: string;
  status: "updating" | "ready" | "error" | "archived";
  revision: number;
  template_id: string | null;
  rootfs_snapshot_id: string | null;
  workspace_volume_id: string | null;
  credential_revision: number;
  harness: Environment["codingAgent"]["harness"];
  harness_metadata: Record<string, unknown>;
  network_policy: NetworkPolicy;
  functions: Environment["functions"];
  provisioning_error: string | null;
}

interface SessionRow extends QueryResultRow {
  id: string;
  environment_id: string;
  title: string;
  status: string;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
  harness: "codex";
  harness_state: Partial<CodexHarnessState>;
  metadata: Record<string, unknown>;
  environment_revision: number;
  workspace_root: string;
  origin_kind: NonNullable<CodingSession["origin"]>["kind"] | null;
  origin_label: string | null;
  source_session_id: string | null;
  source_native_item_id: string | null;
  hard_expires_at: Date;
  created_at: Date;
  updated_at: Date;
  sandbox_id: string | null;
  workspace_volume_id: string | null;
  supervisor_session_id: string | null;
  terminal_session_id: string | null;
  thread_id: string | null;
  model_id: string | null;
  history_revision: string | number | null;
}

interface TeamRow extends QueryResultRow {
  id: string;
  name: string;
  slug: string;
  color: string;
  member_count: number;
  billing_account_id: string;
  billing_status: Team["billingAccount"]["status"];
  billing_cadence: Team["billingAccount"]["billingCadence"];
  billing_email: string;
  billing_period_starts_at: Date;
  billing_period_ends_at: Date;
  created_at: Date;
}

interface MembershipRow extends QueryResultRow {
  id: string;
  team_id: string;
  user_id: string;
  email: string;
  name: string;
  avatar_initials: string;
  role: TeamMembership["role"];
  status: TeamMembership["status"];
  plan_assignment_id: string;
  plan_id: MembershipPlanAssignment["planId"];
  plan_status: MembershipPlanAssignment["status"];
  plan_period_starts_at: Date;
  plan_period_ends_at: Date;
  plan_quotas: MembershipPlanAssignment["quotas"];
  joined_at: Date;
}

interface RuntimeRow extends QueryResultRow {
  session_id: string;
  sandbox_id: string;
  workspace_volume_id: string;
  supervisor_session_id: string;
  terminal_session_id: string | null;
  supervisor_cursor: string | number;
  stdout_tail: string;
  thread_id: string | null;
  model_id: string | null;
  attempt_id: string | null;
  runtime_generation: string | number;
  provisioning_error: string | null;
}

export class SandpiStore {
  constructor(private readonly pool: Pool) {}

  async getBootstrap(
    userId: string,
    deployment: SandpiDeploymentSummary,
    requestedTeamId?: string,
    requestedEnvironmentId?: string,
    requestedSessionId?: string,
    preferNewSession = false,
  ): Promise<SandpiBootstrap> {
    const viewerResult = await this.pool.query<UserRow>(
      "SELECT id, email, name, avatar_initials FROM users WHERE id = $1 AND status = 'active'",
      [userId],
    );
    const viewer = viewerResult.rows[0];
    if (!viewer) throw notFound("user_not_found", "User not found.");

    const teamsResult = await this.pool.query<TeamRow>(
      `
        SELECT t.*, COUNT(all_members.id)::INTEGER AS member_count
        FROM teams t
        JOIN team_memberships viewer_membership
          ON viewer_membership.team_id = t.id
         AND viewer_membership.user_id = $1
         AND viewer_membership.status = 'active'
        LEFT JOIN team_memberships all_members
          ON all_members.team_id = t.id
         AND all_members.status = 'active'
        GROUP BY t.id
        ORDER BY t.created_at, t.id
      `,
      [userId],
    );
    const teams = teamsResult.rows.map(teamFromRow);
    const selectedTeam =
      teams.find((team) => team.id === requestedTeamId) ?? teams[0];
    if (!selectedTeam) {
      throw notFound("team_not_found", "The user does not belong to a Team.");
    }

    const membershipsResult = await this.pool.query<MembershipRow>(
      `
        SELECT m.*, u.id AS user_id, u.email, u.name, u.avatar_initials
        FROM team_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.team_id = ANY($1::TEXT[])
        ORDER BY m.joined_at, m.id
      `,
      [teams.map((team) => team.id)],
    );
    const teamMemberships = membershipsResult.rows.map(membershipFromRow);
    const viewerMemberships = teamMemberships.filter(
      (membership) => membership.user.id === userId,
    );
    const environments = await this.listEnvironments(userId);
    const sessions = await this.listSessions(userId);
    const preferences = await this.getPreferences(userId);
    const selectedEnvironments = environments.filter(
      (environment) => environment.teamId === selectedTeam.id,
    );
    const requestedSession = requestedSessionId
      ? sessions.find(
          (session) => session.id === requestedSessionId && !session.archived,
        )
      : undefined;
    const requestedSessionEnvironment = requestedSession
      ? selectedEnvironments.find(
          (environment) => environment.id === requestedSession.environmentId,
        )
      : undefined;
    const requestedEnvironment = requestedEnvironmentId
      ? selectedEnvironments.find(
          (environment) => environment.id === requestedEnvironmentId,
        )
      : undefined;
    const selectedEnvironment =
      requestedSessionEnvironment ?? requestedEnvironment ?? selectedEnvironments[0];
    const selectedSession = preferNewSession
      ? undefined
      : requestedSessionEnvironment
        ? requestedSession
        : selectedEnvironment
          ? sessions.find(
              (session) =>
                session.environmentId === selectedEnvironment.id && !session.archived,
            )
          : undefined;
    if (selectedSession) {
      const detail = await this.getSession(userId, selectedSession.id);
      sessions.splice(sessions.indexOf(selectedSession), 1, detail);
    }

    return {
      viewer: userFromRow(viewer),
      teams,
      viewerMemberships,
      teamMemberships,
      plans: SANDPI_PLANS,
      deployment,
      environments,
      sessions,
      preferences,
      selectedTeamId: selectedTeam.id,
      selectedEnvironmentId: selectedEnvironment?.id ?? "",
      selectedSessionId: selectedSession?.id ?? "",
    };
  }

  async listEnvironments(userId: string): Promise<EnvironmentRecord[]> {
    const result = await this.pool.query<EnvironmentRow>(
      `
        SELECT e.*
        FROM environments e
        JOIN team_memberships m
          ON m.team_id = e.team_id
         AND m.user_id = $1
         AND m.status = 'active'
        WHERE e.created_by_user_id = $1 AND e.status <> 'archived'
        ORDER BY e.created_at, e.id
      `,
      [userId],
    );
    return result.rows.map(environmentFromRow);
  }

  async getEnvironment(userId: string, environmentId: string) {
    const result = await this.pool.query<EnvironmentRow>(
      `
        SELECT e.*
        FROM environments e
        JOIN team_memberships m
          ON m.team_id = e.team_id
         AND m.user_id = $1
         AND m.status = 'active'
        WHERE e.created_by_user_id = $1
          AND e.id = $2 AND e.status <> 'archived'
      `,
      [userId, environmentId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("environment_not_found", "Environment not found.");
    return environmentFromRow(row);
  }

  async createEnvironmentMetadata(input: {
    userId: string;
    teamId: string;
    name: string;
  }) {
    const membership = await this.pool.query(
      `SELECT 1 FROM team_memberships
       WHERE team_id = $1 AND user_id = $2 AND status = 'active'`,
      [input.teamId, input.userId],
    );
    if (!membership.rowCount) {
      throw notFound("team_not_found", "Team not found.");
    }
    const id = `env_${randomUUID()}`;
    const result = await this.pool.query<EnvironmentRow>(
      `
        INSERT INTO environments (
          id, team_id, created_by_user_id, name, description, color, status,
          revision, template_id, credential_revision, harness,
          harness_metadata, network_policy, functions
        ) VALUES (
          $1, $2, $3, $4, '', '#151515', 'updating', 1, 'coding-agent', 0,
          'codex', '{"label":"Codex","status":"not-connected"}'::JSONB,
          '{"mode":"allow-all","allowedDomains":[],"logDeniedRequests":true}'::JSONB,
          '[]'::JSONB
        )
        RETURNING *
      `,
      [id, input.teamId, input.userId, input.name],
    );
    return environmentFromRow(result.rows[0]);
  }

  async markEnvironmentReady(
    environmentId: string,
    resources: ProvisionedEnvironment,
  ) {
    const result = await this.pool.query<EnvironmentRow>(
      `
        UPDATE environments
        SET status = 'ready', template_id = COALESCE(template_id, 'coding-agent'),
            workspace_volume_id = $2, rootfs_snapshot_id = $3,
            provisioning_error = NULL
        WHERE id = $1
        RETURNING *
      `,
      [environmentId, resources.workspaceVolumeId, resources.rootfsSnapshotId ?? null],
    );
    return environmentFromRow(result.rows[0]);
  }

  async markEnvironmentFailed(environmentId: string, error: string) {
    await this.pool.query(
      "UPDATE environments SET status = 'error', provisioning_error = $2 WHERE id = $1",
      [environmentId, error],
    );
  }

  async markEnvironmentProvisioning(userId: string, environmentId: string) {
    await this.getEnvironment(userId, environmentId);
    const result = await this.pool.query<EnvironmentRow>(
      `UPDATE environments
       SET status = 'updating', provisioning_error = NULL
       WHERE id = $1 AND workspace_volume_id IS NULL
       RETURNING *`,
      [environmentId],
    );
    const row = result.rows[0];
    if (!row) return this.getEnvironment(userId, environmentId);
    return environmentFromRow(row);
  }

  async environmentsNeedingProvisioning() {
    const result = await this.pool.query<EnvironmentRow>(
      `SELECT * FROM environments
       WHERE status IN ('updating', 'error') AND workspace_volume_id IS NULL
       ORDER BY created_at`,
    );
    return result.rows.map(environmentFromRow);
  }

  async updateEnvironment(
    userId: string,
    environmentId: string,
    input: {
      name: string;
      description: string;
      color: string;
      networkPolicy: NetworkPolicy;
    },
  ) {
    await this.getEnvironment(userId, environmentId);
    const result = await this.pool.query<EnvironmentRow>(
      `
        UPDATE environments
        SET name = $2, description = $3, color = $4,
            network_policy = $5::JSONB, revision = revision + 1
        WHERE id = $1
        RETURNING *
      `,
      [
        environmentId,
        input.name,
        input.description,
        input.color,
        JSON.stringify(input.networkPolicy),
      ],
    );
    return environmentFromRow(result.rows[0]);
  }

  async listSessions(userId: string): Promise<CodingSession[]> {
    const result = await this.pool.query<SessionRow>(
      `${SESSION_SELECT}
       WHERE m.user_id = $1 AND m.status = 'active'
         AND s.created_by_user_id = $1
       ORDER BY s.pinned DESC, s.updated_at DESC`,
      [userId],
    );
    // Session navigation can contain months of native harness history. List
    // responses intentionally carry summaries; clients fetch the selected
    // Session detail and then continue from its durable SSE cursor.
    return result.rows.map((row) => sessionFromRow(row, []));
  }

  async getSession(userId: string, sessionId: string): Promise<CodingSession> {
    const result = await this.pool.query<SessionRow>(
      `${SESSION_SELECT}
       WHERE m.user_id = $1 AND m.status = 'active'
         AND s.created_by_user_id = $1 AND s.id = $2`,
      [userId, sessionId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("session_not_found", "Session not found.");
    const events = await this.eventsBySession([row.id]);
    const recoverableItems = await this.recoverableItemsBySession([row.id]);
    return sessionFromRow(
      row,
      events.get(row.id) ?? [],
      recoverableItems.get(row.id) ?? [],
    );
  }

  async createSessionMetadata(input: {
    userId: string;
    environment: Environment;
    title: string;
    modelId?: string;
  }) {
    const id = `session_${randomUUID()}`;
    const hardExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO sessions (
            id, team_id, environment_id, created_by_user_id, title, status,
            harness, harness_state, metadata, environment_revision,
            origin_kind, origin_label, hard_expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, 'provisioning', 'codex', $6::JSONB,
            $7::JSONB, $8, 'environment', $9, $10
          )
        `,
        [
          id,
          input.environment.teamId,
          input.environment.id,
          input.userId,
          input.title,
          JSON.stringify({ protocol: "codex-app-server", events: [] }),
          JSON.stringify({ modelId: input.modelId ?? null }),
          input.environment.revision,
          input.environment.name,
          hardExpiresAt,
        ],
      );
      await client.query(
        `INSERT INTO session_runtime (
           session_id, model_id, desired_state, observed_state
         ) VALUES ($1, $2, 'running', 'provisioning')`,
        [id, input.modelId ?? null],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return id;
  }

  async createForkSessionMetadata(input: {
    userId: string;
    environment: Environment;
    source: CodingSession;
    modelId?: string;
    title?: string;
    kind?: "session" | "turn";
    sourceNativeItemId?: string;
  }) {
    const id = `session_${randomUUID()}`;
    const hardExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO sessions (
            id, team_id, environment_id, created_by_user_id, title, status,
            harness, harness_state, metadata, environment_revision,
            origin_kind, origin_label, source_session_id, source_native_item_id,
            hard_expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, 'provisioning', 'codex', $6::JSONB,
            $7::JSONB, $8, $9, $10, $11, $12, $13
          )
        `,
        [
          id,
          input.environment.teamId,
          input.environment.id,
          input.userId,
          input.title ??
            `${input.source.title} (${input.kind === "turn" ? "turn fork" : "fork"})`,
          JSON.stringify({ protocol: "codex-app-server", events: [] }),
          JSON.stringify({ modelId: input.modelId ?? null }),
          input.source.environmentRevision,
          input.kind ?? "session",
          input.source.title,
          input.source.id,
          input.sourceNativeItemId ?? null,
          hardExpiresAt,
        ],
      );
      await client.query(
        `INSERT INTO session_runtime (
           session_id, model_id, desired_state, observed_state
         ) VALUES ($1, $2, 'running', 'provisioning')`,
        [id, input.modelId ?? null],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return id;
  }

  async copyVisibleHarnessHistory(
    sourceSessionId: string,
    targetSessionId: string,
    throughSequence?: number,
  ) {
    await this.pool.query(
      `INSERT INTO harness_events (
         session_id, sequence, harness, harness_version, protocol_version,
         runtime_generation, attempt_id, received_at, notification,
         supervisor_sequence, record_index, message_kind, visible
       )
       SELECT $2, sequence, harness, harness_version, protocol_version,
              0, NULL, received_at, notification,
              NULL, NULL, message_kind, TRUE
       FROM harness_events
       WHERE session_id = $1 AND visible AND message_kind = 'notification'
         AND ($3::BIGINT IS NULL OR sequence <= $3)
         AND notification->>'method' IN (
           'turn/started', 'item/completed', 'turn/completed'
         )
       ORDER BY sequence`,
      [sourceSessionId, targetSessionId, throughSequence ?? null],
    );
  }

  async markSessionProvisioned(
    sessionId: string,
    resources: ProvisionedSession,
    credential: {
      sourceId: string;
      sourceRevision: number;
      harness: "codex";
    },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE sessions SET status = 'running' WHERE id = $1",
        [sessionId],
      );
      await client.query(
        `
          UPDATE session_runtime
          SET sandbox_id = $2, workspace_volume_id = $3,
              supervisor_session_id = $4, attempt_id = $5,
              runtime_generation = $6, observed_state = 'running',
              provisioning_error = NULL
          WHERE session_id = $1
        `,
        [
          sessionId,
          resources.sandboxId,
          resources.workspaceVolumeId,
          resources.supervisorSessionId,
          resources.attemptId,
          resources.runtimeGeneration,
        ],
      );
      const binding = await client.query(
        `
          INSERT INTO sandbox_credential_bindings (
            id, session_id, sandbox_id, credential_source_id, harness,
            source_revision, native_target_path, status
          )
          SELECT $1, s.id, $3, c.id, $4, c.revision, $6, 'active'
          FROM sessions s
          JOIN harness_credentials c
            ON c.id = $5
           AND c.environment_id = s.environment_id
           AND c.harness = s.harness
           AND c.revoked_at IS NULL
          WHERE s.id = $2 AND c.revision = $7
          ON CONFLICT (session_id, harness) DO UPDATE
          SET sandbox_id = EXCLUDED.sandbox_id,
              credential_source_id = EXCLUDED.credential_source_id,
              source_revision = EXCLUDED.source_revision,
              native_target_path = EXCLUDED.native_target_path,
              status = 'active', materialized_at = NOW()
          RETURNING id
        `,
        [
          `binding_${randomUUID()}`,
          sessionId,
          resources.sandboxId,
          credential.harness,
          credential.sourceId,
          resources.nativeCredentialTargetPath,
          credential.sourceRevision,
        ],
      );
      if (!binding.rowCount) {
        throw new Error("Session credential source is no longer active");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSessionFailed(
    sessionId: string,
    error: string,
    clearRuntime = false,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          WITH changed AS (
            UPDATE sessions
            SET status = 'failed', archived = archived OR $3
            WHERE id = $1
          )
          UPDATE session_runtime
          SET observed_state = 'failed', provisioning_error = $2,
              sandbox_id = CASE WHEN $3 THEN NULL ELSE sandbox_id END,
              workspace_volume_id = CASE WHEN $3 THEN NULL ELSE workspace_volume_id END,
              supervisor_session_id = CASE WHEN $3 THEN NULL ELSE supervisor_session_id END,
              terminal_session_id = CASE WHEN $3 THEN NULL ELSE terminal_session_id END
          WHERE session_id = $1
        `,
        [sessionId, error, clearRuntime],
      );
      if (clearRuntime) {
        await client.query(
          `UPDATE sandbox_credential_bindings
           SET status = 'revoked', updated_at = NOW()
           WHERE session_id = $1 AND status <> 'revoked'`,
          [sessionId],
        );
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async recordSessionAllocation(
    sessionId: string,
    resources: Partial<ProvisionedSession>,
  ) {
    await this.pool.query(
      `UPDATE session_runtime
       SET sandbox_id = COALESCE($2, sandbox_id),
           workspace_volume_id = COALESCE($3, workspace_volume_id),
           supervisor_session_id = COALESCE($4, supervisor_session_id),
           attempt_id = COALESCE($5, attempt_id),
           runtime_generation = GREATEST(runtime_generation, COALESCE($6, 0)),
           observed_state = 'provisioning', version = version + 1
       WHERE session_id = $1`,
      [
        sessionId,
        resources.sandboxId ?? null,
        resources.workspaceVolumeId ?? null,
        resources.supervisorSessionId ?? null,
        resources.attemptId ?? null,
        resources.runtimeGeneration ?? null,
      ],
    );
  }

  async allocatedSessionResources(sessionId: string): Promise<RuntimeCleanupRecord> {
    const result = await this.pool.query<{
      session_id: string;
      sandbox_id: string | null;
      workspace_volume_id: string | null;
      supervisor_session_id: string | null;
    }>(
      `SELECT session_id, sandbox_id, workspace_volume_id, supervisor_session_id
       FROM session_runtime WHERE session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    return {
      id: sessionId,
      sandboxId: row?.sandbox_id ?? undefined,
      workspaceVolumeId: row?.workspace_volume_id ?? undefined,
      supervisorSessionId: row?.supervisor_session_id ?? undefined,
    };
  }

  async expiredRuntimeSessions(): Promise<RuntimeCleanupRecord[]> {
    const result = await this.pool.query<{
      session_id: string;
      sandbox_id: string | null;
      workspace_volume_id: string | null;
      supervisor_session_id: string | null;
    }>(
      `SELECT r.session_id, r.sandbox_id, r.workspace_volume_id,
              r.supervisor_session_id
       FROM session_runtime r
       JOIN sessions s ON s.id = r.session_id
       WHERE s.hard_expires_at <= NOW()
         AND r.observed_state <> 'terminated'
         AND (r.sandbox_id IS NOT NULL OR r.workspace_volume_id IS NOT NULL)
       ORDER BY s.hard_expires_at`,
    );
    return result.rows.map((row) => ({
      id: row.session_id,
      sandboxId: row.sandbox_id ?? undefined,
      workspaceVolumeId: row.workspace_volume_id ?? undefined,
      supervisorSessionId: row.supervisor_session_id ?? undefined,
    }));
  }

  async failedRuntimeSessions(): Promise<RuntimeCleanupRecord[]> {
    const result = await this.pool.query<{
      session_id: string;
      sandbox_id: string | null;
      workspace_volume_id: string | null;
      supervisor_session_id: string | null;
    }>(
      `SELECT r.session_id, r.sandbox_id, r.workspace_volume_id,
              r.supervisor_session_id
       FROM session_runtime r
       JOIN sessions s ON s.id = r.session_id
       WHERE (
           s.status = 'failed'
           OR (s.status = 'provisioning' AND s.updated_at < NOW() - INTERVAL '10 minutes')
         )
         AND r.observed_state <> 'terminated'
         AND (r.sandbox_id IS NOT NULL OR r.workspace_volume_id IS NOT NULL)
       ORDER BY s.updated_at`,
    );
    return result.rows.map((row) => ({
      id: row.session_id,
      sandboxId: row.sandbox_id ?? undefined,
      workspaceVolumeId: row.workspace_volume_id ?? undefined,
      supervisorSessionId: row.supervisor_session_id ?? undefined,
    }));
  }

  async markFailedSessionResourcesCleaned(sessionId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `WITH changed AS (
           UPDATE sessions SET status = 'failed', archived = TRUE WHERE id = $1
         )
         UPDATE session_runtime
         SET desired_state = 'terminated', observed_state = 'terminated',
             sandbox_id = NULL, workspace_volume_id = NULL,
             supervisor_session_id = NULL, terminal_session_id = NULL
         WHERE session_id = $1`,
        [sessionId],
      );
      await client.query(
        `UPDATE sandbox_credential_bindings
         SET status = 'revoked', updated_at = NOW()
         WHERE session_id = $1 AND status <> 'revoked'`,
        [sessionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSessionExpired(sessionId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE sessions SET status = 'completed' WHERE id = $1",
        [sessionId],
      );
      await client.query(
        `UPDATE session_runtime
         SET desired_state = 'terminated', observed_state = 'terminated',
             sandbox_id = NULL, workspace_volume_id = NULL,
             supervisor_session_id = NULL, terminal_session_id = NULL,
             provisioning_error = NULL
         WHERE session_id = $1`,
        [sessionId],
      );
      await client.query(
        `UPDATE sandbox_credential_bindings
         SET status = 'revoked', updated_at = NOW()
         WHERE session_id = $1 AND status <> 'revoked'`,
        [sessionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRuntime(userId: string, sessionId: string): Promise<StoredRuntime> {
    const result = await this.pool.query<RuntimeRow>(
      `
        SELECT r.*
        FROM session_runtime r
        JOIN sessions s ON s.id = r.session_id
        JOIN team_memberships m
          ON m.team_id = s.team_id
         AND m.user_id = $1
         AND m.status = 'active'
        WHERE s.created_by_user_id = $1 AND r.session_id = $2
      `,
      [userId, sessionId],
    );
    const row = result.rows[0];
    if (!row?.sandbox_id || !row?.supervisor_session_id || !row?.workspace_volume_id) {
      throw notFound(
        "session_runtime_not_ready",
        "Session runtime is not ready.",
      );
    }
    return runtimeFromRow(row);
  }

  async setTerminalSession(sessionId: string, terminalSessionId: string) {
    await this.pool.query(
      "UPDATE session_runtime SET terminal_session_id = $2 WHERE session_id = $1",
      [sessionId, terminalSessionId],
    );
  }

  async decoderState(sessionId: string): Promise<StoredRuntime> {
    const result = await this.pool.query<RuntimeRow>(
      "SELECT * FROM session_runtime WHERE session_id = $1",
      [sessionId],
    );
    const row = result.rows[0];
    if (!row?.sandbox_id || !row?.supervisor_session_id || !row?.workspace_volume_id) {
      throw notFound("session_runtime_not_ready", "Session runtime is not ready.");
    }
    return runtimeFromRow(row);
  }

  async activeRuntimeSessionIds() {
    const result = await this.pool.query<{ session_id: string }>(
      `
        SELECT r.session_id
        FROM session_runtime r
        JOIN sessions s ON s.id = r.session_id
        WHERE r.sandbox_id IS NOT NULL
          AND r.supervisor_session_id IS NOT NULL
          AND r.desired_state = 'running'
          AND s.status IN ('running', 'waiting')
          AND s.hard_expires_at > NOW()
        ORDER BY r.session_id
      `,
    );
    return result.rows.map((row) => row.session_id);
  }

  async interruptedTurnMutations(): Promise<InterruptedTurnMutation[]> {
    const result = await this.pool.query<
      RuntimeRow & {
        head_snapshot_id: string;
        original_thread_id: string;
      }
    >(
      `SELECT r.*,
              head.workspace_snapshot_id AS head_snapshot_id,
              COALESCE(
                (
                  SELECT event.notification #>> '{params,threadId}'
                  FROM harness_events event
                  WHERE event.session_id = s.id AND event.visible
                    AND event.notification->>'method' = 'turn/completed'
                  ORDER BY event.sequence DESC LIMIT 1
                ),
                (
                  SELECT event.notification #>> '{params,thread,id}'
                  FROM harness_events event
                  WHERE event.session_id = s.id AND event.visible
                    AND event.notification->>'method' = 'thread/started'
                  ORDER BY event.sequence LIMIT 1
                ),
                r.thread_id
              ) AS original_thread_id
       FROM sessions s
       JOIN session_runtime r ON r.session_id = s.id
       JOIN LATERAL (
         SELECT workspace_snapshot_id
         FROM session_turn_checkpoints
         WHERE session_id = s.id AND status = 'ready'
         ORDER BY ordinal DESC LIMIT 1
       ) head ON TRUE
       WHERE s.status = 'paused' AND s.hard_expires_at > NOW()
         AND r.sandbox_id IS NOT NULL AND r.workspace_volume_id IS NOT NULL
         AND r.supervisor_session_id IS NOT NULL`,
    );
    return result.rows
      .filter((row) => Boolean(row.original_thread_id && row.head_snapshot_id))
      .map((row) => ({
        runtime: runtimeFromRow(row),
        headSnapshotId: row.head_snapshot_id,
        originalThreadId: row.original_thread_id,
      }));
  }

  async reconcileSessionStatus(sessionId: string) {
    const latest = await this.pool.query<{ method: string }>(
      `SELECT notification->>'method' AS method
       FROM harness_events
       WHERE session_id = $1 AND visible AND message_kind = 'notification'
         AND notification->>'method' IN ('turn/started', 'turn/completed')
       ORDER BY sequence DESC
       LIMIT 1`,
      [sessionId],
    );
    const method = latest.rows[0]?.method;
    if (!method) return;
    await this.pool.query(
      `UPDATE sessions
       SET status = $2
       WHERE id = $1
         AND status NOT IN ('completed', 'failed')
         AND hard_expires_at > NOW()`,
      [sessionId, method === "turn/completed" ? "waiting" : "running"],
    );
  }

  async beginSessionTurn(userId: string, sessionId: string) {
    const result = await this.pool.query(
      `UPDATE sessions s
       SET status = 'running', unread = FALSE
       FROM team_memberships m
       WHERE s.id = $2
         AND s.created_by_user_id = $1
         AND m.team_id = s.team_id
         AND m.user_id = $1
         AND m.status = 'active'
         AND s.status = 'waiting'
         AND s.hard_expires_at > NOW()
       RETURNING s.id`,
      [userId, sessionId],
    );
    if (result.rowCount) return;
    const session = await this.getSession(userId, sessionId);
    if (session.status === "running") {
      throw new HttpError(
        409,
        "turn_already_running",
        "Wait for the current Codex Turn to finish before sending another instruction.",
      );
    }
    throw new HttpError(
      409,
      "session_not_writable",
      "This Session cannot start another Turn.",
    );
  }

  async releaseSessionTurn(sessionId: string) {
    await this.pool.query(
      `UPDATE sessions SET status = 'waiting'
       WHERE id = $1 AND status = 'running' AND hard_expires_at > NOW()`,
      [sessionId],
    );
  }

  async reserveSessionFork(userId: string, sessionId: string) {
    const reserved = await this.pool.query(
      `UPDATE sessions
       SET status = 'running', unread = FALSE
       WHERE id = $1 AND created_by_user_id = $2 AND status = 'waiting'
         AND hard_expires_at > NOW()
       RETURNING id`,
      [sessionId, userId],
    );
    if (reserved.rowCount) return;
    await this.getSession(userId, sessionId);
    throw new HttpError(
      409,
      "session_fork_conflict",
      "The Session changed while the fork was starting.",
    );
  }

  async markSessionTurnCompleted(sessionId: string) {
    await this.pool.query(
      `UPDATE sessions
       SET status = 'waiting', unread = TRUE
       WHERE id = $1
         AND status NOT IN ('completed', 'failed')
         AND hard_expires_at > NOW()`,
      [sessionId],
    );
  }

  async listHarnessNotifications(
    userId: string,
    sessionId: string,
    after = 0,
  ): Promise<CodexEventEnvelope[]> {
    await this.getSession(userId, sessionId);
    const result = await this.pool.query(
      `
        SELECT h.sequence, h.harness_version, h.protocol_version,
               h.received_at, h.notification
        FROM harness_events h
        WHERE h.session_id = $1 AND h.sequence > $2 AND h.visible
          AND h.message_kind = 'notification'
          AND h.notification->>'method' IN (
            'turn/started', 'item/completed', 'turn/completed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM harness_events blocked
            WHERE blocked.session_id = h.session_id AND blocked.visible
              AND blocked.message_kind = 'notification'
              AND blocked.sequence <= h.sequence
              AND blocked.notification->>'method' = 'turn/completed'
              AND EXISTS (
                SELECT 1 FROM session_turn_checkpoints checkpoint
                WHERE checkpoint.session_id = blocked.session_id
                  AND checkpoint.turn_id = (blocked.notification #>> '{params,turn,id}')
                  AND checkpoint.status IN ('creating', 'failed')
              )
          )
        ORDER BY h.sequence
        LIMIT 1000
      `,
      [sessionId, after],
    );
    return result.rows.map(
      (row) =>
        ({
          harness: "codex",
          harnessVersion: row.harness_version,
          protocolVersion: row.protocol_version,
          sequence: Number(row.sequence),
          receivedAt: row.received_at.toISOString(),
          notification: row.notification,
        }) as CodexEventEnvelope,
    );
  }

  async sessionHistoryRevision(userId: string, sessionId: string) {
    const result = await this.pool.query<{ history_revision: string | number }>(
      `SELECT r.history_revision
       FROM session_runtime r
       JOIN sessions s ON s.id = r.session_id
       JOIN team_memberships m ON m.team_id = s.team_id
       WHERE r.session_id = $2 AND s.created_by_user_id = $1
         AND m.user_id = $1 AND m.status = 'active'`,
      [userId, sessionId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("session_not_found", "Session not found.");
    return Number(row.history_revision);
  }

  async assertTerminalWritable(userId: string, sessionId: string) {
    const result = await this.pool.query<{ status: string }>(
      `SELECT s.status
       FROM sessions s
       JOIN team_memberships m ON m.team_id = s.team_id
       WHERE s.id = $2 AND s.created_by_user_id = $1
         AND m.user_id = $1 AND m.status = 'active'`,
      [userId, sessionId],
    );
    const status = result.rows[0]?.status;
    if (!status) throw notFound("session_not_found", "Session not found.");
    if (status !== "waiting" && status !== "running") {
      throw new HttpError(
        409,
        "terminal_session_locked",
        "Terminal input is paused while Sandpi changes Session history.",
      );
    }
  }

  async getRpcResponse(sessionId: string, requestId: string) {
    const result = await this.pool.query<{ notification: Record<string, unknown> }>(
      `
        SELECT notification
        FROM harness_events
        WHERE session_id = $1 AND message_kind = 'response'
          AND notification->>'id' = $2
        ORDER BY sequence DESC
        LIMIT 1
      `,
      [sessionId, requestId],
    );
    return result.rows[0]?.notification;
  }

  async persistDecodedRecords(
    sessionId: string,
    state: CodexDecoderState,
    records: readonly DecodedCodexRecord[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const maxResult = await client.query<{ sequence: string }>(
        "SELECT COALESCE(MAX(sequence), 0)::TEXT AS sequence FROM harness_events WHERE session_id = $1",
        [sessionId],
      );
      let sequence = Number(maxResult.rows[0]?.sequence ?? 0);

      for (const record of records) {
        const kind = typeof record.message.method === "string" ? "notification" : "response";
        const inserted = await client.query(
          `
            INSERT INTO harness_events (
              session_id, sequence, harness, harness_version, protocol_version,
              runtime_generation, attempt_id, received_at, notification,
              supervisor_sequence, record_index, message_kind
            ) VALUES (
              $1, $2, 'codex', 'runtime', 'v2', $3, $4, $5, $6::JSONB,
              $7, $8, $9
            )
            ON CONFLICT (session_id, supervisor_sequence, record_index)
            DO NOTHING
            RETURNING id
          `,
          [
            sessionId,
            sequence + 1,
            record.runtimeGeneration,
            record.attemptId ?? null,
            record.receivedAt,
            JSON.stringify(record.message),
            record.supervisorSequence,
            record.recordIndex,
            kind,
          ],
        );
        if (inserted.rowCount) sequence += 1;

        const threadId = threadIdFromMessage(record.message);
        if (threadId) {
          await client.query(
            "UPDATE session_runtime SET thread_id = $2 WHERE session_id = $1",
            [sessionId, threadId],
          );
        }
      }

      await client.query(
        `
          UPDATE session_runtime
          SET supervisor_cursor = $2, stdout_tail = $3,
              attempt_id = $4, runtime_generation = $5,
              last_event_at = NOW(), version = version + 1
          WHERE session_id = $1
        `,
        [
          sessionId,
          state.supervisorCursor,
          state.tailBase64,
          state.attemptId ?? null,
          state.runtimeGeneration,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completedTurnUserItem(sessionId: string, turnId: string) {
    const result = await this.pool.query<{ item_id: string }>(
      `SELECT notification #>> '{params,item,id}' AS item_id
       FROM harness_events
       WHERE session_id = $1 AND visible
         AND notification->>'method' = 'item/completed'
         AND notification #>> '{params,turnId}' = $2
         AND notification #>> '{params,item,type}' = 'userMessage'
       ORDER BY sequence
       LIMIT 1`,
      [sessionId, turnId],
    );
    return result.rows[0]?.item_id;
  }

  async latestCompletedTurnId(sessionId: string) {
    const result = await this.pool.query<{ turn_id: string }>(
      `SELECT notification #>> '{params,turn,id}' AS turn_id
       FROM harness_events
       WHERE session_id = $1 AND visible
         AND notification->>'method' = 'turn/completed'
       ORDER BY sequence DESC
       LIMIT 1`,
      [sessionId],
    );
    return result.rows[0]?.turn_id;
  }

  async claimTurnCheckpoint(
    sessionId: string,
    input: {
      turnId?: string;
      userMessageItemId?: string;
      nativeHeadTurnId?: string;
    },
  ): Promise<TurnCheckpointClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const existing = await client.query<{
        id: string;
        ordinal: number;
        status: string;
      }>(
        input.turnId
          ? `SELECT id, ordinal, status FROM session_turn_checkpoints
             WHERE session_id = $1 AND turn_id = $2`
          : `SELECT id, ordinal, status FROM session_turn_checkpoints
             WHERE session_id = $1 AND ordinal = 0`,
        input.turnId ? [sessionId, input.turnId] : [sessionId],
      );
      const row = existing.rows[0];
      if (row?.status === "creating" || row?.status === "ready") {
        await client.query("COMMIT");
        return { state: row.status };
      }
      if (row) {
        await client.query(
          `UPDATE session_turn_checkpoints
           SET status = 'creating', workspace_snapshot_id = NULL, error = NULL
           WHERE id = $1`,
          [row.id],
        );
        await client.query("COMMIT");
        return { state: "claimed", id: row.id, ordinal: Number(row.ordinal) };
      }

      const ordinal = input.turnId
        ? Number(
            (
              await client.query<{ ordinal: number }>(
                `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
                 FROM session_turn_checkpoints
                 WHERE session_id = $1 AND status = 'ready'`,
                [sessionId],
              )
            ).rows[0]?.ordinal ?? 1,
          )
        : 0;
      const id = `checkpoint_${randomUUID()}`;
      await client.query(
        `INSERT INTO session_turn_checkpoints (
           id, session_id, ordinal, turn_id, user_message_item_id,
           native_head_turn_id, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'creating')`,
        [
          id,
          sessionId,
          ordinal,
          input.turnId ?? null,
          input.userMessageItemId ?? null,
          input.nativeHeadTurnId ?? input.turnId ?? null,
        ],
      );
      await client.query("COMMIT");
      return { state: "claimed", id, ordinal };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeTurnCheckpoint(checkpointId: string, snapshotId: string) {
    const completed = await this.pool.query(
      `UPDATE session_turn_checkpoints
       SET status = 'ready', workspace_snapshot_id = $2, error = NULL
       WHERE id = $1 AND status = 'creating'
       RETURNING id`,
      [checkpointId, snapshotId],
    );
    if (!completed.rowCount) {
      throw new HttpError(
        409,
        "turn_checkpoint_claim_lost",
        "The Workspace checkpoint claim is no longer active.",
      );
    }
  }

  async failTurnCheckpoint(checkpointId: string, error: string) {
    await this.pool.query(
      `UPDATE session_turn_checkpoints
       SET status = 'failed', workspace_snapshot_id = NULL, error = $2
       WHERE id = $1 AND status = 'creating'`,
      [checkpointId, error],
    );
  }

  async recoverStaleTurnCheckpointClaims() {
    await this.pool.query(
      `UPDATE session_turn_checkpoints
       SET status = 'failed', error = 'Checkpoint worker stopped before completion.'
       WHERE status = 'creating'
         AND updated_at < NOW() - INTERVAL '2 minutes'`,
    );
  }

  async retryableTurnCheckpoints(sessionId: string) {
    const result = await this.pool.query<{
      turn_id: string;
      user_message_item_id: string;
      native_head_turn_id: string;
    }>(
      `SELECT turn_id, user_message_item_id, native_head_turn_id
       FROM session_turn_checkpoints
       WHERE session_id = $1 AND status = 'failed' AND turn_id IS NOT NULL
         AND updated_at < NOW() - INTERVAL '5 seconds'
       ORDER BY ordinal
       LIMIT 1`,
      [sessionId],
    );
    return result.rows.map(
      (row): RetryableTurnCheckpoint => ({
        turnId: row.turn_id,
        userMessageItemId: row.user_message_item_id,
        nativeHeadTurnId: row.native_head_turn_id,
      }),
    );
  }

  async reserveTurnFork(
    userId: string,
    sessionId: string,
    userMessageItemId: string,
  ): Promise<TurnForkPoint> {
    await this.getSession(userId, sessionId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const selected = await client.query<{
        ordinal: number;
        turn_id: string;
        workspace_snapshot_id: string;
        upper_sequence: string;
      }>(
        `SELECT c.ordinal, c.turn_id, c.workspace_snapshot_id,
                completed.sequence::TEXT AS upper_sequence
         FROM session_turn_checkpoints c
         JOIN LATERAL (
           SELECT sequence
           FROM harness_events
           WHERE session_id = c.session_id AND visible
             AND notification->>'method' = 'turn/completed'
             AND notification #>> '{params,turn,id}' = c.turn_id
           ORDER BY sequence DESC
           LIMIT 1
         ) completed ON TRUE
         WHERE c.session_id = $1 AND c.user_message_item_id = $2
           AND c.status = 'ready'`,
        [sessionId, userMessageItemId],
      );
      const checkpoint = selected.rows[0];
      if (!checkpoint?.workspace_snapshot_id) {
        throw new HttpError(
          409,
          "turn_checkpoint_unavailable",
          "This Turn does not have a recoverable Workspace checkpoint.",
        );
      }
      const reserved = await client.query(
        `UPDATE sessions
         SET status = 'running', unread = FALSE
         WHERE id = $1 AND created_by_user_id = $2 AND status = 'waiting'
           AND hard_expires_at > NOW()
         RETURNING id`,
        [sessionId, userId],
      );
      if (!reserved.rowCount) {
        throw new HttpError(
          409,
          "turn_fork_conflict",
          "The Session changed while the Turn fork was starting.",
        );
      }
      await client.query("COMMIT");
      return {
        selectedTurnId: checkpoint.turn_id,
        selectedOrdinal: Number(checkpoint.ordinal),
        selectedSnapshotId: checkpoint.workspace_snapshot_id,
        upperSequence: Number(checkpoint.upper_sequence),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseTurnFork(sessionId: string) {
    await this.pool.query(
      `UPDATE sessions SET status = 'waiting'
       WHERE id = $1 AND status = 'running' AND hard_expires_at > NOW()`,
      [sessionId],
    );
  }

  async prepareTurnMutation(
    userId: string,
    sessionId: string,
    userMessageItemId: string,
  ): Promise<TurnMutationContext> {
    const session = await this.getSession(userId, sessionId);
    if (session.status !== "waiting") {
      throw new HttpError(
        409,
        "turn_mutation_not_ready",
        "Wait for the current Codex Turn to finish before changing history.",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const selected = await client.query<{
        ordinal: number;
        turn_id: string;
      }>(
        `SELECT ordinal, turn_id
         FROM session_turn_checkpoints
         WHERE session_id = $1 AND user_message_item_id = $2
           AND status = 'ready'`,
        [sessionId, userMessageItemId],
      );
      const checkpoint = selected.rows[0];
      if (!checkpoint) {
        throw new HttpError(
          409,
          "turn_checkpoint_unavailable",
          "This Turn predates its recoverable Workspace checkpoint.",
        );
      }
      const previous = await client.query<{
        workspace_snapshot_id: string;
        native_head_turn_id: string | null;
      }>(
        `SELECT workspace_snapshot_id, native_head_turn_id
         FROM session_turn_checkpoints
         WHERE session_id = $1 AND ordinal < $2 AND status = 'ready'
         ORDER BY ordinal DESC
         LIMIT 1`,
        [sessionId, Number(checkpoint.ordinal)],
      );
      const restore = previous.rows[0];
      if (!restore?.workspace_snapshot_id) {
        throw new HttpError(
          409,
          "turn_checkpoint_unavailable",
          "The Workspace checkpoint before this Turn is unavailable.",
        );
      }
      const head = await client.query<{ workspace_snapshot_id: string }>(
        `SELECT workspace_snapshot_id
         FROM session_turn_checkpoints
         WHERE session_id = $1 AND status = 'ready'
         ORDER BY ordinal DESC
         LIMIT 1`,
        [sessionId],
      );
      if (!head.rows[0]?.workspace_snapshot_id) {
        throw new HttpError(
          409,
          "turn_checkpoint_unavailable",
          "The current Workspace checkpoint is unavailable.",
        );
      }
      const boundary = await client.query<{ sequence: string }>(
        `SELECT sequence::TEXT
         FROM harness_events
         WHERE session_id = $1 AND visible
           AND notification->>'method' = 'turn/started'
           AND notification #>> '{params,turn,id}' = $2
         ORDER BY sequence
         LIMIT 1`,
        [sessionId, checkpoint.turn_id],
      );
      if (!boundary.rows[0]) {
        throw new HttpError(
          409,
          "turn_boundary_unavailable",
          "The native Codex Turn boundary is unavailable.",
        );
      }
      const upper = await client.query<{ sequence: string }>(
        `SELECT COALESCE(MAX(sequence), 0)::TEXT AS sequence
         FROM harness_events WHERE session_id = $1`,
        [sessionId],
      );
      const locked = await client.query(
        `UPDATE sessions
         SET status = 'paused', unread = FALSE
         WHERE id = $1 AND created_by_user_id = $2 AND status = 'waiting'
           AND hard_expires_at > NOW()
         RETURNING id`,
        [sessionId, userId],
      );
      if (!locked.rowCount) {
        throw new HttpError(
          409,
          "turn_mutation_conflict",
          "The Session changed while the Turn operation was starting.",
        );
      }
      await client.query(
        `UPDATE session_runtime SET desired_state = 'paused'
         WHERE session_id = $1`,
        [sessionId],
      );
      await client.query("COMMIT");
      return {
        selectedTurnId: checkpoint.turn_id,
        selectedOrdinal: Number(checkpoint.ordinal),
        boundarySequence: Number(boundary.rows[0].sequence),
        upperSequence: Number(upper.rows[0]?.sequence ?? 0),
        restoreSnapshotId: restore.workspace_snapshot_id,
        headSnapshotId: head.rows[0].workspace_snapshot_id,
        branchThroughTurnId: restore.native_head_turn_id ?? undefined,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setRestoredRuntime(
    sessionId: string,
    input: { threadId: string; attemptId: string; runtimeGeneration: number },
  ) {
    await this.pool.query(
      `UPDATE session_runtime
       SET thread_id = $2, attempt_id = $3, runtime_generation = $4,
           stdout_tail = '', observed_state = 'running',
           provisioning_error = NULL, version = version + 1
       WHERE session_id = $1`,
      [sessionId, input.threadId, input.attemptId, input.runtimeGeneration],
    );
  }

  async setRuntimeThread(sessionId: string, threadId: string) {
    await this.pool.query(
      `UPDATE session_runtime SET thread_id = $2, version = version + 1
       WHERE session_id = $1`,
      [sessionId, threadId],
    );
  }

  async finalizeTurnMutation(
    sessionId: string,
    context: TurnMutationContext,
    status: "running" | "waiting" = "waiting",
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      await client.query(
        `UPDATE harness_events
         SET visible = FALSE, superseded_at = NOW()
         WHERE session_id = $1 AND sequence BETWEEN $2 AND $3 AND visible`,
        [sessionId, context.boundarySequence, context.upperSequence],
      );
      const invalidated = await client.query<{ workspace_snapshot_id: string }>(
        `UPDATE session_turn_checkpoints
         SET status = 'deleted'
         WHERE session_id = $1 AND ordinal >= $2 AND status = 'ready'
         RETURNING workspace_snapshot_id`,
        [sessionId, context.selectedOrdinal],
      );
      await client.query(
        `UPDATE sessions SET status = $2, unread = FALSE WHERE id = $1`,
        [sessionId, status],
      );
      await client.query(
        `UPDATE session_runtime
         SET desired_state = 'running', observed_state = 'running',
             history_revision = history_revision + 1
         WHERE session_id = $1`,
        [sessionId],
      );
      await client.query("COMMIT");
      return invalidated.rows.map((row) => row.workspace_snapshot_id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async abortTurnMutation(sessionId: string, error: string) {
    await this.pool.query(
      `WITH changed AS (
         UPDATE sessions SET status = 'failed' WHERE id = $1
       )
       UPDATE session_runtime
       SET desired_state = 'running', observed_state = 'failed',
           provisioning_error = $2
       WHERE session_id = $1`,
      [sessionId, error],
    );
  }

  async releasePreparedTurnMutation(sessionId: string) {
    await this.pool.query(
      `WITH changed AS (
         UPDATE sessions SET status = 'waiting'
         WHERE id = $1 AND status = 'paused'
       )
       UPDATE session_runtime
       SET desired_state = 'running', observed_state = 'running',
           provisioning_error = NULL
       WHERE session_id = $1`,
      [sessionId],
    );
  }

  async setSessionMetadata(
    userId: string,
    sessionId: string,
    changes: {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      unread?: boolean;
    },
  ) {
    await this.getSession(userId, sessionId);
    const current = await this.pool.query(
      `UPDATE sessions
       SET title = COALESCE($2, title), pinned = COALESCE($3, pinned),
           archived = COALESCE($4, archived), unread = COALESCE($5, unread)
       WHERE id = $1 RETURNING id`,
      [
        sessionId,
        changes.title ?? null,
        changes.pinned ?? null,
        changes.archived ?? null,
        changes.unread ?? null,
      ],
    );
    if (!current.rowCount) throw notFound("session_not_found", "Session not found.");
    return this.getSession(userId, sessionId);
  }

  async getPreferences(userId: string): Promise<SandpiPreferences> {
    const result = await this.pool.query(
      "SELECT * FROM user_preferences WHERE user_id = $1",
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("preferences_not_found", "Preferences not found.");
    return {
      general: {
        language: row.language,
        timeZone: row.time_zone,
        sendShortcut: row.send_shortcut,
      },
      appearance: { theme: row.theme, density: row.density },
      notifications: {
        sessionCompleted: row.notify_session_completed,
        needsAttention: row.notify_needs_attention,
      },
    };
  }

  async updatePreferences(userId: string, value: SandpiPreferences) {
    await this.pool.query(
      `
        UPDATE user_preferences
        SET language = $2, time_zone = $3, send_shortcut = $4,
            theme = $5, density = $6, notify_session_completed = $7,
            notify_needs_attention = $8
        WHERE user_id = $1
      `,
      [
        userId,
        value.general.language,
        value.general.timeZone,
        value.general.sendShortcut,
        value.appearance.theme,
        value.appearance.density,
        value.notifications.sessionCompleted,
        value.notifications.needsAttention,
      ],
    );
    return this.getPreferences(userId);
  }

  async updateMembershipPlan(
    userId: string,
    teamId: string,
    membershipId: string,
    planId: "free" | "pro" | "max",
  ) {
    const actor = await this.pool.query<{ role: string }>(
      `SELECT role FROM team_memberships
       WHERE team_id = $1 AND user_id = $2 AND status = 'active'`,
      [teamId, userId],
    );
    if (!actor.rows[0] || !["owner", "admin"].includes(actor.rows[0].role)) {
      throw notFound("team_not_found", "Team not found.");
    }
    const plan = SANDPI_PLANS.find((candidate) => candidate.id === planId);
    if (!plan) throw notFound("plan_not_found", "Plan not found.");
    const result = await this.pool.query(
      `
        UPDATE team_memberships
        SET plan_id = $3,
            plan_quotas = jsonb_set(
              jsonb_set(
                jsonb_set(plan_quotas, '{weeklyExecution,limit}', to_jsonb($4::INTEGER)),
                '{concurrentSessions,limit}', to_jsonb($5::INTEGER)
              ),
              '{snapshotStorage,limit}', to_jsonb($6::INTEGER)
            )
        WHERE id = $2 AND team_id = $1
        RETURNING *
      `,
      [
        teamId,
        membershipId,
        planId,
        plan.execution.weeklyLimitMinutes,
        plan.execution.concurrentSessionLimit,
        plan.storage.snapshotLimitGiB,
      ],
    );
    const row = result.rows[0];
    if (!row) throw notFound("membership_not_found", "Membership not found.");
    const user = await this.pool.query<UserRow>(
      "SELECT id, email, name, avatar_initials FROM users WHERE id = $1",
      [row.user_id],
    );
    const memberUser = user.rows[0];
    return membershipFromRow({
      ...row,
      user_id: row.user_id,
      email: memberUser.email,
      name: memberUser.name,
      avatar_initials: memberUser.avatar_initials,
    });
  }

  private async eventsBySession(sessionIds: string[]) {
    const grouped = new Map<string, CodexEventEnvelope[]>();
    if (sessionIds.length === 0) return grouped;
    const result = await this.pool.query(
      `
        SELECT h.session_id, h.sequence, h.harness_version, h.protocol_version,
               h.received_at, h.notification
        FROM harness_events h
        WHERE h.session_id = ANY($1::TEXT[]) AND h.visible
          AND h.message_kind = 'notification'
          AND h.notification->>'method' IN (
            'turn/started', 'item/completed', 'turn/completed'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM harness_events blocked
            WHERE blocked.session_id = h.session_id AND blocked.visible
              AND blocked.message_kind = 'notification'
              AND blocked.sequence <= h.sequence
              AND blocked.notification->>'method' = 'turn/completed'
              AND EXISTS (
                SELECT 1 FROM session_turn_checkpoints checkpoint
                WHERE checkpoint.session_id = blocked.session_id
                  AND checkpoint.turn_id = (blocked.notification #>> '{params,turn,id}')
                  AND checkpoint.status IN ('creating', 'failed')
              )
          )
        ORDER BY h.session_id, h.sequence
      `,
      [sessionIds],
    );
    for (const row of result.rows) {
      const events = grouped.get(row.session_id) ?? [];
      events.push({
        harness: "codex",
        harnessVersion: row.harness_version,
        protocolVersion: row.protocol_version,
        sequence: Number(row.sequence),
        receivedAt: row.received_at.toISOString(),
        notification: row.notification,
      } as CodexEventEnvelope);
      grouped.set(row.session_id, events);
    }
    return grouped;
  }

  private async recoverableItemsBySession(sessionIds: string[]) {
    const grouped = new Map<string, string[]>();
    if (sessionIds.length === 0) return grouped;
    const result = await this.pool.query<{
      session_id: string;
      user_message_item_id: string;
    }>(
      `SELECT session_id, user_message_item_id
       FROM session_turn_checkpoints
       WHERE session_id = ANY($1::TEXT[]) AND status = 'ready'
         AND user_message_item_id IS NOT NULL
       ORDER BY session_id, ordinal`,
      [sessionIds],
    );
    for (const row of result.rows) {
      const items = grouped.get(row.session_id) ?? [];
      items.push(row.user_message_item_id);
      grouped.set(row.session_id, items);
    }
    return grouped;
  }
}

const SESSION_SELECT = `
  SELECT s.*, r.sandbox_id, r.workspace_volume_id, r.supervisor_session_id,
         r.terminal_session_id, r.thread_id, r.model_id, r.history_revision
  FROM sessions s
  JOIN team_memberships m ON m.team_id = s.team_id
  LEFT JOIN session_runtime r ON r.session_id = s.id
`;

function userFromRow(row: UserRow): SandpiUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarInitials: row.avatar_initials,
  };
}

function teamFromRow(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    color: row.color,
    memberCount: Number(row.member_count),
    billingAccount: {
      id: row.billing_account_id,
      status: row.billing_status,
      billingCadence: row.billing_cadence,
      billingEmail: row.billing_email,
      currentPeriodStartsAt: row.billing_period_starts_at.toISOString(),
      currentPeriodEndsAt: row.billing_period_ends_at.toISOString(),
    },
    createdAt: row.created_at.toISOString(),
  };
}

function membershipFromRow(row: MembershipRow): TeamMembership {
  return {
    id: row.id,
    teamId: row.team_id,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      avatarInitials: row.avatar_initials,
    },
    role: row.role,
    status: row.status,
    planAssignment: {
      id: row.plan_assignment_id,
      planId: row.plan_id,
      status: row.plan_status,
      currentPeriodStartsAt: row.plan_period_starts_at.toISOString(),
      currentPeriodEndsAt: row.plan_period_ends_at.toISOString(),
      quotas: row.plan_quotas,
    } satisfies MembershipPlanAssignment,
    joinedAt: row.joined_at.toISOString(),
  };
}

function environmentFromRow(row: EnvironmentRow): EnvironmentRecord {
  const metadata = row.harness_metadata ?? {};
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    color: row.color,
    status:
      row.status === "ready"
        ? "ready"
        : row.status === "error"
          ? "error"
          : "updating",
    revision: row.revision,
    templateId: row.template_id ?? "coding-agent",
    rootfsSnapshotId: row.rootfs_snapshot_id ?? "",
    workspaceVolumeId: row.workspace_volume_id ?? "",
    credentialRevision: row.credential_revision,
    codingAgent: {
      harness: row.harness,
      label: typeof metadata.label === "string" ? metadata.label : "Codex",
      status:
        metadata.status === "connected" ? "connected" : "not-connected",
      account: typeof metadata.account === "string" ? metadata.account : undefined,
      lastVerified:
        typeof metadata.lastVerified === "string"
          ? metadata.lastVerified
          : undefined,
    },
    networkPolicy: row.network_policy,
    functions: row.functions,
    provisioningError: row.provisioning_error ?? undefined,
  };
}

function sessionFromRow(
  row: SessionRow,
  events: CodexEventEnvelope[],
  recoverableUserMessageItemIds: string[] = [],
): CodingSession {
  const harnessState: CodexHarnessState = {
    protocol: "codex-app-server",
    threadId: row.thread_id ?? row.harness_state.threadId ?? "",
    modelId: row.model_id ?? row.harness_state.modelId ?? "",
    harnessVersion: row.harness_state.harnessVersion ?? "runtime",
    protocolVersion: "v2",
    historyRevision: Number(row.history_revision ?? 0),
    events,
    recoverableUserMessageItemIds,
  };
  const status: CodingSession["status"] =
    row.status === "running"
      ? "running"
      : row.status === "waiting" || row.status === "provisioning"
        ? "waiting"
        : row.status === "paused"
          ? "paused"
          : row.status === "failed"
            ? "failed"
            : "completed";
  return {
    id: row.id,
    environmentId: row.environment_id,
    title: row.title,
    status,
    unread: row.unread,
    pinned: row.pinned,
    archived: row.archived,
    harness: "codex",
    harnessLabel: "Codex",
    harnessState,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    hardExpiresAt: row.hard_expires_at.toISOString(),
    sandboxId: row.sandbox_id ?? "",
    supervisorSessionId: row.supervisor_session_id ?? "",
    workspaceRoot: row.workspace_root,
    workspaceVolumeId: row.workspace_volume_id ?? "",
    environmentRevision: row.environment_revision,
    origin:
      row.origin_kind && row.origin_label
        ? {
            kind: row.origin_kind,
            label: row.origin_label,
            sourceSessionId: row.source_session_id ?? undefined,
            sourceNativeItemId: row.source_native_item_id ?? undefined,
          }
        : undefined,
    files: [],
    audit: { events: [] },
    metrics: emptyMetrics(),
  };
}

function runtimeFromRow(row: RuntimeRow): StoredRuntime {
  return {
    id: row.session_id,
    sandboxId: row.sandbox_id,
    workspaceVolumeId: row.workspace_volume_id,
    supervisorSessionId: row.supervisor_session_id,
    terminalSessionId: row.terminal_session_id ?? undefined,
    supervisorCursor: Number(row.supervisor_cursor),
    threadId: row.thread_id ?? undefined,
    modelId: row.model_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    runtimeGeneration: Number(row.runtime_generation),
    provisioningError: row.provisioning_error ?? undefined,
    decoder: {
      supervisorCursor: Number(row.supervisor_cursor),
      tailBase64: row.stdout_tail,
      attemptId: row.attempt_id ?? undefined,
      runtimeGeneration: Number(row.runtime_generation),
    },
  };
}

function threadIdFromMessage(message: Record<string, unknown>) {
  if (!("result" in message) || !message.result || typeof message.result !== "object") {
    return undefined;
  }
  const thread = (message.result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object") return undefined;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function emptyMetrics(): CodingSession["metrics"] {
  const series = (
    metric: "sandbox.cpu.utilization" | "sandbox.memory.working_set" | "sandbox.network.io",
    unit: "ratio" | "bytes" | "bytes_per_second",
    statistic: "average" | "rate",
    dimensions?: Record<string, string>,
  ) => ({ metric, unit, statistic, dimensions, segments: [] });
  return {
    cpuUtilization: series("sandbox.cpu.utilization", "ratio", "average"),
    memoryWorkingSet: series("sandbox.memory.working_set", "bytes", "average"),
    memoryLimitBytes: 0,
    networkReceive: series(
      "sandbox.network.io",
      "bytes_per_second",
      "rate",
      { direction: "receive" },
    ),
    networkTransmit: series(
      "sandbox.network.io",
      "bytes_per_second",
      "rate",
      { direction: "transmit" },
    ),
  };
}
