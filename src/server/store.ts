import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CodexHarnessState } from "@/harnesses/codex/types";
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
import { parseUnixTimestamp, toUnixTimestamp } from "@/lib/time";
import { HttpError, notFound } from "@/server/http-error";
import type { CodexDecoderState } from "@/server/harnesses/codex/jsonl";
import type {
  ProvisionedEnvironment,
  ProvisionedSession,
  RecoveredCodexRuntime,
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
  version: number;
  decoder: CodexDecoderState;
  attemptId?: string;
  runtimeGeneration: number;
  historyRevision: number;
  headVolumeSnapshotId?: string;
  activeNativeTurnId?: string;
  pendingInterruptedNativeTurnId?: string;
  pendingTurnRequestId?: string;
  pendingTurnClientMessageId?: string;
  pendingTurnStableInputId?: string;
  pendingTurnPhase?: TurnSubmissionPhase;
  pendingTurnNativeTurnId?: string;
  pendingTurnStartedAt?: Date;
  pendingTurnSubmittedAt?: Date;
  runtimeErrorCode?: string;
  provisioningError?: string;
  exclusiveOperationId?: string;
  exclusiveOperationKind?:
    | "session_fork"
    | "turn_fork"
    | "runtime_recovery"
    | "native_state_migration";
  exclusiveOperationStartedAt?: Date;
  exclusiveOperationHeartbeatAt?: Date;
  nativeStateMigrationSnapshotId?: string;
  nativeHistoryMaterialized: boolean;
  desiredState: "running" | "paused" | "terminated";
  observedState:
    | "pending"
    | "provisioning"
    | "running"
    | "paused"
    | "terminated"
    | "failed";
}

export type TurnSubmissionPhase =
  | "prepared"
  | "snapshot_ready"
  | "staged"
  | "submitted"
  | "accepted";

export interface TurnSubmissionCoordinates {
  requestId: string;
  clientMessageId: string;
  stableInputId: string;
}

export type TurnMutationPhase =
  | "prepared"
  | "restore_requested"
  | "restored"
  | "replacement_started"
  | "compensating"
  | "failed";

export type TurnCheckpointClaim =
  | { state: "claimed"; id: string; ordinal: number }
  | { state: "ready" }
  | { state: "creating" };

export interface RetryableTurnCheckpoint {
  nativeSessionId: string;
  nativeTurnId: string;
  nativeHeadTurnId: string;
}

export interface InterruptedTurnMutation {
  mutationId: string;
  runtime: StoredRuntime;
  headSnapshotId: string;
  originalNativeSessionId: string;
  workspaceVolumeId: string;
  expectedHistoryRevision: number;
  phase: TurnMutationPhase;
}

export interface RuntimeCleanupRecord extends Partial<ProvisionedSession> {
  id: string;
}

export interface TurnMutationContext {
  mutationId: string;
  selectedTurnId: string;
  selectedOrdinal: number;
  /** Native head present in the exact input snapshot restored for this Turn. */
  inputNativeHeadTurnId?: string;
  nativeSessionId: string;
  workspaceVolumeId: string;
  expectedHistoryRevision: number;
  restoreSnapshotId: string;
  headSnapshotId: string;
}

export interface TurnForkPoint {
  operationId: string;
  selectedTurnId: string;
  selectedOrdinal: number;
  selectedSnapshotId: string;
}

export interface SessionOperationLock {
  signal: AbortSignal;
  release(): Promise<void>;
}

/** Scalar control-plane facts extracted from native events; never message content. */
export type CodexControlTransition =
  | {
      type: "nativeSession";
      nativeSessionId: string;
    }
  | {
      type: "turnStarted";
      nativeSessionId: string;
      nativeTurnId: string;
      startedAt: Date;
      supervisorSequence: number;
    }
  | {
      type: "turnCompleted";
      nativeSessionId: string;
      nativeTurnId: string;
      status: "completed" | "failed" | "interrupted";
      supervisorSequence: number;
    };

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
  native_session_id: string | null;
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
  plan_quotas: Omit<MembershipPlanAssignment["quotas"], "weeklyExecution"> & {
    weeklyExecution: Omit<
      MembershipPlanAssignment["quotas"]["weeklyExecution"],
      "resetsAt"
    > & { resetsAt: string | number };
  };
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
  native_session_id: string | null;
  model_id: string | null;
  attempt_id: string | null;
  runtime_generation: string | number;
  provisioning_error: string | null;
  active_native_turn_id: string | null;
  active_turn_started_at: Date | null;
  active_turn_supervisor_sequence: string | number | null;
  pending_interrupted_native_turn_id: string | null;
  pending_turn_request_id: string | null;
  pending_turn_client_message_id: string | null;
  pending_turn_stable_input_id: string | null;
  pending_turn_phase: TurnSubmissionPhase | null;
  pending_turn_native_turn_id: string | null;
  pending_turn_started_at: Date | null;
  pending_turn_submitted_at: Date | null;
  history_revision: string | number;
  harness_state_layout: RuntimeSessionRecord["harnessStateLayout"];
  head_volume_snapshot_id: string | null;
  runtime_error_code: string | null;
  version: string | number;
  exclusive_operation_id: string | null;
  exclusive_operation_kind:
    | "session_fork"
    | "turn_fork"
    | "runtime_recovery"
    | "native_state_migration"
    | null;
  exclusive_operation_started_at: Date | null;
  exclusive_operation_heartbeat_at: Date | null;
  native_state_migration_snapshot_id: string | null;
  native_history_materialized: boolean;
  desired_state: StoredRuntime["desiredState"];
  observed_state: StoredRuntime["observedState"];
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
    // Native coding-agent Sessions own conversation history. Navigation and
    // product metadata never load or copy native messages into PostgreSQL.
    return result.rows.map(sessionFromRow);
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
    return sessionFromRow(row);
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
          JSON.stringify({ protocol: "codex-app-server" }),
          JSON.stringify({ modelId: input.modelId ?? null }),
          input.environment.revision,
          input.environment.name,
          hardExpiresAt,
        ],
      );
      await client.query(
        `INSERT INTO session_runtime (
           session_id, model_id, desired_state, observed_state,
           harness_state_layout
         ) VALUES ($1, $2, 'running', 'provisioning', 'workspace_v2')`,
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
          JSON.stringify({ protocol: "codex-app-server" }),
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
           session_id, model_id, desired_state, observed_state,
           harness_state_layout
         ) VALUES ($1, $2, 'running', 'provisioning', 'workspace_v2')`,
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
      const runtimeUpdated = await client.query(
        `
          UPDATE session_runtime runtime
          SET sandbox_id = $2, workspace_volume_id = $3,
              supervisor_session_id = $4, attempt_id = $5,
              runtime_generation = $6, observed_state = 'running',
              provisioning_error = NULL, runtime_error_code = NULL,
              allocation_finalized_at = COALESCE(allocation_finalized_at, NOW())
          FROM sessions session
          WHERE runtime.session_id = $1 AND session.id = runtime.session_id
            AND session.status = 'provisioning'
            AND runtime.desired_state = 'running'
            AND runtime.resources_deleted_at IS NULL
            AND (runtime.sandbox_id IS NULL OR runtime.sandbox_id = $2)
            AND (runtime.workspace_volume_id IS NULL OR runtime.workspace_volume_id = $3)
          RETURNING runtime.session_id
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
      if (!runtimeUpdated.rowCount) {
        throw new HttpError(
          409,
          "session_allocation_rebind",
          "A Sandpi Session cannot be rebound to another Sandbox or Workspace Volume.",
        );
      }
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

  /** Exposes a fully initialized fork only after its native baseline exists. */
  async markSessionReady(sessionId: string) {
    const ready = await this.pool.query(
      `UPDATE sessions session
       SET status = 'waiting', unread = FALSE
       FROM session_runtime runtime
       WHERE session.id = $1 AND runtime.session_id = session.id
         AND session.status = 'provisioning'
         AND runtime.native_session_id IS NOT NULL
         AND runtime.head_volume_snapshot_id IS NOT NULL
       RETURNING session.id`,
      [sessionId],
    );
    if (!ready.rowCount) {
      throw new HttpError(
        409,
        "session_initialization_incomplete",
        "The Session native baseline is not ready.",
      );
    }
  }

  /**
   * Atomically exposes a newly created Session and journals its first native
   * Turn. Prompt content remains only in the RPC frame and native rollout.
   */
  async beginInitialTurnSubmission(
    sessionId: string,
    inputSnapshotId: string,
    submission: TurnSubmissionCoordinates,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const started = await client.query(
        `WITH exposed AS (
           UPDATE sessions session
           SET status = 'running', unread = FALSE
           FROM session_runtime current_runtime
           WHERE session.id = $1
             AND current_runtime.session_id = session.id
             AND session.status = 'provisioning'
             AND current_runtime.native_session_id IS NOT NULL
             AND current_runtime.head_volume_snapshot_id = $2
             AND current_runtime.pending_turn_phase IS NULL
             AND current_runtime.pending_turn_input_snapshot_id IS NULL
           RETURNING session.id
         )
         UPDATE session_runtime runtime
         SET pending_turn_input_snapshot_id = $2,
             pending_turn_request_id = $3,
             pending_turn_client_message_id = $4,
             pending_turn_stable_input_id = $5,
             pending_turn_phase = 'snapshot_ready',
             pending_turn_native_turn_id = NULL,
             pending_turn_started_at = NOW(),
             pending_turn_submitted_at = NULL,
             version = version + 1,
             updated_at = NOW()
         FROM exposed
         WHERE runtime.session_id = exposed.id
         RETURNING runtime.session_id`,
        [
          sessionId,
          inputSnapshotId,
          submission.requestId,
          submission.clientMessageId,
          submission.stableInputId,
        ],
      );
      if (!started.rowCount) {
        throw new HttpError(
          409,
          "turn_submission_conflict",
          "The initial native Turn could not be journaled.",
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
              runtime_error_code = 'session_failed',
              resources_deleted_at = CASE WHEN $3 THEN NOW() ELSE resources_deleted_at END,
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
    const recorded = await this.pool.query(
      `UPDATE session_runtime runtime
       SET sandbox_id = COALESCE(runtime.sandbox_id, $2),
           workspace_volume_id = COALESCE(runtime.workspace_volume_id, $3),
           supervisor_session_id = COALESCE($4, runtime.supervisor_session_id),
           attempt_id = COALESCE($5, runtime.attempt_id),
           runtime_generation = GREATEST(
             runtime.runtime_generation, COALESCE($6, 0)
           ),
           observed_state = 'provisioning', version = runtime.version + 1
       FROM sessions session
       WHERE runtime.session_id = $1 AND session.id = runtime.session_id
         AND session.status = 'provisioning'
         AND runtime.desired_state = 'running'
         AND runtime.resources_deleted_at IS NULL
         AND ($2::TEXT IS NULL OR runtime.sandbox_id IS NULL OR runtime.sandbox_id = $2)
         AND ($3::TEXT IS NULL OR runtime.workspace_volume_id IS NULL OR runtime.workspace_volume_id = $3)`,
      [
        sessionId,
        resources.sandboxId ?? null,
        resources.workspaceVolumeId ?? null,
        resources.supervisorSessionId ?? null,
        resources.attemptId ?? null,
        resources.runtimeGeneration ?? null,
      ],
    );
    if (!recorded.rowCount) {
      throw new HttpError(
        409,
        "session_allocation_rebind",
        "A Sandpi Session cannot be rebound to another Sandbox or Workspace Volume.",
      );
    }
  }

  /**
   * Reconciles recovered native coordinates with compare-and-swap semantics.
   * A new Supervisor owns a new event journal whose sequence starts at zero;
   * any new process attempt also owns a fresh JSONL decoder tail.
   */
  async replaceRecoveredCodexRuntime(
    sessionId: string,
    operationId: string,
    expectedSupervisorSessionId: string,
    recovered: RecoveredCodexRuntime,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const result = await client.query(
        `UPDATE session_runtime
         SET supervisor_session_id = $3,
             supervisor_cursor = CASE WHEN $2 <> $3 THEN 0 ELSE supervisor_cursor END,
             stdout_tail = CASE
               WHEN $2 <> $3
                 OR attempt_id IS DISTINCT FROM $4
                 OR runtime_generation <> $5
               THEN '' ELSE stdout_tail
             END,
             attempt_id = $4, runtime_generation = $5,
             terminal_session_id = CASE WHEN $6 THEN NULL ELSE terminal_session_id END,
             observed_state = 'provisioning',
             provisioning_error = 'Codex runtime initialization is pending.',
             version = version + 1
         WHERE session_id = $1 AND supervisor_session_id = $2
           AND exclusive_operation_id = $7
         RETURNING session_id`,
        [
          sessionId,
          expectedSupervisorSessionId,
          recovered.supervisorSessionId,
          recovered.attemptId,
          recovered.runtimeGeneration,
          recovered.sandboxRestarted,
          operationId,
        ],
      );
      await client.query("COMMIT");
      return Boolean(result.rowCount);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markRecoveredCodexRuntimeReady(
    sessionId: string,
    operationId: string,
    supervisorSessionId: string,
    attemptId: string,
  ) {
    const result = await this.pool.query(
      `UPDATE session_runtime
       SET observed_state = 'running', provisioning_error = NULL,
           runtime_error_code = NULL,
           version = version + 1
       WHERE session_id = $1 AND supervisor_session_id = $2
         AND attempt_id = $3 AND exclusive_operation_id = $4`,
      [sessionId, supervisorSessionId, attemptId, operationId],
    );
    return Boolean(result.rowCount);
  }

  async markRecoveredTurnInterrupted(
    sessionId: string,
    operationId: string,
    supervisorSessionId: string,
    attemptId: string,
    turnId: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const runtimeUpdated = await client.query(
        `UPDATE session_runtime
         SET active_native_turn_id = NULL,
             active_turn_started_at = NULL,
             active_turn_supervisor_sequence = NULL,
             pending_interrupted_native_turn_id = NULL,
             version = version + 1
         WHERE session_id = $1 AND supervisor_session_id = $2
           AND attempt_id = $3
           AND exclusive_operation_id = $5
           AND (
             active_native_turn_id = $4
             OR pending_interrupted_native_turn_id = $4
           )
         RETURNING session_id`,
        [sessionId, supervisorSessionId, attemptId, turnId, operationId],
      );
      if (runtimeUpdated.rowCount) {
        await client.query(
          `UPDATE sessions
           SET status = 'waiting', unread = TRUE
           WHERE id = $1 AND status = 'running'
             AND NOT EXISTS (
               SELECT 1 FROM session_runtime runtime
               WHERE runtime.session_id = sessions.id
                 AND runtime.exclusive_operation_id IS NOT NULL
             )`,
          [sessionId],
        );
      }
      await client.query("COMMIT");
      return Boolean(runtimeUpdated.rowCount);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markRecoveredCodexRuntimeFailed(
    sessionId: string,
    operationId: string,
    supervisorSessionId: string,
    attemptId: string,
    error: string,
  ) {
    const result = await this.pool.query(
      `UPDATE session_runtime
       SET observed_state = 'failed', provisioning_error = $2,
           runtime_error_code = 'codex_runtime_recovery_failed',
           version = version + 1
       WHERE session_id = $1 AND supervisor_session_id = $3
         AND attempt_id = $4 AND exclusive_operation_id = $5`,
      [sessionId, error, supervisorSessionId, attemptId, operationId],
    );
    return Boolean(result.rowCount);
  }

  async markNativeSessionUnrecoverable(
    sessionId: string,
    error: string,
    expectedOperationId?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runtime = await client.query(
        `UPDATE session_runtime
         SET observed_state = 'failed',
             provisioning_error = CASE
               WHEN runtime_error_code = 'native_session_unrecoverable'
               THEN provisioning_error
               ELSE $2
             END,
             runtime_error_code = 'native_session_unrecoverable',
             active_native_turn_id = NULL,
             active_turn_started_at = NULL,
             active_turn_supervisor_sequence = NULL,
             version = version + 1
         WHERE session_id = $1
           AND ($3::TEXT IS NULL OR exclusive_operation_id = $3)
         RETURNING session_id`,
        [sessionId, error, expectedOperationId ?? null],
      );
      if (!runtime.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE sessions
         SET status = 'failed', unread = TRUE, updated_at = NOW()
         WHERE id = $1 AND status <> 'completed'`,
        [sessionId],
      );
      await client.query("COMMIT");
      return true;
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  /**
   * Marks the immutable Sandbox allocation as lost without deleting its
   * Workspace Volume coordinates. Sandpi must never heal this by rebinding the
   * product Session to a replacement Sandbox.
   */
  async markSessionAllocationUnrecoverable(
    sessionId: string,
    error: string,
    expectedOperationId?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runtime = await client.query(
        `UPDATE session_runtime
         SET observed_state = 'failed',
             provisioning_error = CASE
               WHEN runtime_error_code = 'session_allocation_unrecoverable'
               THEN provisioning_error
               ELSE $2
             END,
             runtime_error_code = 'session_allocation_unrecoverable',
             active_native_turn_id = NULL,
             active_turn_started_at = NULL,
             active_turn_supervisor_sequence = NULL,
             version = version + 1
         WHERE session_id = $1
           AND ($3::TEXT IS NULL OR exclusive_operation_id = $3)
         RETURNING session_id`,
        [sessionId, error, expectedOperationId ?? null],
      );
      if (!runtime.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE sessions
         SET status = 'failed', unread = TRUE, updated_at = NOW()
         WHERE id = $1 AND status <> 'completed'`,
        [sessionId],
      );
      await client.query("COMMIT");
      return true;
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async recoveredTurnInterruptionClaim(sessionId: string) {
    const result = await this.pool.query<{ turn_id: string | null }>(
      `SELECT pending_interrupted_native_turn_id AS turn_id
       FROM session_runtime WHERE session_id = $1`,
      [sessionId],
    );
    return result.rows[0]?.turn_id ?? undefined;
  }

  async recordRecoveredTurnInterruption(
    sessionId: string,
    operationId: string,
    supervisorSessionId: string,
    attemptId: string,
    turnId: string,
  ) {
    const result = await this.pool.query(
      `UPDATE session_runtime
       SET pending_interrupted_native_turn_id = $4,
           version = version + 1
       WHERE session_id = $1 AND supervisor_session_id = $2
         AND attempt_id = $3
         AND exclusive_operation_id = $5
       RETURNING session_id`,
      [sessionId, supervisorSessionId, attemptId, turnId, operationId],
    );
    return Boolean(result.rowCount);
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
       ORDER BY s.hard_expires_at`,
    );
    return result.rows.map((row) => ({
      id: row.session_id,
      sandboxId: row.sandbox_id ?? undefined,
      workspaceVolumeId: row.workspace_volume_id ?? undefined,
      supervisorSessionId: row.supervisor_session_id ?? undefined,
    }));
  }

  /**
   * Reclaims incomplete allocations only. An established Session that later
   * becomes unrecoverable keeps its Workspace Volume until the 30-day hard TTL.
   */
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
           (s.status = 'failed' AND r.runtime_error_code = 'session_failed')
           OR (s.status = 'provisioning' AND s.updated_at < NOW() - INTERVAL '10 minutes')
         )
         AND r.observed_state <> 'terminated'
       ORDER BY s.updated_at`,
    );
    return result.rows.map((row) => ({
      id: row.session_id,
      sandboxId: row.sandbox_id ?? undefined,
      workspaceVolumeId: row.workspace_volume_id ?? undefined,
      supervisorSessionId: row.supervisor_session_id ?? undefined,
    }));
  }

  /**
   * Atomically stops a failed provisioning attempt before its external
   * resources are enumerated. The caller holds the Session operation lock
   * across this claim, Sandbox0 deletion, and the final database transition.
   * A late allocation callback therefore either lands before this UPDATE and
   * is returned below, or loses its `desired_state = 'running'` CAS and cleans
   * the resource from the provisioning call's own failure path.
   */
  async claimFailedRuntimeSession(
    sessionId: string,
  ): Promise<RuntimeCleanupRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const claimed = await client.query<{
        session_id: string;
        sandbox_id: string | null;
        workspace_volume_id: string | null;
        supervisor_session_id: string | null;
      }>(
        `WITH eligible AS (
           SELECT session.id
           FROM sessions session
           JOIN session_runtime runtime ON runtime.session_id = session.id
           WHERE session.id = $1
             AND (
               (session.status = 'failed'
                AND runtime.runtime_error_code = 'session_failed')
               OR (
                 session.status = 'provisioning'
                 AND session.updated_at < NOW() - INTERVAL '10 minutes'
               )
             )
             AND runtime.observed_state <> 'terminated'
             AND runtime.resources_deleted_at IS NULL
           FOR UPDATE OF session, runtime
         ), failed AS (
           UPDATE sessions session
           SET status = 'failed', updated_at = NOW()
           FROM eligible
           WHERE session.id = eligible.id
           RETURNING session.id
         )
         UPDATE session_runtime runtime
         SET desired_state = 'terminated',
             runtime_error_code = 'session_failed',
             provisioning_error = COALESCE(
               runtime.provisioning_error,
               'Session provisioning did not finish.'
             ),
             version = runtime.version + 1,
             updated_at = NOW()
         FROM failed
         WHERE runtime.session_id = failed.id
         RETURNING runtime.session_id, runtime.sandbox_id,
                   runtime.workspace_volume_id, runtime.supervisor_session_id`,
        [sessionId],
      );
      await client.query("COMMIT");
      const row = claimed.rows[0];
      if (!row) return undefined;
      return {
        id: row.session_id,
        sandboxId: row.sandbox_id ?? undefined,
        workspaceVolumeId: row.workspace_volume_id ?? undefined,
        supervisorSessionId: row.supervisor_session_id ?? undefined,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markFailedSessionResourcesCleaned(sessionId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cleaned = await client.query(
        `WITH changed AS (
           UPDATE sessions SET status = 'failed', archived = TRUE WHERE id = $1
         )
         UPDATE session_runtime
         SET desired_state = 'terminated', observed_state = 'terminated',
             terminal_session_id = NULL, resources_deleted_at = NOW()
         WHERE session_id = $1
           AND desired_state = 'terminated'
           AND runtime_error_code = 'session_failed'
           AND observed_state <> 'terminated'
           AND resources_deleted_at IS NULL
         RETURNING session_id`,
        [sessionId],
      );
      if (!cleaned.rowCount) {
        throw new HttpError(
          409,
          "session_cleanup_conflict",
          "The failed Session cleanup owner changed before commit.",
        );
      }
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
             terminal_session_id = NULL, provisioning_error = NULL,
             resources_deleted_at = NOW()
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

  /**
   * Serialize a browser Workspace write with Turn/history mutations across all
   * Sandpi server replicas. The transaction lock intentionally spans the short
   * Sandbox0 file write; PostgreSQL releases it if this server disconnects.
   */
  async withWorkspaceFileWrite<T>(
    userId: string,
    sessionId: string,
    write: (runtime: StoredRuntime) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const result = await client.query<RuntimeRow & { session_status: string }>(
        `SELECT r.*, s.status AS session_status
         FROM session_runtime r
         JOIN sessions s ON s.id = r.session_id
         JOIN team_memberships m
           ON m.team_id = s.team_id
          AND m.user_id = $1
          AND m.status = 'active'
         WHERE s.created_by_user_id = $1 AND s.id = $2
           AND s.hard_expires_at > NOW()`,
        [userId, sessionId],
      );
      const row = result.rows[0];
      if (!row) throw notFound("session_not_found", "Session not found.");
      if (row.session_status !== "waiting") {
        throw new HttpError(
          409,
          "workspace_write_not_ready",
          "Wait for the current coding-agent Turn to finish before saving Workspace files.",
        );
      }
      if (row.exclusive_operation_id) {
        throw new HttpError(
          409,
          "workspace_write_not_ready",
          "Wait for the current Session operation to finish before saving Workspace files.",
        );
      }
      if (!row.sandbox_id || !row.supervisor_session_id || !row.workspace_volume_id) {
        throw notFound(
          "session_runtime_not_ready",
          "Session runtime is not ready.",
        );
      }
      const value = await write(runtimeFromRow(row));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  /**
   * Durable native-state migrations are resumed before ordinary event workers.
   * Sandpi deploys one backend server, so the service coalesces execution while
   * this query supplies the process-restart recovery set.
   */
  async migratingNativeStateRuntimes(): Promise<StoredRuntime[]> {
    const result = await this.pool.query<RuntimeRow>(
      `SELECT runtime.*
       FROM session_runtime runtime
       JOIN sessions session ON session.id = runtime.session_id
       WHERE runtime.harness_state_layout = 'migrating'
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.workspace_volume_id IS NOT NULL
         AND runtime.supervisor_session_id IS NOT NULL
         AND runtime.native_session_id IS NOT NULL
         AND session.status = 'paused'
         AND session.hard_expires_at > NOW()
       ORDER BY runtime.updated_at, runtime.session_id`,
    );
    return result.rows.map(runtimeFromRow);
  }

  /**
   * Repairs the narrow crash window after a Turn checkpoint committed but
   * before the product Session was released back to waiting. A pending input
   * snapshot means a Turn submission is still unresolved and must remain
   * running until ordered native events reconcile it.
   */
  async recoverWaitingSessionsAfterRestart() {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE sessions session
       SET status = 'waiting', updated_at = NOW()
       FROM session_runtime runtime
       WHERE session.id = runtime.session_id
         AND session.status = 'running'
         AND session.hard_expires_at > NOW()
         AND runtime.desired_state = 'running'
         AND runtime.observed_state = 'running'
         AND runtime.provisioning_error IS NULL
         AND runtime.native_session_id IS NOT NULL
         AND runtime.head_volume_snapshot_id IS NOT NULL
         AND runtime.active_native_turn_id IS NULL
         AND runtime.pending_turn_input_snapshot_id IS NULL
         AND runtime.pending_turn_phase IS NULL
         AND runtime.pending_interrupted_native_turn_id IS NULL
         AND runtime.exclusive_operation_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_turn_checkpoints checkpoint
           WHERE checkpoint.session_id = session.id
             AND checkpoint.status IN ('creating', 'failed')
         )
         AND NOT EXISTS (
           SELECT 1 FROM session_turn_mutations mutation
           WHERE mutation.session_id = session.id
         )
       RETURNING session.id`,
    );
    return result.rows.map((row) => row.id);
  }

  /** Caller holds the cross-replica Session operation lock. */
  async beginNativeStateMigration(sessionId: string, operationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const claimed = await client.query<RuntimeRow>(
        `UPDATE session_runtime runtime
         SET harness_state_layout = 'migrating', desired_state = 'paused',
             observed_state = 'provisioning', provisioning_error = NULL,
             runtime_error_code = NULL,
             exclusive_operation_id = $2,
             exclusive_operation_kind = 'native_state_migration',
             exclusive_operation_started_at = NOW(),
             exclusive_operation_heartbeat_at = NOW(),
             version = version + 1,
             updated_at = NOW()
         FROM sessions session
         WHERE runtime.session_id = $1 AND session.id = runtime.session_id
           AND runtime.harness_state_layout IN ('rootfs_v1', 'migrating')
           AND runtime.active_native_turn_id IS NULL
           AND runtime.pending_turn_phase IS NULL
           AND runtime.pending_turn_input_snapshot_id IS NULL
           AND runtime.native_session_id IS NOT NULL
           AND runtime.sandbox_id IS NOT NULL
           AND runtime.workspace_volume_id IS NOT NULL
           AND runtime.supervisor_session_id IS NOT NULL
           AND session.status IN ('waiting', 'paused')
           AND session.hard_expires_at > NOW()
           AND runtime.exclusive_operation_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_mutations mutation
             WHERE mutation.session_id = runtime.session_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_checkpoints checkpoint
             WHERE checkpoint.session_id = runtime.session_id
               AND checkpoint.status = 'creating'
           )
         RETURNING runtime.*`,
        [sessionId, operationId],
      );
      const row = claimed.rows[0];
      if (row) {
        await client.query(
          `UPDATE sessions SET status = 'paused', unread = FALSE
           WHERE id = $1 AND status IN ('waiting', 'paused')`,
          [sessionId],
        );
      }
      await client.query("COMMIT");
      return row ? runtimeFromRow(row) : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setNativeStateMigrationRuntime(
    sessionId: string,
    operationId: string,
    input: {
      nativeSessionId: string;
      workspaceVolumeId: string;
      supervisorSessionId: string;
      attemptId: string;
      runtimeGeneration: number;
    },
  ) {
    const updated = await this.pool.query(
      `UPDATE session_runtime
       SET supervisor_session_id = $4, supervisor_cursor = 0,
           stdout_tail = '', attempt_id = $5, runtime_generation = $6,
           observed_state = 'provisioning',
           provisioning_error = 'Native state migration initialization is pending.',
           runtime_error_code = NULL, version = version + 1,
           updated_at = NOW()
       WHERE session_id = $1 AND harness_state_layout = 'migrating'
         AND native_session_id = $2 AND workspace_volume_id = $3
         AND exclusive_operation_id = $7
       RETURNING session_id`,
      [
        sessionId,
        input.nativeSessionId,
        input.workspaceVolumeId,
        input.supervisorSessionId,
        input.attemptId,
        input.runtimeGeneration,
        operationId,
      ],
    );
    if (!updated.rowCount) {
      throw new HttpError(
        409,
        "native_state_migration_conflict",
        "The Session runtime changed while native state was being migrated.",
      );
    }
  }

  async recordNativeStateMigrationSnapshot(
    sessionId: string,
    operationId: string,
    expectedHistoryRevision: number,
    snapshotId: string,
  ) {
    const recorded = await this.pool.query(
      `UPDATE session_runtime
       SET native_state_migration_snapshot_id = $4,
           version = version + 1, updated_at = NOW()
       WHERE session_id = $1 AND harness_state_layout = 'migrating'
         AND exclusive_operation_id = $2 AND history_revision = $3
         AND (
           native_state_migration_snapshot_id IS NULL
           OR native_state_migration_snapshot_id = $4
         )
       RETURNING session_id`,
      [sessionId, operationId, expectedHistoryRevision, snapshotId],
    );
    if (!recorded.rowCount) {
      throw new HttpError(
        409,
        "native_state_migration_conflict",
        "The Session changed before its migration baseline was recorded.",
      );
    }
  }

  async completeNativeStateMigration(
    sessionId: string,
    operationId: string,
    input: {
      nativeSessionId: string;
      workspaceVolumeId: string;
      expectedHistoryRevision: number;
      headSnapshotId: string;
      nativeHeadTurnId?: string;
    },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const runtime = await client.query<{ session_id: string }>(
        `SELECT session_id FROM session_runtime
         WHERE session_id = $1 AND harness_state_layout = 'migrating'
           AND native_session_id = $2 AND workspace_volume_id = $3
           AND history_revision = $4
           AND exclusive_operation_id = $5
           AND native_state_migration_snapshot_id = $6
         FOR UPDATE`,
        [
          sessionId,
          input.nativeSessionId,
          input.workspaceVolumeId,
          input.expectedHistoryRevision,
          operationId,
          input.headSnapshotId,
        ],
      );
      if (!runtime.rowCount) {
        throw new HttpError(
          409,
          "native_state_migration_conflict",
          "The Session changed before native state migration committed.",
        );
      }
      const invalidated = await client.query<{
        workspace_snapshot_id: string | null;
        input_workspace_snapshot_id: string | null;
      }>(
        `UPDATE session_turn_checkpoints
         SET status = 'deleted'
         WHERE session_id = $1 AND status <> 'deleted'
         RETURNING workspace_snapshot_id, input_workspace_snapshot_id`,
        [sessionId],
      );
      await client.query(
        `INSERT INTO session_turn_checkpoints (
           id, session_id, ordinal, native_session_id, native_turn_id,
           native_head_turn_id, workspace_volume_id, workspace_snapshot_id,
           includes_native_state, status
         ) VALUES ($1, $2, 0, $3, NULL, $4, $5, $6, TRUE, 'ready')`,
        [
          `checkpoint_${randomUUID()}`,
          sessionId,
          input.nativeSessionId,
          input.nativeHeadTurnId ?? null,
          input.workspaceVolumeId,
          input.headSnapshotId,
        ],
      );
      const completed = await client.query(
        `UPDATE session_runtime
         SET harness_state_layout = 'workspace_v2',
             head_volume_snapshot_id = $5,
             native_state_migration_snapshot_id = NULL,
             native_history_materialized =
               native_history_materialized OR $6,
             history_revision = history_revision + 1,
             desired_state = 'running', observed_state = 'running',
             provisioning_error = NULL, runtime_error_code = NULL,
             active_native_turn_id = NULL, active_turn_started_at = NULL,
             active_turn_supervisor_sequence = NULL,
             pending_interrupted_native_turn_id = NULL,
             pending_turn_input_snapshot_id = NULL,
             pending_turn_request_id = NULL,
             pending_turn_client_message_id = NULL,
             pending_turn_stable_input_id = NULL,
             pending_turn_phase = NULL,
             pending_turn_native_turn_id = NULL,
             pending_turn_started_at = NULL,
             pending_turn_submitted_at = NULL,
             version = version + 1, updated_at = NOW()
         WHERE session_id = $1 AND harness_state_layout = 'migrating'
           AND native_session_id = $2 AND workspace_volume_id = $3
           AND history_revision = $4
           AND exclusive_operation_id = $7
           AND native_state_migration_snapshot_id = $5
         RETURNING session_id`,
        [
          sessionId,
          input.nativeSessionId,
          input.workspaceVolumeId,
          input.expectedHistoryRevision,
          input.headSnapshotId,
          Boolean(input.nativeHeadTurnId),
          operationId,
        ],
      );
      if (!completed.rowCount) {
        throw new HttpError(
          409,
          "native_state_migration_conflict",
          "The Session changed while native state migration committed.",
        );
      }
      await client.query(
        `UPDATE sessions SET status = 'waiting', unread = FALSE
         WHERE id = $1 AND status = 'paused'`,
        [sessionId],
      );
      await client.query("COMMIT");
      return [
        ...new Set(
          invalidated.rows
            .flatMap((row) => [
              row.workspace_snapshot_id,
              row.input_workspace_snapshot_id,
            ])
            .filter(
              (snapshotId): snapshotId is string =>
                Boolean(snapshotId) && snapshotId !== input.headSnapshotId,
            ),
        ),
      ];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failNativeStateMigration(
    sessionId: string,
    operationId: string,
    error: string,
  ) {
    await this.pool.query(
      `UPDATE session_runtime
       SET observed_state = 'failed', provisioning_error = $2,
           runtime_error_code = 'native_state_migration_failed',
           desired_state = 'paused', version = version + 1,
           updated_at = NOW()
       WHERE session_id = $1 AND harness_state_layout = 'migrating'
         AND exclusive_operation_id = $3`,
      [sessionId, error, operationId],
    );
  }

  /**
   * Delays post-restore takeover beyond the maximum Sandbox pause/restore/
   * resume window. A prepared mutation has made no external change and can be
   * released immediately.
   * If a PostgreSQL session lock is lost while the old process is still inside
   * Sandbox0, a new replica must not concurrently restore the opposite Volume
   * snapshot. Normal owners keep the advisory lock, so the grace only affects
   * crash/fence-loss recovery.
   */
  async interruptedTurnMutations(): Promise<InterruptedTurnMutation[]> {
    const result = await this.pool.query<
      RuntimeRow & {
        mutation_id: string;
        head_snapshot_id: string;
        original_native_session_id: string;
        result_native_session_id: string | null;
        mutation_workspace_volume_id: string;
        expected_history_revision: string | number;
        mutation_phase: TurnMutationPhase;
      }
    >(
      `SELECT r.*, mutation.id AS mutation_id,
              mutation.head_workspace_snapshot_id AS head_snapshot_id,
              mutation.original_native_session_id,
              mutation.workspace_volume_id AS mutation_workspace_volume_id,
              mutation.expected_history_revision,
              mutation.phase AS mutation_phase
       FROM sessions s
       JOIN session_runtime r ON r.session_id = s.id
       JOIN session_turn_mutations mutation ON mutation.session_id = s.id
       WHERE s.status = 'paused' AND s.hard_expires_at > NOW()
         AND r.sandbox_id IS NOT NULL AND r.workspace_volume_id IS NOT NULL
         AND r.supervisor_session_id IS NOT NULL
         AND mutation.phase <> 'failed'
         AND (
           mutation.phase = 'prepared'
           OR mutation.updated_at < NOW() - INTERVAL '10 minutes'
         )
         AND mutation.workspace_volume_id = r.workspace_volume_id`,
    );
    return result.rows
      .filter((row) =>
        Boolean(row.original_native_session_id && row.head_snapshot_id),
      )
      .map((row) => ({
        mutationId: row.mutation_id,
        runtime: runtimeFromRow(row),
        headSnapshotId: row.head_snapshot_id,
        originalNativeSessionId: row.original_native_session_id,
        workspaceVolumeId: row.mutation_workspace_volume_id,
        expectedHistoryRevision: Number(row.expected_history_revision),
        phase: row.mutation_phase,
      }));
  }

  /** Returns the active native Codex Turn from explicit control state. */
  async activeCodexTurn(sessionId: string) {
    const result = await this.pool.query<{
      native_session_id: string | null;
      active_native_turn_id: string | null;
    }>(
      `SELECT runtime.native_session_id, runtime.active_native_turn_id
       FROM session_runtime runtime
       JOIN sessions session ON session.id = runtime.session_id
       WHERE runtime.session_id = $1 AND session.status = 'running'`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row?.native_session_id || !row.active_native_turn_id) return undefined;
    return {
      nativeSessionId: row.native_session_id,
      turnId: row.active_native_turn_id,
    };
  }

  async beginSessionTurn(
    userId: string,
    sessionId: string,
    modelId: string | undefined,
    submission: TurnSubmissionCoordinates,
  ) {
    const client = await this.pool.connect();
    let started = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const result = await client.query(
         `WITH writable AS (
           UPDATE sessions s
           SET status = 'running', unread = FALSE
           FROM team_memberships m, session_runtime current_runtime
           WHERE s.id = $2
             AND s.created_by_user_id = $1
             AND m.team_id = s.team_id
             AND m.user_id = $1
             AND m.status = 'active'
             AND current_runtime.session_id = s.id
             AND current_runtime.active_native_turn_id IS NULL
             AND current_runtime.runtime_error_code IS NULL
             AND current_runtime.desired_state = 'running'
             AND current_runtime.observed_state = 'running'
             AND current_runtime.provisioning_error IS NULL
             AND current_runtime.pending_interrupted_native_turn_id IS NULL
             AND current_runtime.pending_turn_phase IS NULL
             AND current_runtime.pending_turn_input_snapshot_id IS NULL
             AND current_runtime.exclusive_operation_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM session_turn_mutations mutation
               WHERE mutation.session_id = s.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM session_turn_checkpoints checkpoint
               WHERE checkpoint.session_id = s.id
                 AND checkpoint.native_turn_id IS NOT NULL
                 AND checkpoint.status IN ('creating', 'failed')
             )
             AND s.status = 'waiting'
             AND s.hard_expires_at > NOW()
           RETURNING s.id
         ), runtime_updated AS (
           UPDATE session_runtime r
           SET model_id = COALESCE($3::TEXT, r.model_id),
               pending_turn_request_id = $4,
               pending_turn_client_message_id = $5,
               pending_turn_stable_input_id = $6,
               pending_turn_phase = 'prepared',
               pending_turn_native_turn_id = NULL,
               pending_turn_started_at = NOW(),
               pending_turn_submitted_at = NULL,
               version = r.version + 1, updated_at = NOW()
           FROM writable w
           WHERE r.session_id = w.id
           RETURNING r.session_id
         )
         SELECT id FROM writable`,
        [
          userId,
          sessionId,
          modelId ?? null,
          submission.requestId,
          submission.clientMessageId,
          submission.stableInputId,
        ],
      );
      started = Boolean(result.rowCount);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (started) return;
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

  async recordPendingTurnInputSnapshot(sessionId: string, snapshotId: string) {
    const recorded = await this.pool.query(
      `UPDATE session_runtime r
       SET pending_turn_input_snapshot_id = $2, updated_at = NOW()
       FROM sessions s
       WHERE r.session_id = $1 AND s.id = r.session_id
         AND s.status IN ('running', 'paused')
         AND r.pending_turn_input_snapshot_id IS NULL
       RETURNING r.session_id`,
      [sessionId, snapshotId],
    );
    if (!recorded.rowCount) {
      throw new HttpError(
        409,
        "turn_input_checkpoint_conflict",
        "The Session already has an active Turn input checkpoint.",
      );
    }
  }

  async recordTurnSubmissionInputSnapshot(
    sessionId: string,
    requestId: string,
    snapshotId: string,
  ) {
    const recorded = await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_input_snapshot_id = $3,
           pending_turn_phase = 'snapshot_ready',
           version = version + 1,
           updated_at = NOW()
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase = 'prepared'
         AND pending_turn_input_snapshot_id IS NULL
       RETURNING session_id`,
      [sessionId, requestId, snapshotId],
    );
    if (!recorded.rowCount) {
      throw new HttpError(
        409,
        "turn_submission_conflict",
        "The native Turn input checkpoint changed before submission.",
      );
    }
  }

  async markTurnSubmissionDispatched(sessionId: string, requestId: string) {
    const marked = await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = CASE
             WHEN pending_turn_phase = 'staged' THEN 'submitted'
             ELSE pending_turn_phase
           END,
           pending_turn_submitted_at = COALESCE(pending_turn_submitted_at, NOW()),
           version = version + 1,
           updated_at = NOW()
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase IN ('staged', 'submitted', 'accepted')
       RETURNING session_id`,
      [sessionId, requestId],
    );
    if (!marked.rowCount) {
      throw new HttpError(
        409,
        "turn_submission_conflict",
        "The native Turn changed before its RPC frame was dispatched.",
      );
    }
  }

  async markTurnSubmissionStaged(sessionId: string, requestId: string) {
    const marked = await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = CASE
             WHEN pending_turn_phase = 'snapshot_ready' THEN 'staged'
             ELSE pending_turn_phase
           END,
           version = version + 1,
           updated_at = NOW()
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase IN (
           'snapshot_ready', 'staged', 'submitted', 'accepted'
         )
       RETURNING session_id`,
      [sessionId, requestId],
    );
    if (!marked.rowCount) {
      throw new HttpError(
        409,
        "turn_submission_conflict",
        "The native Turn delivery outbox changed before submission.",
      );
    }
  }

  async markTurnSubmissionAccepted(
    sessionId: string,
    requestId: string,
    nativeTurnId: string,
  ) {
    const marked = await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = 'accepted',
           pending_turn_native_turn_id = $3,
           pending_turn_submitted_at = COALESCE(pending_turn_submitted_at, NOW()),
           version = version + 1,
           updated_at = NOW()
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase IN ('staged', 'submitted', 'accepted')
         AND (pending_turn_native_turn_id IS NULL
              OR pending_turn_native_turn_id = $3)
       RETURNING session_id`,
      [sessionId, requestId, nativeTurnId],
    );
    return Boolean(marked.rowCount);
  }

  async pendingTurnSubmissions(): Promise<StoredRuntime[]> {
    const result = await this.pool.query<RuntimeRow>(
      `SELECT runtime.*
       FROM session_runtime runtime
       JOIN sessions session ON session.id = runtime.session_id
       WHERE runtime.pending_turn_phase IS NOT NULL
         AND runtime.pending_turn_request_id IS NOT NULL
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.workspace_volume_id IS NOT NULL
         AND runtime.supervisor_session_id IS NOT NULL
         AND session.status = 'running'
         AND session.hard_expires_at > NOW()
         AND NOT EXISTS (
           SELECT 1 FROM session_turn_checkpoints checkpoint
           WHERE checkpoint.session_id = runtime.session_id
             AND checkpoint.status IN ('creating', 'failed')
         )
       ORDER BY runtime.pending_turn_started_at`,
    );
    return result.rows.map(runtimeFromRow);
  }

  /**
   * Abandons a delivery that native state proves was never accepted. Returns
   * whether its input snapshot is unreferenced and can be deleted externally.
   */
  async abandonTurnSubmission(
    sessionId: string,
    requestId: string,
    expected?: {
      version: number;
      supervisorSessionId: string;
      supervisorCursor: number;
      attemptId?: string;
      runtimeGeneration: number;
    },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const selected = await client.query<{
        snapshot_id: string | null;
        delete_snapshot: boolean;
      }>(
        `SELECT runtime.pending_turn_input_snapshot_id AS snapshot_id,
                runtime.pending_turn_input_snapshot_id IS NOT NULL
                AND runtime.pending_turn_input_snapshot_id IS DISTINCT FROM
                    runtime.head_volume_snapshot_id
                AND NOT EXISTS (
                  SELECT 1 FROM session_turn_checkpoints checkpoint
                  WHERE checkpoint.session_id = runtime.session_id
                    AND checkpoint.status <> 'deleted'
                    AND runtime.pending_turn_input_snapshot_id IN (
                      checkpoint.workspace_snapshot_id,
                      checkpoint.input_workspace_snapshot_id
                    )
                ) AS delete_snapshot
         FROM session_runtime runtime
         WHERE runtime.session_id = $1
           AND runtime.pending_turn_request_id = $2
           AND runtime.active_native_turn_id IS NULL
           AND (
             $3::BIGINT IS NULL
             OR (
               runtime.version = $3
               AND runtime.supervisor_session_id = $4
               AND runtime.supervisor_cursor = $5
               AND runtime.attempt_id IS NOT DISTINCT FROM $6::TEXT
               AND runtime.runtime_generation = $7
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_checkpoints checkpoint
             WHERE checkpoint.session_id = runtime.session_id
               AND checkpoint.status IN ('creating', 'failed')
           )
         FOR UPDATE`,
        [
          sessionId,
          requestId,
          expected?.version ?? null,
          expected?.supervisorSessionId ?? null,
          expected?.supervisorCursor ?? null,
          expected?.attemptId ?? null,
          expected?.runtimeGeneration ?? null,
        ],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        `UPDATE session_runtime
         SET pending_turn_input_snapshot_id = NULL,
             pending_turn_request_id = NULL,
             pending_turn_client_message_id = NULL,
             pending_turn_stable_input_id = NULL,
             pending_turn_phase = NULL,
             pending_turn_native_turn_id = NULL,
             pending_turn_started_at = NULL,
             pending_turn_submitted_at = NULL,
             active_native_turn_id = NULL,
             active_turn_started_at = NULL,
             active_turn_supervisor_sequence = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE session_id = $1 AND pending_turn_request_id = $2`,
        [sessionId, requestId],
      );
      await client.query(
        `UPDATE sessions SET status = 'waiting', unread = FALSE
         WHERE id = $1 AND status = 'running' AND hard_expires_at > NOW()
           AND NOT EXISTS (
             SELECT 1 FROM session_runtime runtime
             WHERE runtime.session_id = sessions.id
               AND runtime.exclusive_operation_id IS NOT NULL
           )`,
        [sessionId],
      );
      await client.query("COMMIT");
      return {
        snapshotId: row.snapshot_id ?? undefined,
        deleteSnapshot: row.delete_snapshot,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async clearPendingTurnInputSnapshot(sessionId: string, snapshotId: string) {
    await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_input_snapshot_id = NULL, updated_at = NOW()
       WHERE session_id = $1 AND pending_turn_input_snapshot_id = $2`,
      [sessionId, snapshotId],
    );
  }

  async headVolumeSnapshotId(sessionId: string) {
    const result = await this.pool.query<{ head_volume_snapshot_id: string | null }>(
      `SELECT head_volume_snapshot_id
       FROM session_runtime WHERE session_id = $1`,
      [sessionId],
    );
    return result.rows[0]?.head_volume_snapshot_id ?? undefined;
  }

  async reserveSessionFork(userId: string, sessionId: string) {
    const client = await this.pool.connect();
    const operationId = `operation_${randomUUID()}`;
    let ready = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const reserved = await client.query(
        `UPDATE session_runtime runtime
         SET exclusive_operation_id = $3,
             exclusive_operation_kind = 'session_fork',
             exclusive_operation_started_at = NOW(),
             exclusive_operation_heartbeat_at = NOW(),
             version = version + 1,
             updated_at = NOW()
         FROM sessions session
         WHERE runtime.session_id = $1
           AND session.id = runtime.session_id
           AND session.created_by_user_id = $2
           AND session.status = 'waiting'
           AND session.hard_expires_at > NOW()
           AND runtime.exclusive_operation_id IS NULL
           AND runtime.active_native_turn_id IS NULL
           AND runtime.pending_turn_phase IS NULL
           AND runtime.pending_turn_input_snapshot_id IS NULL
           AND runtime.pending_interrupted_native_turn_id IS NULL
           AND runtime.desired_state = 'running'
           AND runtime.observed_state = 'running'
           AND runtime.provisioning_error IS NULL
           AND runtime.runtime_error_code IS NULL
           AND runtime.native_session_id IS NOT NULL
           AND runtime.head_volume_snapshot_id IS NOT NULL
           AND runtime.harness_state_layout = 'workspace_v2'
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_mutations mutation
             WHERE mutation.session_id = runtime.session_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_checkpoints checkpoint
             WHERE checkpoint.session_id = runtime.session_id
               AND checkpoint.native_turn_id IS NOT NULL
               AND checkpoint.status IN ('creating', 'failed')
           )
         RETURNING runtime.session_id`,
        [sessionId, userId, operationId],
      );
      ready = Boolean(reserved.rowCount);
      if (ready) {
        const locked = await client.query(
          `UPDATE sessions SET status = 'running', unread = FALSE
           WHERE id = $1 AND status = 'waiting'
           RETURNING id`,
          [sessionId],
        );
        if (!locked.rowCount) {
          throw new HttpError(
            409,
            "session_fork_conflict",
            "The Session changed while the fork was starting.",
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (ready) return operationId;
    await this.getSession(userId, sessionId);
    throw new HttpError(
      409,
      "session_fork_conflict",
      "The Session changed while the fork was starting.",
    );
  }

  /** Caller holds the cross-replica Session operation lock. */
  async reserveRuntimeRecovery(
    sessionId: string,
    expectedSupervisorSessionId?: string,
  ) {
    const client = await this.pool.connect();
    const operationId = `operation_${randomUUID()}`;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const reserved = await client.query(
        `UPDATE session_runtime runtime
         SET exclusive_operation_id = $3,
             exclusive_operation_kind = 'runtime_recovery',
             exclusive_operation_started_at = NOW(),
             exclusive_operation_heartbeat_at = NOW(),
             version = version + 1,
             updated_at = NOW()
         FROM sessions session
         WHERE runtime.session_id = $1
           AND session.id = runtime.session_id
           AND session.status IN ('running', 'waiting')
           AND session.hard_expires_at > NOW()
           AND runtime.exclusive_operation_id IS NULL
           AND runtime.desired_state = 'running'
           AND runtime.sandbox_id IS NOT NULL
           AND runtime.workspace_volume_id IS NOT NULL
           AND runtime.supervisor_session_id IS NOT NULL
           AND ($2::TEXT IS NULL OR runtime.supervisor_session_id = $2)
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_mutations mutation
             WHERE mutation.session_id = runtime.session_id
           )
         RETURNING runtime.session_id`,
        [sessionId, expectedSupervisorSessionId ?? null, operationId],
      );
      if (!reserved.rowCount) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        `UPDATE sessions SET status = 'running', unread = FALSE
         WHERE id = $1 AND status IN ('running', 'waiting')`,
        [sessionId],
      );
      await client.query("COMMIT");
      return operationId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Refreshes the takeover grace immediately before a fenced external call. */
  async touchSessionOperation(sessionId: string, operationId: string) {
    const touched = await this.pool.query(
      `UPDATE session_runtime
       SET exclusive_operation_heartbeat_at = NOW(), updated_at = NOW()
       WHERE session_id = $1 AND exclusive_operation_id = $2
       RETURNING session_id`,
      [sessionId, operationId],
    );
    return Boolean(touched.rowCount);
  }

  /**
   * Fences the full external fork with a PostgreSQL session advisory lock.
   * The lock is released automatically if the owning server connection dies.
   */
  async acquireSessionOperationLock(
    sessionId: string,
  ): Promise<SessionOperationLock | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtext('sandpi-session-operation'), hashtext($1)
         ) AS acquired`,
        [sessionId],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return undefined;
      }
      const controller = new AbortController();
      const onError = (error: Error) => controller.abort(error);
      client.on("error", onError);
      let released = false;
      return {
        signal: controller.signal,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query(
              `SELECT pg_advisory_unlock(
                 hashtext('sandpi-session-operation'), hashtext($1)
               )`,
              [sessionId],
            );
          } finally {
            client.removeListener("error", onError);
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /**
   * Releases only the owner that reserved the source Session. A late `finally`
   * from an older request can therefore never unlock a newer operation.
   */
  async releaseSessionOperation(sessionId: string, operationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const released = await client.query(
        `UPDATE session_runtime
         SET exclusive_operation_id = NULL,
             exclusive_operation_kind = NULL,
             exclusive_operation_started_at = NULL,
             exclusive_operation_heartbeat_at = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE session_id = $1 AND exclusive_operation_id = $2
         RETURNING session_id`,
        [sessionId, operationId],
      );
      if (!released.rowCount) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE sessions session
         SET status = 'waiting', unread = FALSE, updated_at = NOW()
         FROM session_runtime runtime
         WHERE session.id = $1 AND runtime.session_id = session.id
           AND session.status = 'running'
           AND session.hard_expires_at > NOW()
           AND runtime.exclusive_operation_id IS NULL
           AND runtime.active_native_turn_id IS NULL
           AND runtime.pending_turn_phase IS NULL
           AND runtime.pending_turn_input_snapshot_id IS NULL
           AND runtime.pending_interrupted_native_turn_id IS NULL
           AND runtime.desired_state = 'running'
           AND runtime.observed_state = 'running'
           AND runtime.provisioning_error IS NULL
           AND runtime.runtime_error_code IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_mutations mutation
             WHERE mutation.session_id = session.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_checkpoints checkpoint
             WHERE checkpoint.session_id = session.id
               AND checkpoint.native_turn_id IS NOT NULL
               AND checkpoint.status IN ('creating', 'failed')
           )`,
        [sessionId],
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

  /**
   * Clears durable owners only after acquiring their fencing lock. A live
   * owner on any replica keeps the lock. Operations that may still be inside
   * an uninterruptible source-Sandbox call also wait out the takeover grace.
   */
  async recoverStaleSessionOperations(sessionId?: string) {
    const operations = await this.pool.query<{
      session_id: string;
      exclusive_operation_id: string;
    }>(
      `SELECT session_id, exclusive_operation_id
       FROM session_runtime
       WHERE exclusive_operation_id IS NOT NULL
         AND ($1::TEXT IS NULL OR session_id = $1)
         AND (
           exclusive_operation_kind = 'turn_fork'
           OR exclusive_operation_heartbeat_at <
              NOW() - INTERVAL '10 minutes'
         )
       ORDER BY exclusive_operation_heartbeat_at, session_id`,
      [sessionId ?? null],
    );
    const recovered: string[] = [];
    for (const operation of operations.rows) {
      const releaseLock = await this.acquireSessionOperationLock(
        operation.session_id,
      );
      if (!releaseLock) continue;
      try {
        if (
          await this.releaseSessionOperation(
            operation.session_id,
            operation.exclusive_operation_id,
          )
        ) {
          recovered.push(operation.session_id);
        }
      } finally {
        await releaseLock.release();
      }
    }
    return recovered;
  }

  /** Caller must hold `acquireSessionOperationLock(sessionId)`. */
  async clearAbandonedSessionOperation(sessionId: string) {
    const result = await this.pool.query<{ exclusive_operation_id: string }>(
      `SELECT exclusive_operation_id
       FROM session_runtime
       WHERE session_id = $1 AND exclusive_operation_id IS NOT NULL
         AND (
           exclusive_operation_kind = 'turn_fork'
           OR exclusive_operation_heartbeat_at <
              NOW() - INTERVAL '10 minutes'
         )`,
      [sessionId],
    );
    const operationId = result.rows[0]?.exclusive_operation_id;
    if (!operationId) return false;
    return this.releaseSessionOperation(sessionId, operationId);
  }

  async markSessionTurnCompleted(sessionId: string) {
    await this.pool.query(
      `UPDATE sessions
       SET status = 'waiting', unread = TRUE
       WHERE id = $1
         AND status NOT IN ('completed', 'failed')
         AND NOT EXISTS (
           SELECT 1 FROM session_turn_checkpoints checkpoint
           WHERE checkpoint.session_id = sessions.id
             AND checkpoint.native_turn_id IS NOT NULL
             AND checkpoint.status IN ('creating', 'failed')
         )
         AND NOT EXISTS (
           SELECT 1 FROM session_runtime runtime
           WHERE runtime.session_id = sessions.id
             AND (
               runtime.active_native_turn_id IS NOT NULL
               OR runtime.pending_turn_phase IS NOT NULL
               OR runtime.exclusive_operation_id IS NOT NULL
               OR runtime.pending_interrupted_native_turn_id IS NOT NULL
               OR runtime.desired_state <> 'running'
               OR runtime.observed_state <> 'running'
               OR runtime.provisioning_error IS NOT NULL
               OR runtime.runtime_error_code IS NOT NULL
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM session_turn_mutations mutation
           WHERE mutation.session_id = sessions.id
         )
         AND hard_expires_at > NOW()`,
      [sessionId],
    );
  }

  /**
   * Linearizes terminal open/input with fork reservation. Input callbacks only
   * queue parsed frames; open may await Supervisor terminal creation while the
   * short source-Session transaction lock excludes a concurrent reservation.
   */
  async withTerminalAccess<T>(
    userId: string,
    sessionId: string,
    send: () => Promise<T> | T,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const result = await client.query<{
        status: string;
        exclusive_operation_id: string | null;
      }>(
        `SELECT session.status, runtime.exclusive_operation_id
         FROM sessions session
         JOIN session_runtime runtime ON runtime.session_id = session.id
         JOIN team_memberships membership
           ON membership.team_id = session.team_id
          AND membership.user_id = $1
          AND membership.status = 'active'
         WHERE session.id = $2 AND session.created_by_user_id = $1
           AND session.hard_expires_at > NOW()
         FOR UPDATE OF runtime`,
        [userId, sessionId],
      );
      const row = result.rows[0];
      if (!row) throw notFound("session_not_found", "Session not found.");
      if (
        (row.status !== "waiting" && row.status !== "running") ||
        row.exclusive_operation_id
      ) {
        throw new HttpError(
          409,
          "terminal_session_locked",
          "Terminal input is paused while Sandpi changes Session history.",
        );
      }
      const value = await send();
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically advances the disposable Supervisor decoder and the small set of
   * native control coordinates Sandpi needs for recovery. Native messages,
   * tool calls, deltas, and JSON-RPC responses are deliberately not persisted.
   */
  async commitCodexTransport(
    sessionId: string,
    supervisorSessionId: string,
    expected: CodexDecoderState,
    state: CodexDecoderState,
    transitions: readonly CodexControlTransition[],
    options: { transportOnly?: boolean } = {},
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const runtimeResult = await client.query<{
        supervisor_session_id: string | null;
        supervisor_cursor: string | number;
        stdout_tail: string;
        attempt_id: string | null;
        runtime_generation: string | number;
        native_session_id: string | null;
        active_native_turn_id: string | null;
      }>(
        `SELECT supervisor_session_id, supervisor_cursor, stdout_tail,
                attempt_id, runtime_generation, native_session_id,
                active_native_turn_id
         FROM session_runtime WHERE session_id = $1 FOR UPDATE`,
        [sessionId],
      );
      const persisted = runtimeResult.rows[0];
      if (
        persisted?.supervisor_session_id !== supervisorSessionId ||
        Number(persisted.supervisor_cursor) !== expected.supervisorCursor ||
        persisted.stdout_tail !== expected.tailBase64 ||
        (persisted.attempt_id ?? undefined) !== expected.attemptId ||
        Number(persisted.runtime_generation) !== expected.runtimeGeneration
      ) {
        await client.query("COMMIT");
        return false;
      }

      const mutation = await client.query<{
        id: string;
        kind: "edit" | "delete" | "recovery";
        phase: TurnMutationPhase;
        result_native_session_id: string | null;
        replacement_native_turn_id: string | null;
      }>(
        `SELECT id, kind, phase, result_native_session_id,
                replacement_native_turn_id
         FROM session_turn_mutations
         WHERE session_id = $1 FOR UPDATE`,
        [sessionId],
      );
      // A same-native-Session edit reuses the canonical thread id, so identity
      // cannot distinguish candidate events. The decoder may advance while a
      // mutation is journaled, but no control transition becomes authoritative
      // until finalizeTurnMutation commits the restored history.
      const authoritativeTransitions = options.transportOnly ? [] : transitions;
      const canonicalTransitions =
        mutation.rows.length > 0 ? [] : authoritativeTransitions;

      const pendingMutation = mutation.rows[0];
      if (
        pendingMutation?.kind === "edit" &&
        pendingMutation.result_native_session_id &&
        ["restored", "replacement_started"].includes(pendingMutation.phase)
      ) {
        let candidateStarted:
          | Extract<CodexControlTransition, { type: "turnStarted" }>
          | undefined;
        let candidateCompleted:
          | Extract<CodexControlTransition, { type: "turnCompleted" }>
          | undefined;
        for (const transition of authoritativeTransitions) {
          if (
            transition.nativeSessionId !==
            pendingMutation.result_native_session_id
          ) {
            continue;
          }
          if (transition.type === "turnStarted") candidateStarted = transition;
          if (transition.type === "turnCompleted") candidateCompleted = transition;
        }
        const candidateTurnId =
          candidateCompleted?.nativeTurnId ?? candidateStarted?.nativeTurnId;
        if (candidateTurnId) {
          const recorded = await client.query(
            `UPDATE session_turn_mutations
             SET replacement_native_turn_id = COALESCE(
                   replacement_native_turn_id, $3
                 ),
                 candidate_terminal_status = COALESCE($4, candidate_terminal_status),
                 candidate_supervisor_session_id = CASE
                   WHEN $4::TEXT IS NULL THEN candidate_supervisor_session_id
                   ELSE $5
                 END,
                 candidate_supervisor_sequence = CASE
                   WHEN $4::TEXT IS NULL THEN candidate_supervisor_sequence
                   ELSE $6
                 END
             WHERE id = $1 AND session_id = $2
               AND (replacement_native_turn_id IS NULL
                    OR replacement_native_turn_id = $3)
             RETURNING id`,
            [
              pendingMutation.id,
              sessionId,
              candidateTurnId,
              candidateCompleted?.status ?? null,
              candidateCompleted ? supervisorSessionId : null,
              candidateCompleted?.supervisorSequence ?? null,
            ],
          );
          if (!recorded.rowCount) {
            throw new HttpError(
              409,
              "turn_mutation_candidate_conflict",
              "The replacement Codex Turn changed during history restore.",
            );
          }
        }
      }

      const processEpochChanged = Boolean(
        !options.transportOnly &&
          persisted.attempt_id &&
          state.attemptId &&
          (persisted.attempt_id !== state.attemptId ||
            Number(persisted.runtime_generation) !== state.runtimeGeneration),
      );
      let nativeSessionId: string | undefined;
      let started:
        | Extract<CodexControlTransition, { type: "turnStarted" }>
        | undefined;
      let completed:
        | Extract<CodexControlTransition, { type: "turnCompleted" }>
        | undefined;
      for (const transition of canonicalTransitions) {
        if (transition.type === "nativeSession") {
          nativeSessionId = transition.nativeSessionId;
        } else if (transition.type === "turnStarted") {
          started = transition;
          completed = undefined;
        } else {
          completed = transition;
          if (started?.nativeTurnId === transition.nativeTurnId) started = undefined;
        }
      }

      const interruptedTurnId = processEpochChanged
        ? completed?.nativeTurnId === persisted.active_native_turn_id
          ? undefined
          : persisted.active_native_turn_id
        : undefined;
      for (const transition of canonicalTransitions) {
        if (transition.type !== "turnCompleted") continue;
        // Create a durable capture obligation in the same transaction that
        // advances the Supervisor cursor. A crash after this commit can retry
        // the Workspace snapshot without retaining the native event payload.
        await client.query(
          `INSERT INTO session_turn_checkpoints (
             id, session_id, ordinal, native_session_id, native_turn_id,
             native_head_turn_id, workspace_volume_id, terminal_status,
             seal_kind, sealed_supervisor_session_id,
             sealed_supervisor_sequence, includes_native_state, status, error
           )
           SELECT $1, $2,
                  COALESCE(MAX(ordinal), 0) + 1,
                  $3, $4, $4,
                  (SELECT workspace_volume_id FROM session_runtime
                   WHERE session_id = $2),
                  $5, 'native_event', $6, $7,
                  (SELECT harness_state_layout = 'workspace_v2'
                   FROM session_runtime WHERE session_id = $2),
                  'failed',
                  'Workspace checkpoint capture is pending.'
           FROM session_turn_checkpoints
           WHERE session_id = $2 AND status = 'ready'
           ON CONFLICT (session_id, native_turn_id)
             WHERE native_turn_id IS NOT NULL
           DO NOTHING`,
          [
            `checkpoint_${randomUUID()}`,
            sessionId,
            transition.nativeSessionId,
            transition.nativeTurnId,
            transition.status,
            supervisorSessionId,
            transition.supervisorSequence,
          ],
        );
      }
      await client.query(
        `UPDATE session_runtime
         SET supervisor_cursor = $2,
             stdout_tail = $3,
             attempt_id = $4,
             runtime_generation = $5,
             native_session_id = COALESCE($6, native_session_id),
             native_history_materialized =
               native_history_materialized OR $7::TEXT IS NOT NULL,
             active_native_turn_id = CASE
               WHEN $7::TEXT IS NOT NULL THEN $7
               WHEN $8::TEXT IS NOT NULL AND active_native_turn_id = $8 THEN NULL
               ELSE active_native_turn_id
             END,
             active_turn_started_at = CASE
               WHEN $7::TEXT IS NOT NULL THEN $9
               WHEN $8::TEXT IS NOT NULL AND active_native_turn_id = $8 THEN NULL
               ELSE active_turn_started_at
             END,
             active_turn_supervisor_sequence = CASE
               WHEN $7::TEXT IS NOT NULL THEN $10
               WHEN $8::TEXT IS NOT NULL AND active_native_turn_id = $8 THEN NULL
               ELSE active_turn_supervisor_sequence
             END,
             pending_turn_phase = CASE
               WHEN $7::TEXT IS NOT NULL
                 AND pending_turn_phase IN ('staged', 'submitted', 'accepted')
                 THEN 'accepted'
               ELSE pending_turn_phase
             END,
             pending_turn_native_turn_id = CASE
               WHEN $7::TEXT IS NOT NULL
                 AND pending_turn_phase IN ('staged', 'submitted', 'accepted')
                 THEN $7
               ELSE pending_turn_native_turn_id
             END,
             pending_turn_submitted_at = CASE
               WHEN $7::TEXT IS NOT NULL
                 AND pending_turn_phase IN ('staged', 'submitted', 'accepted')
                 THEN COALESCE(pending_turn_submitted_at, NOW())
               ELSE pending_turn_submitted_at
             END,
             pending_interrupted_native_turn_id = COALESCE(
               pending_interrupted_native_turn_id, $11
             ),
             observed_state = CASE
               WHEN $12 THEN 'provisioning' ELSE observed_state
             END,
             provisioning_error = CASE
               WHEN $12
                 THEN 'Codex process attempt changed; initialization is pending.'
               ELSE provisioning_error
             END,
             last_event_at = NOW(),
             version = version + 1
         WHERE session_id = $1`,
        [
          sessionId,
          state.supervisorCursor,
          state.tailBase64,
          state.attemptId ?? null,
          state.runtimeGeneration,
          nativeSessionId ?? null,
          started?.nativeTurnId ?? null,
          completed?.nativeTurnId ?? null,
          started?.startedAt ?? null,
          started?.supervisorSequence ?? null,
          interruptedTurnId ?? null,
          processEpochChanged,
        ],
      );
      if (started) {
        await client.query(
          `UPDATE sessions
           SET status = 'running', unread = FALSE, updated_at = NOW()
           WHERE id = $1 AND status NOT IN ('completed', 'failed')`,
          [sessionId],
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Moves the decoder to the first retained Supervisor record without
   * pretending the missing interval was observed. A native snapshot must
   * explicitly reconcile control state before the gap marker is cleared.
   */
  async markSupervisorJournalGap(
    sessionId: string,
    expected: StoredRuntime,
    earliestRetainedSequence: number,
  ) {
    const updated = await this.pool.query(
      `UPDATE session_runtime
       SET supervisor_cursor = $3,
           stdout_tail = '',
           runtime_error_code = 'supervisor_journal_gap',
           version = version + 1,
           updated_at = NOW()
       WHERE session_id = $1
         AND supervisor_session_id = $2
         AND supervisor_cursor = $4
         AND attempt_id IS NOT DISTINCT FROM $5::TEXT
         AND runtime_generation = $6
       RETURNING session_id`,
      [
        sessionId,
        expected.supervisorSessionId,
        Math.max(earliestRetainedSequence - 1, 0),
        expected.decoder.supervisorCursor,
        expected.decoder.attemptId ?? null,
        expected.decoder.runtimeGeneration,
      ],
    );
    return Boolean(updated.rowCount);
  }

  async reconcileSupervisorJournalGap(
    sessionId: string,
    input: {
      nativeSessionId: string;
      expectedHistoryRevision: number;
      expectedVersion: number;
      expectedSupervisorSessionId: string;
      expectedSupervisorCursor: number;
      expectedAttemptId?: string;
      expectedRuntimeGeneration: number;
      activeNativeTurnId?: string;
      nativeHistoryMaterialized: boolean;
    },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const updated = await client.query(
        `UPDATE session_runtime runtime
         SET active_native_turn_id = $4,
             active_turn_started_at = CASE
               WHEN $4::TEXT IS NULL THEN NULL
               ELSE COALESCE(active_turn_started_at, NOW())
             END,
             active_turn_supervisor_sequence = CASE
               WHEN $4::TEXT IS NULL THEN NULL
               ELSE active_turn_supervisor_sequence
             END,
             native_history_materialized =
               native_history_materialized OR $10,
             runtime_error_code = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE runtime.session_id = $1
           AND runtime.native_session_id = $2
           AND runtime.history_revision = $3
           AND runtime.version = $5
           AND runtime.supervisor_session_id = $6
           AND runtime.supervisor_cursor = $7
           AND runtime.attempt_id IS NOT DISTINCT FROM $8::TEXT
           AND runtime.runtime_generation = $9
           AND runtime.runtime_error_code = 'supervisor_journal_gap'
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_mutations mutation
             WHERE mutation.session_id = runtime.session_id
           )
         RETURNING runtime.session_id`,
        [
          sessionId,
          input.nativeSessionId,
          input.expectedHistoryRevision,
          input.activeNativeTurnId ?? null,
          input.expectedVersion,
          input.expectedSupervisorSessionId,
          input.expectedSupervisorCursor,
          input.expectedAttemptId ?? null,
          input.expectedRuntimeGeneration,
          input.nativeHistoryMaterialized,
        ],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE sessions session
         SET status = CASE
           WHEN $2::TEXT IS NOT NULL THEN 'running'
           WHEN EXISTS (
             SELECT 1 FROM session_runtime runtime
             WHERE runtime.session_id = session.id
               AND (
                 runtime.pending_turn_phase IS NOT NULL
                 OR runtime.exclusive_operation_id IS NOT NULL
               )
           ) THEN 'running'
           WHEN EXISTS (
             SELECT 1 FROM session_turn_checkpoints checkpoint
             WHERE checkpoint.session_id = session.id
               AND checkpoint.native_turn_id IS NOT NULL
               AND checkpoint.status IN ('creating', 'failed')
           ) THEN 'running'
           ELSE 'waiting'
         END
         WHERE session.id = $1
           AND session.status NOT IN ('completed', 'failed', 'paused')`,
        [sessionId, input.activeNativeTurnId ?? null],
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

  /** Returns Turns whose output snapshot can seed a child Session Volume. */
  async forkableCheckpointTurnIds(sessionId: string) {
    const result = await this.pool.query<{ native_turn_id: string }>(
      `SELECT checkpoint.native_turn_id
       FROM session_turn_checkpoints checkpoint
       JOIN session_runtime runtime ON runtime.session_id = checkpoint.session_id
       WHERE checkpoint.session_id = $1 AND checkpoint.status = 'ready'
         AND checkpoint.native_turn_id IS NOT NULL
         AND checkpoint.workspace_snapshot_id IS NOT NULL
         AND checkpoint.includes_native_state
         AND checkpoint.workspace_volume_id = runtime.workspace_volume_id
       ORDER BY checkpoint.ordinal`,
      [sessionId],
    );
    return result.rows.map((row) => row.native_turn_id);
  }

  /** Returns Turns with an exact pre-Turn snapshot safe for edit/delete. */
  async rewindableCheckpointTurnIds(sessionId: string) {
    const result = await this.pool.query<{ native_turn_id: string }>(
      `SELECT checkpoint.native_turn_id
       FROM session_turn_checkpoints checkpoint
       JOIN session_runtime runtime ON runtime.session_id = checkpoint.session_id
       WHERE checkpoint.session_id = $1 AND checkpoint.status = 'ready'
         AND checkpoint.native_turn_id IS NOT NULL
         AND checkpoint.input_workspace_snapshot_id IS NOT NULL
         AND checkpoint.includes_native_state
         AND checkpoint.workspace_volume_id = runtime.workspace_volume_id
       ORDER BY checkpoint.ordinal`,
      [sessionId],
    );
    return result.rows.map((row) => row.native_turn_id);
  }

  /** Includes non-forkable ordinal-zero baselines created by forks/migration. */
  async hasMaterializedNativeHistory(sessionId: string) {
    const result = await this.pool.query<{ has_history: boolean }>(
      `SELECT runtime.native_history_materialized OR EXISTS (
         SELECT 1
         FROM session_turn_checkpoints checkpoint
         WHERE checkpoint.session_id = runtime.session_id
           AND checkpoint.status <> 'deleted'
           AND checkpoint.native_head_turn_id IS NOT NULL
           AND checkpoint.native_session_id = runtime.native_session_id
           AND checkpoint.workspace_volume_id = runtime.workspace_volume_id
       ) AS has_history
       FROM session_runtime runtime
       WHERE runtime.session_id = $1`,
      [sessionId],
    );
    return result.rows[0]?.has_history ?? false;
  }


  async latestCompletedTurnId(sessionId: string) {
    const result = await this.pool.query<{ native_head_turn_id: string }>(
      `SELECT checkpoint.native_head_turn_id
       FROM session_turn_checkpoints checkpoint
       WHERE checkpoint.session_id = $1 AND checkpoint.status = 'ready'
         AND checkpoint.native_head_turn_id IS NOT NULL
       ORDER BY checkpoint.ordinal DESC
       LIMIT 1`,
      [sessionId],
    );
    return result.rows[0]?.native_head_turn_id;
  }

  async claimTurnCheckpoint(
    sessionId: string,
    input: {
      nativeSessionId: string;
      nativeTurnId?: string;
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
        input.nativeTurnId
          ? `SELECT id, ordinal, status FROM session_turn_checkpoints
             WHERE session_id = $1 AND native_turn_id = $2`
          : `SELECT id, ordinal, status FROM session_turn_checkpoints
             WHERE session_id = $1 AND native_session_id = $2
               AND ordinal = 0`,
        input.nativeTurnId
          ? [sessionId, input.nativeTurnId]
          : [sessionId, input.nativeSessionId],
      );
      const row = existing.rows[0];
      if (row?.status === "creating" || row?.status === "ready") {
        await client.query("COMMIT");
        return { state: row.status };
      }
      if (row) {
        await client.query(
          `UPDATE session_turn_checkpoints
           SET ordinal = CASE
                 WHEN ordinal = 0 THEN 0
                 ELSE (
                   SELECT COALESCE(MAX(current.ordinal), 0) + 1
                   FROM session_turn_checkpoints current
                   WHERE current.session_id = session_turn_checkpoints.session_id
                     AND current.status = 'ready'
                 )
               END,
               native_session_id = $2,
               includes_native_state = (
                 SELECT harness_state_layout = 'workspace_v2'
                 FROM session_runtime WHERE session_id = $3
               ),
               status = 'creating', workspace_snapshot_id = NULL, error = NULL
           WHERE id = $1`,
          [row.id, input.nativeSessionId, sessionId],
        );
        await client.query("COMMIT");
        return { state: "claimed", id: row.id, ordinal: Number(row.ordinal) };
      }

      const ordinal = input.nativeTurnId
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
           id, session_id, ordinal, native_session_id, native_turn_id,
           native_head_turn_id, workspace_volume_id, includes_native_state,
           status
         )
         SELECT $1, $2, $3, $4, $5, $6, workspace_volume_id,
                harness_state_layout = 'workspace_v2', 'creating'
         FROM session_runtime WHERE session_id = $2`,
        [
          id,
          sessionId,
          ordinal,
          input.nativeSessionId,
          input.nativeTurnId ?? null,
          input.nativeHeadTurnId ?? input.nativeTurnId ?? null,
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ session_id: string }>(
        `SELECT session_id FROM session_turn_checkpoints WHERE id = $1`,
        [checkpointId],
      );
      const sessionId = selected.rows[0]?.session_id;
      if (!sessionId) {
        throw new HttpError(
          409,
          "turn_checkpoint_claim_lost",
          "The Workspace checkpoint claim is no longer active.",
        );
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      if (
        !(await this.completeTurnCheckpointLocked(
          client,
          sessionId,
          checkpointId,
          snapshotId,
        ))
      ) {
        throw new HttpError(
          409,
          "turn_checkpoint_claim_lost",
          "The Workspace checkpoint claim is no longer active.",
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

  /**
   * Resolves an unknown COMMIT outcome without racing the original transaction.
   * The same Session advisory lock makes a negative result conclusive; a
   * surviving creating claim is completed with the already-created snapshot.
   */
  async reconcileTurnCheckpointCommit(
    checkpointId: string,
    snapshotId: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{ session_id: string }>(
        `SELECT session_id FROM session_turn_checkpoints WHERE id = $1`,
        [checkpointId],
      );
      const sessionId = selected.rows[0]?.session_id;
      if (!sessionId) {
        await client.query("COMMIT");
        return false;
      }
      // If the former connection is still finishing COMMIT, this waits for it
      // before reading the checkpoint state below.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const result = await client.query<{
        status: string;
        workspace_snapshot_id: string | null;
      }>(
        `SELECT status, workspace_snapshot_id
         FROM session_turn_checkpoints WHERE id = $1`,
        [checkpointId],
      );
      const checkpoint = result.rows[0];
      if (
        checkpoint?.status === "ready" &&
        checkpoint.workspace_snapshot_id === snapshotId
      ) {
        await client.query("COMMIT");
        return true;
      }
      if (
        checkpoint?.status === "creating" &&
        (checkpoint.workspace_snapshot_id === null ||
          checkpoint.workspace_snapshot_id === snapshotId) &&
        (await this.completeTurnCheckpointLocked(
          client,
          sessionId,
          checkpointId,
          snapshotId,
        ))
      ) {
        await client.query("COMMIT");
        return true;
      }
      await client.query("COMMIT");
      return false;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeTurnCheckpointLocked(
    client: PoolClient,
    sessionId: string,
    checkpointId: string,
    snapshotId: string,
  ) {
    const completed = await client.query<{
      pending_turn_input_snapshot_id: string | null;
    }>(
      `UPDATE session_turn_checkpoints checkpoint
       SET status = 'ready', workspace_snapshot_id = $2,
           input_workspace_snapshot_id = CASE
             WHEN checkpoint.ordinal = 0 THEN checkpoint.input_workspace_snapshot_id
             ELSE runtime.pending_turn_input_snapshot_id
           END,
           error = NULL
       FROM session_runtime runtime
       WHERE checkpoint.id = $1 AND checkpoint.status = 'creating'
         AND (checkpoint.workspace_snapshot_id IS NULL
              OR checkpoint.workspace_snapshot_id = $2)
         AND runtime.session_id = checkpoint.session_id
         AND runtime.native_session_id = checkpoint.native_session_id
         AND runtime.workspace_volume_id = checkpoint.workspace_volume_id
       RETURNING runtime.pending_turn_input_snapshot_id`,
      [checkpointId, snapshotId],
    );
    const row = completed.rows[0];
    if (!row) return false;
    if (row.pending_turn_input_snapshot_id) {
      await client.query(
        `UPDATE session_runtime
         SET pending_turn_input_snapshot_id = NULL,
             pending_turn_request_id = NULL,
             pending_turn_client_message_id = NULL,
             pending_turn_stable_input_id = NULL,
             pending_turn_phase = NULL,
             pending_turn_native_turn_id = NULL,
             pending_turn_started_at = NULL,
             pending_turn_submitted_at = NULL,
             updated_at = NOW()
         WHERE session_id = $1 AND pending_turn_input_snapshot_id = $2`,
        [sessionId, row.pending_turn_input_snapshot_id],
      );
    }
    await client.query(
      `UPDATE session_runtime
       SET head_volume_snapshot_id = $2,
           native_history_materialized = native_history_materialized OR EXISTS (
             SELECT 1 FROM session_turn_checkpoints checkpoint
             WHERE checkpoint.id = $3
               AND checkpoint.native_head_turn_id IS NOT NULL
           ),
           updated_at = NOW()
       WHERE session_id = $1`,
      [sessionId, snapshotId, checkpointId],
    );
    return true;
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
    // Sandpi currently runs one backend server. At process startup there can
    // be no live in-memory checkpoint owner, so every creating row is an
    // abandoned claim regardless of age. This makes a fast restart retryable
    // instead of leaving the Session permanently locked for two minutes (or
    // forever when no later startup performs reconciliation).
    await this.pool.query(
      `UPDATE session_turn_checkpoints
       SET status = 'failed', error = 'Checkpoint worker stopped before completion.'
       WHERE status = 'creating'`,
    );
  }

  async retryableTurnCheckpoints(sessionId: string) {
    const result = await this.pool.query<{
      native_session_id: string;
      native_turn_id: string;
      native_head_turn_id: string;
    }>(
      `SELECT native_session_id, native_turn_id, native_head_turn_id
       FROM session_turn_checkpoints
       WHERE session_id = $1 AND status = 'failed'
         AND native_turn_id IS NOT NULL
         AND updated_at < NOW() - INTERVAL '5 seconds'
       ORDER BY ordinal
       LIMIT 1`,
      [sessionId],
    );
    return result.rows.map(
      (row): RetryableTurnCheckpoint => ({
        nativeSessionId: row.native_session_id,
        nativeTurnId: row.native_turn_id,
        nativeHeadTurnId: row.native_head_turn_id,
      }),
    );
  }

  async reserveTurnFork(
    userId: string,
    sessionId: string,
    nativeTurnId: string,
  ): Promise<TurnForkPoint> {
    await this.getSession(userId, sessionId);
    const client = await this.pool.connect();
    const operationId = `operation_${randomUUID()}`;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const selected = await client.query<{
        ordinal: number;
        native_turn_id: string;
        workspace_snapshot_id: string;
      }>(
        `SELECT c.ordinal, c.native_turn_id, c.workspace_snapshot_id
         FROM session_turn_checkpoints c
         JOIN session_runtime runtime ON runtime.session_id = c.session_id
         WHERE c.session_id = $1 AND c.native_turn_id = $2
           AND c.workspace_volume_id = runtime.workspace_volume_id
           AND c.status = 'ready' AND c.includes_native_state`,
        [sessionId, nativeTurnId],
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
        `UPDATE session_runtime runtime
         SET exclusive_operation_id = $3,
             exclusive_operation_kind = 'turn_fork',
             exclusive_operation_started_at = NOW(),
             exclusive_operation_heartbeat_at = NOW(),
             version = version + 1,
             updated_at = NOW()
         FROM sessions session
         WHERE runtime.session_id = $1
           AND session.id = runtime.session_id
           AND session.created_by_user_id = $2
           AND session.status = 'waiting'
           AND session.hard_expires_at > NOW()
           AND runtime.exclusive_operation_id IS NULL
           AND runtime.active_native_turn_id IS NULL
           AND runtime.pending_turn_phase IS NULL
           AND runtime.pending_turn_input_snapshot_id IS NULL
           AND runtime.pending_interrupted_native_turn_id IS NULL
           AND runtime.desired_state = 'running'
           AND runtime.observed_state = 'running'
           AND runtime.provisioning_error IS NULL
           AND runtime.runtime_error_code IS NULL
           AND runtime.harness_state_layout = 'workspace_v2'
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_mutations mutation
             WHERE mutation.session_id = runtime.session_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_checkpoints pending_checkpoint
             WHERE pending_checkpoint.session_id = runtime.session_id
               AND pending_checkpoint.native_turn_id IS NOT NULL
               AND pending_checkpoint.status IN ('creating', 'failed')
           )
         RETURNING runtime.session_id`,
        [sessionId, userId, operationId],
      );
      if (!reserved.rowCount) {
        throw new HttpError(
          409,
          "turn_fork_conflict",
          "The Session changed while the Turn fork was starting.",
        );
      }
      const locked = await client.query(
        `UPDATE sessions SET status = 'running', unread = FALSE
         WHERE id = $1 AND status = 'waiting'
         RETURNING id`,
        [sessionId],
      );
      if (!locked.rowCount) {
        throw new HttpError(
          409,
          "turn_fork_conflict",
          "The Session changed while the Turn fork was starting.",
        );
      }
      await client.query("COMMIT");
      return {
        operationId,
        selectedTurnId: checkpoint.native_turn_id,
        selectedOrdinal: Number(checkpoint.ordinal),
        selectedSnapshotId: checkpoint.workspace_snapshot_id,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareTurnMutation(
    userId: string,
    sessionId: string,
    nativeTurnId: string,
    kind: "edit" | "delete" = "delete",
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
        native_turn_id: string;
        input_workspace_snapshot_id: string;
        input_native_head_turn_id: string | null;
        native_session_id: string;
        workspace_volume_id: string;
        history_revision: string | number;
        head_volume_snapshot_id: string;
      }>(
        `SELECT checkpoint.ordinal, checkpoint.native_turn_id,
                checkpoint.input_workspace_snapshot_id,
                input_boundary.native_head_turn_id AS input_native_head_turn_id,
                runtime.native_session_id, runtime.workspace_volume_id,
                runtime.history_revision, runtime.head_volume_snapshot_id
         FROM session_turn_checkpoints checkpoint
         JOIN session_runtime runtime
           ON runtime.session_id = checkpoint.session_id
          AND runtime.workspace_volume_id = checkpoint.workspace_volume_id
         JOIN LATERAL (
           SELECT previous.native_head_turn_id
           FROM session_turn_checkpoints previous
           WHERE previous.session_id = checkpoint.session_id
             AND previous.workspace_volume_id = checkpoint.workspace_volume_id
             AND previous.ordinal < checkpoint.ordinal
             AND previous.status = 'ready'
             AND previous.includes_native_state
           ORDER BY previous.ordinal DESC
           LIMIT 1
         ) input_boundary ON TRUE
         WHERE checkpoint.session_id = $1 AND checkpoint.native_turn_id = $2
           AND checkpoint.status = 'ready'
           AND checkpoint.includes_native_state
           AND checkpoint.input_workspace_snapshot_id IS NOT NULL
           AND runtime.harness_state_layout = 'workspace_v2'
         FOR UPDATE OF runtime`,
        [sessionId, nativeTurnId],
      );
      const checkpoint = selected.rows[0];
      if (
        !checkpoint?.input_workspace_snapshot_id ||
        !checkpoint.native_session_id ||
        !checkpoint.workspace_volume_id ||
        !checkpoint.head_volume_snapshot_id
      ) {
        throw new HttpError(
          409,
          "turn_checkpoint_unavailable",
          "This Turn does not have an exact native-state input checkpoint.",
        );
      }
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
      const mutationId = `mutation_${randomUUID()}`;
      await client.query(
        `INSERT INTO session_turn_mutations (
           id, session_id, kind, phase, selected_native_turn_id,
           selected_ordinal, original_native_session_id,
           restore_workspace_snapshot_id, head_workspace_snapshot_id,
           workspace_volume_id, expected_history_revision
         ) VALUES ($1, $2, $3, 'prepared', $4, $5, $6, $7, $8, $9, $10)`,
        [
          mutationId,
          sessionId,
          kind,
          checkpoint.native_turn_id,
          Number(checkpoint.ordinal),
          checkpoint.native_session_id,
          checkpoint.input_workspace_snapshot_id,
          checkpoint.head_volume_snapshot_id,
          checkpoint.workspace_volume_id,
          Number(checkpoint.history_revision),
        ],
      );
      await client.query("COMMIT");
      return {
        mutationId,
        selectedTurnId: checkpoint.native_turn_id,
        selectedOrdinal: Number(checkpoint.ordinal),
        inputNativeHeadTurnId:
          checkpoint.input_native_head_turn_id ?? undefined,
        nativeSessionId: checkpoint.native_session_id,
        workspaceVolumeId: checkpoint.workspace_volume_id,
        expectedHistoryRevision: Number(checkpoint.history_revision),
        restoreSnapshotId: checkpoint.input_workspace_snapshot_id,
        headSnapshotId: checkpoint.head_volume_snapshot_id,
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
    input: {
      mutationId: string;
      nativeSessionId: string;
      attemptId: string;
      runtimeGeneration: number;
    },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const runtimeUpdated = await client.query(
        `UPDATE session_runtime
         SET attempt_id = $3, runtime_generation = $4,
             stdout_tail = '', observed_state = 'running',
             provisioning_error = NULL, runtime_error_code = NULL,
             version = version + 1
         WHERE session_id = $1 AND native_session_id = $2
         RETURNING session_id`,
        [
          sessionId,
          input.nativeSessionId,
          input.attemptId,
          input.runtimeGeneration,
        ],
      );
      const mutationUpdated = await client.query(
        `UPDATE session_turn_mutations
         SET phase = CASE
           WHEN phase = 'compensating' THEN 'compensating'
           ELSE 'restored'
         END
         WHERE session_id = $1 AND original_native_session_id = $2
           AND id = $3
           AND phase IN ('restore_requested', 'compensating')
         RETURNING id`,
        [sessionId, input.nativeSessionId, input.mutationId],
      );
      if (!runtimeUpdated.rowCount || !mutationUpdated.rowCount) {
        throw new HttpError(
          409,
          "turn_mutation_restore_conflict",
          "The native Session changed while its Volume snapshot was restored.",
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

  async markTurnMutationRestoreRequested(
    sessionId: string,
    context: TurnMutationContext,
  ) {
    const requested = await this.pool.query(
      `UPDATE session_turn_mutations mutation
       SET phase = 'restore_requested'
       FROM session_runtime runtime
       WHERE mutation.session_id = $1
         AND mutation.id = $9
         AND runtime.session_id = mutation.session_id
         AND mutation.selected_native_turn_id = $2
         AND mutation.selected_ordinal = $3
         AND mutation.original_native_session_id = $4
         AND mutation.workspace_volume_id = $5
         AND mutation.expected_history_revision = $6
         AND mutation.restore_workspace_snapshot_id = $7
         AND mutation.head_workspace_snapshot_id = $8
         AND mutation.phase = 'prepared'
         AND runtime.native_session_id = mutation.original_native_session_id
         AND runtime.workspace_volume_id = mutation.workspace_volume_id
         AND runtime.history_revision = mutation.expected_history_revision
       RETURNING mutation.id`,
      [
        sessionId,
        context.selectedTurnId,
        context.selectedOrdinal,
        context.nativeSessionId,
        context.workspaceVolumeId,
        context.expectedHistoryRevision,
        context.restoreSnapshotId,
        context.headSnapshotId,
        context.mutationId,
      ],
    );
    if (!requested.rowCount) {
      throw new HttpError(
        409,
        "turn_mutation_restore_conflict",
        "The Session changed before its Volume restore could start.",
      );
    }
  }

  async markTurnMutationNativeSessionReady(
    sessionId: string,
    mutationId: string,
    expectedHistoryRevision: number,
    resultNativeSessionId: string,
  ) {
    const recorded = await this.pool.query(
      `UPDATE session_turn_mutations mutation
       SET result_native_session_id = $3
       FROM session_runtime runtime
       WHERE mutation.session_id = $1
         AND mutation.id = $4
         AND runtime.session_id = mutation.session_id
         AND mutation.phase = 'restored'
         AND mutation.expected_history_revision = $2
         AND runtime.history_revision = $2
         AND runtime.native_session_id = mutation.original_native_session_id
         AND (mutation.result_native_session_id IS NULL
              OR mutation.result_native_session_id = $3)
       RETURNING mutation.id`,
      [sessionId, expectedHistoryRevision, resultNativeSessionId, mutationId],
    );
    if (!recorded.rowCount) {
      throw new HttpError(
        409,
        "turn_mutation_native_session_conflict",
        "The restored native Session changed before history commit.",
      );
    }
  }

  async setNativeSession(
    sessionId: string,
    nativeSessionId: string,
    options: {
      expectedNativeSessionId?: string;
      incrementHistoryRevision?: boolean;
      expectedExclusiveOperationId?: string;
    } = {},
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const updated = await client.query(
        `UPDATE session_runtime
         SET native_session_id = $2,
             native_history_materialized = CASE
               WHEN native_session_id IS DISTINCT FROM $2 THEN FALSE
               ELSE native_history_materialized
             END,
             history_revision = history_revision +
               CASE WHEN $4 THEN 1 ELSE 0 END,
             version = version + 1
         WHERE session_id = $1
           AND ($3::TEXT IS NULL OR native_session_id = $3)
           AND ($5::TEXT IS NULL OR exclusive_operation_id = $5)
         RETURNING session_id`,
        [
          sessionId,
          nativeSessionId,
          options.expectedNativeSessionId ?? null,
          options.incrementHistoryRevision ?? false,
          options.expectedExclusiveOperationId ?? null,
        ],
      );
      await client.query("COMMIT");
      return Boolean(updated.rowCount);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markTurnMutationReplacementStarted(
    sessionId: string,
    mutationId: string,
    nativeTurnId: string,
  ) {
    const recorded = await this.pool.query(
      `UPDATE session_turn_mutations
       SET replacement_native_turn_id = COALESCE(
             replacement_native_turn_id, $2
           ),
           phase = 'replacement_started'
       WHERE session_id = $1 AND id = $3
         AND kind = 'edit' AND phase = 'restored'
         AND result_native_session_id IS NOT NULL
         AND (replacement_native_turn_id IS NULL
              OR replacement_native_turn_id = $2)
       RETURNING id`,
      [sessionId, nativeTurnId, mutationId],
    );
    if (!recorded.rowCount) {
      throw new HttpError(
        409,
        "turn_mutation_replacement_conflict",
        "The replacement Codex Turn changed before history restore committed.",
      );
    }
  }

  async markTurnMutationCompensating(sessionId: string, mutationId: string) {
    const recorded = await this.pool.query(
      `UPDATE session_turn_mutations
       SET phase = 'compensating'
       WHERE session_id = $1 AND id = $2
         AND phase IN (
           'restore_requested', 'restored', 'replacement_started', 'compensating'
         )
       RETURNING id`,
      [sessionId, mutationId],
    );
    if (!recorded.rowCount) {
      throw new HttpError(
        409,
        "turn_mutation_compensation_conflict",
        "The history mutation is no longer available for compensation.",
      );
    }
  }

  async finalizeTurnMutation(
    sessionId: string,
    context: TurnMutationContext,
    status: "running" | "waiting" = "waiting",
    modelId?: string,
    replacement?: { nativeTurnId?: string },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const mutation = await client.query<{
        kind: "edit" | "delete";
        phase: TurnMutationPhase;
        original_native_session_id: string;
        result_native_session_id: string | null;
        workspace_volume_id: string;
        expected_history_revision: string | number;
        restore_workspace_snapshot_id: string;
        head_workspace_snapshot_id: string;
        replacement_native_turn_id: string | null;
        candidate_terminal_status: "completed" | "failed" | "interrupted" | null;
        candidate_supervisor_session_id: string | null;
        candidate_supervisor_sequence: string | number | null;
      }>(
        `SELECT kind, phase, original_native_session_id,
                result_native_session_id, workspace_volume_id,
                expected_history_revision, restore_workspace_snapshot_id,
                head_workspace_snapshot_id, replacement_native_turn_id,
                candidate_terminal_status, candidate_supervisor_session_id,
                candidate_supervisor_sequence
         FROM session_turn_mutations
         WHERE session_id = $1 AND id = $4
           AND selected_native_turn_id = $2
           AND selected_ordinal = $3
           AND ((kind = 'delete' AND phase = 'restored')
                OR (kind = 'edit' AND phase = 'replacement_started'))
         FOR UPDATE`,
        [
          sessionId,
          context.selectedTurnId,
          context.selectedOrdinal,
          context.mutationId,
        ],
      );
      const operation = mutation.rows[0];
      if (
        !operation ||
        !operation.result_native_session_id ||
        operation.original_native_session_id !== context.nativeSessionId ||
        operation.workspace_volume_id !== context.workspaceVolumeId ||
        Number(operation.expected_history_revision) !==
          context.expectedHistoryRevision ||
        operation.restore_workspace_snapshot_id !== context.restoreSnapshotId ||
        operation.head_workspace_snapshot_id !== context.headSnapshotId ||
        (operation.kind === "edit" &&
          (!replacement?.nativeTurnId ||
            operation.replacement_native_turn_id !== replacement.nativeTurnId)) ||
        (operation.kind === "delete" && replacement?.nativeTurnId !== undefined)
      ) {
        throw new HttpError(
          409,
          "turn_mutation_commit_conflict",
          "The same-native-Session history restore is not ready to commit.",
        );
      }
      const invalidated = await client.query<{
        workspace_snapshot_id: string | null;
        input_workspace_snapshot_id: string | null;
      }>(
        `UPDATE session_turn_checkpoints
         SET status = 'deleted'
         WHERE session_id = $1 AND ordinal >= $2 AND status = 'ready'
           AND workspace_volume_id = $3
         RETURNING workspace_snapshot_id, input_workspace_snapshot_id`,
        [sessionId, context.selectedOrdinal, context.workspaceVolumeId],
      );
      if (operation.candidate_terminal_status && replacement?.nativeTurnId) {
        await client.query(
          `INSERT INTO session_turn_checkpoints (
             id, session_id, ordinal, native_session_id, native_turn_id,
             native_head_turn_id, workspace_volume_id, terminal_status,
             seal_kind, sealed_supervisor_session_id,
             sealed_supervisor_sequence, includes_native_state, status, error
           )
           SELECT $1, $2, COALESCE(MAX(ordinal), 0) + 1,
                  $3, $4, $4, $5, $6, 'native_event', $7, $8,
                  TRUE, 'failed', 'Workspace checkpoint capture is pending.'
           FROM session_turn_checkpoints
           WHERE session_id = $2 AND status = 'ready'
           ON CONFLICT (session_id, native_turn_id)
             WHERE native_turn_id IS NOT NULL
           DO NOTHING`,
          [
            `checkpoint_${randomUUID()}`,
            sessionId,
            operation.result_native_session_id,
            replacement.nativeTurnId,
            operation.workspace_volume_id,
            operation.candidate_terminal_status,
            operation.candidate_supervisor_session_id,
            operation.candidate_supervisor_sequence,
          ],
        );
      }
      const committedStatus = operation.candidate_terminal_status
        ? "running"
        : status;
      await client.query(
        `UPDATE sessions SET status = $2, unread = FALSE WHERE id = $1`,
        [sessionId, committedStatus],
      );
      const runtimeUpdated = await client.query<{
        pending_turn_input_snapshot_id: string | null;
      }>(
        `UPDATE session_runtime
         SET desired_state = 'running', observed_state = 'running',
             native_session_id = $3,
             native_history_materialized =
               ($4::TEXT IS NOT NULL OR $10::TEXT IS NOT NULL),
             history_revision = history_revision + 1,
             head_volume_snapshot_id = $8,
             active_native_turn_id = CASE WHEN $9 THEN NULL ELSE $4 END,
             active_turn_started_at = CASE
               WHEN $9 OR $4::TEXT IS NULL THEN NULL ELSE NOW()
             END,
             active_turn_supervisor_sequence = NULL,
             model_id = COALESCE($2::TEXT, model_id),
             version = version + 1, updated_at = NOW()
         WHERE session_id = $1 AND native_session_id = $5
           AND workspace_volume_id = $6
           AND history_revision = $7
           AND harness_state_layout = 'workspace_v2'
         RETURNING pending_turn_input_snapshot_id`,
        [
          sessionId,
          modelId ?? null,
          operation.result_native_session_id,
          replacement?.nativeTurnId ?? null,
          operation.original_native_session_id,
          operation.workspace_volume_id,
          Number(operation.expected_history_revision),
          context.restoreSnapshotId,
          Boolean(operation.candidate_terminal_status),
          context.inputNativeHeadTurnId ?? null,
        ],
      );
      if (!runtimeUpdated.rowCount) {
        throw new HttpError(
          409,
          "turn_mutation_commit_conflict",
          "The native Session, Volume, or history revision changed before commit.",
        );
      }
      await client.query(
        `DELETE FROM session_turn_mutations WHERE session_id = $1 AND id = $2`,
        [sessionId, context.mutationId],
      );
      await client.query("COMMIT");
      const retainedInputSnapshotId =
        runtimeUpdated.rows[0]?.pending_turn_input_snapshot_id;
      return [
        ...new Set(
          invalidated.rows
            .flatMap((row) => [
              row.workspace_snapshot_id,
              row.input_workspace_snapshot_id,
            ])
            .filter(
              (snapshotId): snapshotId is string =>
                Boolean(snapshotId) &&
                snapshotId !== retainedInputSnapshotId &&
                snapshotId !== context.restoreSnapshotId,
            ),
        ),
      ];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releasePreparedTurnMutation(
    sessionId: string,
    mutationId: string,
    options: {
      clearPendingInput?: boolean;
      expectedPhase?: "prepared" | "compensating";
    } = {},
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const released = await client.query(
        `DELETE FROM session_turn_mutations
         WHERE session_id = $1 AND id = $2 AND phase = $3
         RETURNING id`,
        [sessionId, mutationId, options.expectedPhase ?? "prepared"],
      );
      if (!released.rowCount) {
        throw new HttpError(
          409,
          "turn_mutation_release_conflict",
          "The history mutation owner changed before release.",
        );
      }
      await client.query(
        `UPDATE session_runtime
         SET desired_state = 'running', observed_state = 'running',
             provisioning_error = NULL, runtime_error_code = NULL,
             pending_turn_input_snapshot_id = CASE
               WHEN $2 THEN NULL ELSE pending_turn_input_snapshot_id
             END,
             pending_turn_request_id = CASE
               WHEN $2 THEN NULL ELSE pending_turn_request_id
             END,
             pending_turn_client_message_id = CASE
               WHEN $2 THEN NULL ELSE pending_turn_client_message_id
             END,
             pending_turn_stable_input_id = CASE
               WHEN $2 THEN NULL ELSE pending_turn_stable_input_id
             END,
             pending_turn_phase = CASE
               WHEN $2 THEN NULL ELSE pending_turn_phase
             END,
             pending_turn_native_turn_id = CASE
               WHEN $2 THEN NULL ELSE pending_turn_native_turn_id
             END,
             pending_turn_started_at = CASE
               WHEN $2 THEN NULL ELSE pending_turn_started_at
             END,
             pending_turn_submitted_at = CASE
               WHEN $2 THEN NULL ELSE pending_turn_submitted_at
             END
         WHERE session_id = $1`,
        [sessionId, options.clearPendingInput ?? false],
      );
      await client.query(
        `UPDATE sessions session
         SET status = 'waiting', unread = FALSE
         FROM session_runtime runtime
         WHERE session.id = $1 AND runtime.session_id = session.id
           AND session.status = 'paused'
           AND runtime.exclusive_operation_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_turn_mutations mutation
             WHERE mutation.session_id = session.id
           )`,
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

}

const SESSION_SELECT = `
  SELECT s.*, r.sandbox_id, r.workspace_volume_id, r.supervisor_session_id,
         r.terminal_session_id, r.native_session_id, r.model_id,
         r.history_revision
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
      currentPeriodStartsAt: toUnixTimestamp(row.billing_period_starts_at),
      currentPeriodEndsAt: toUnixTimestamp(row.billing_period_ends_at),
    },
    createdAt: toUnixTimestamp(row.created_at),
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
      currentPeriodStartsAt: toUnixTimestamp(row.plan_period_starts_at),
      currentPeriodEndsAt: toUnixTimestamp(row.plan_period_ends_at),
      quotas: {
        ...row.plan_quotas,
        weeklyExecution: {
          ...row.plan_quotas.weeklyExecution,
          resetsAt:
            parseUnixTimestamp(row.plan_quotas.weeklyExecution.resetsAt) ?? 0,
        },
      },
    } satisfies MembershipPlanAssignment,
    joinedAt: toUnixTimestamp(row.joined_at),
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
      lastVerified: parseUnixTimestamp(metadata.lastVerified),
    },
    networkPolicy: row.network_policy,
    functions: row.functions,
    provisioningError: row.provisioning_error ?? undefined,
  };
}

function sessionFromRow(row: SessionRow): CodingSession {
  const harnessState: CodexHarnessState = {
    protocol: "codex-app-server",
    threadId: row.native_session_id ?? row.harness_state.threadId ?? "",
    modelId: row.model_id ?? row.harness_state.modelId ?? "",
    harnessVersion: row.harness_state.harnessVersion ?? "runtime",
    protocolVersion: "v2",
    historyRevision: Number(row.history_revision ?? 0),
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
    createdAt: toUnixTimestamp(row.created_at),
    updatedAt: toUnixTimestamp(row.updated_at),
    hardExpiresAt: toUnixTimestamp(row.hard_expires_at),
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
    version: Number(row.version),
    sandboxId: row.sandbox_id,
    workspaceVolumeId: row.workspace_volume_id,
    supervisorSessionId: row.supervisor_session_id,
    terminalSessionId: row.terminal_session_id ?? undefined,
    supervisorCursor: Number(row.supervisor_cursor),
    nativeSessionId: row.native_session_id ?? undefined,
    modelId: row.model_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    runtimeGeneration: Number(row.runtime_generation),
    historyRevision: Number(row.history_revision),
    harnessStateLayout: row.harness_state_layout,
    headVolumeSnapshotId: row.head_volume_snapshot_id ?? undefined,
    activeNativeTurnId: row.active_native_turn_id ?? undefined,
    pendingInterruptedNativeTurnId:
      row.pending_interrupted_native_turn_id ?? undefined,
    pendingTurnRequestId: row.pending_turn_request_id ?? undefined,
    pendingTurnClientMessageId:
      row.pending_turn_client_message_id ?? undefined,
    pendingTurnStableInputId: row.pending_turn_stable_input_id ?? undefined,
    pendingTurnPhase: row.pending_turn_phase ?? undefined,
    pendingTurnNativeTurnId: row.pending_turn_native_turn_id ?? undefined,
    pendingTurnStartedAt: row.pending_turn_started_at ?? undefined,
    pendingTurnSubmittedAt: row.pending_turn_submitted_at ?? undefined,
    runtimeErrorCode: row.runtime_error_code ?? undefined,
    provisioningError: row.provisioning_error ?? undefined,
    exclusiveOperationId: row.exclusive_operation_id ?? undefined,
    exclusiveOperationKind: row.exclusive_operation_kind ?? undefined,
    exclusiveOperationStartedAt:
      row.exclusive_operation_started_at ?? undefined,
    exclusiveOperationHeartbeatAt:
      row.exclusive_operation_heartbeat_at ?? undefined,
    nativeStateMigrationSnapshotId:
      row.native_state_migration_snapshot_id ?? undefined,
    nativeHistoryMaterialized: row.native_history_materialized,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    decoder: {
      supervisorCursor: Number(row.supervisor_cursor),
      tailBase64: row.stdout_tail,
      attemptId: row.attempt_id ?? undefined,
      runtimeGeneration: Number(row.runtime_generation),
    },
  };
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
