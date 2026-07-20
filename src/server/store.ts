import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CodexHarnessState } from "@/harnesses/codex/types";
import type {
  CodingSession,
  Environment,
  EnvironmentSandboxState,
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
import { conflict, HttpError, notFound } from "@/server/http-error";
import {
  ENVIRONMENT_IDLE_PAUSE_DELAY_MS,
  ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
  ENVIRONMENT_PAUSE_RETRY_DELAY_MS,
  ENVIRONMENT_SANDBOX_HARD_TTL_SECONDS,
} from "@/server/environments/lifecycle-policy";
import type { CodexDecoderState } from "@/server/harnesses/codex/jsonl";
import type {
  EnvironmentRuntimeRecord,
  ProvisionedEnvironment,
  RecoveredCodexEnvironmentRuntime,
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

export type TurnSubmissionPhase = "prepared" | "submitted" | "accepted";

export interface TurnSubmissionCoordinates {
  requestId: string;
  clientMessageId: string;
  stableInputId: string;
}

export interface StoredEnvironmentRuntime extends EnvironmentRuntimeRecord {
  version: number;
  desiredState: "running" | "paused" | "terminated";
  observedState:
    | "pending"
    | "provisioning"
    | "running"
    | "paused"
    | "terminated"
    | "failed";
  provisioningError?: string;
  lifecyclePolicyVersion: number;
  hardExpiresAt?: Date;
  lastTurnCompletedAt?: Date;
  idlePauseDueAt?: Date;
  lifecycleError?: string;
  pausedAt?: Date;
}

export interface StoredSessionRuntime {
  sessionId: string;
  environmentId: string;
  nativeSessionId?: string;
  modelId?: string;
  historyRevision: number;
  activeNativeTurnId?: string;
  pendingTurnRequestId?: string;
  pendingTurnClientMessageId?: string;
  pendingTurnStableInputId?: string;
  pendingTurnPhase?: TurnSubmissionPhase;
  pendingTurnNativeTurnId?: string;
  pendingTurnStartedAt?: Date;
  runtimeErrorCode?: string;
  version: number;
  sessionStatus: CodingSession["status"] | "provisioning";
}

/** Scalar control facts extracted from native events; never transcript data. */
export type CodexControlTransition =
  | {
      type: "turnStarted";
      nativeSessionId: string;
      nativeTurnId: string;
      startedAt: Date;
    }
  | {
      type: "turnCompleted";
      nativeSessionId: string;
      nativeTurnId: string;
      status: "completed" | "failed" | "interrupted";
      completedAt: Date;
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
  sandbox_id: string | null;
  sandbox_state: EnvironmentSandboxState | null;
  supervisor_session_id: string | null;
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
  environment_revision: number;
  origin_kind: NonNullable<CodingSession["origin"]>["kind"] | null;
  origin_label: string | null;
  source_session_id: string | null;
  source_native_item_id: string | null;
  created_at: Date;
  updated_at: Date;
  native_session_id: string | null;
  model_id: string | null;
  history_revision: string | number | null;
}

interface EnvironmentRuntimeRow extends QueryResultRow {
  environment_id: string;
  workspace_volume_id: string | null;
  sandbox_id: string | null;
  supervisor_session_id: string | null;
  terminal_session_id: string | null;
  supervisor_cursor: string | number;
  stdout_tail: string;
  attempt_id: string | null;
  runtime_generation: string | number;
  decoder_attempt_id?: string | null;
  decoder_runtime_generation?: string | number;
  desired_state: StoredEnvironmentRuntime["desiredState"];
  observed_state: StoredEnvironmentRuntime["observedState"];
  provisioning_error: string | null;
  lifecycle_policy_version: string | number;
  sandbox_hard_expires_at: Date | null;
  last_turn_completed_at: Date | null;
  idle_pause_due_at: Date | null;
  lifecycle_error: string | null;
  paused_at: Date | null;
  version: string | number;
}

interface SessionRuntimeRow extends QueryResultRow {
  session_id: string;
  environment_id: string;
  native_session_id: string | null;
  model_id: string | null;
  history_revision: string | number;
  active_native_turn_id: string | null;
  pending_turn_request_id: string | null;
  pending_turn_client_message_id: string | null;
  pending_turn_stable_input_id: string | null;
  pending_turn_phase: TurnSubmissionPhase | null;
  pending_turn_native_turn_id: string | null;
  pending_turn_started_at: Date | null;
  runtime_error_code: string | null;
  version: string | number;
  status: string;
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

// Shared with transaction-scoped Turn admission and session-scoped lifecycle
// workers. The second advisory-lock key is hashtext(Environment.id).
const ENVIRONMENT_LIFECYCLE_LOCK_NAMESPACE = 1_907_424_101;
const ENVIRONMENT_MCP_MUTATION_LOCK_NAMESPACE = 1_907_424_102;
const ENVIRONMENT_MCP_OAUTH_CREDENTIAL_LOCK_NAMESPACE = 1_907_424_103;

export class SandpiStore {
  constructor(
    private readonly pool: Pool,
    private readonly advisoryLockPool: Pool = pool,
  ) {}

  /**
   * Builds a lock-scoped Store whose direct queries and nested transactions
   * reuse the advisory-lock connection. A callback must not consume a second
   * pool connection while it pins the first one: enough concurrent lock
   * holders could otherwise exhaust the pool and wait on themselves forever.
   */
  private onClient(client: PoolClient) {
    const query = client.query.bind(client);
    const scopedClient = {
      query,
      release() {},
    };
    const scopedPool = {
      query,
      async connect() {
        return scopedClient;
      },
    };
    return new SandpiStore(
      scopedPool as unknown as Pool,
      scopedPool as unknown as Pool,
    );
  }

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
      `SELECT team.*, COUNT(all_members.id)::INTEGER AS member_count
       FROM teams team
       JOIN team_memberships viewer_membership
         ON viewer_membership.team_id = team.id
        AND viewer_membership.user_id = $1
        AND viewer_membership.status = 'active'
       LEFT JOIN team_memberships all_members
         ON all_members.team_id = team.id AND all_members.status = 'active'
       GROUP BY team.id
       ORDER BY team.created_at, team.id`,
      [userId],
    );
    const teams = teamsResult.rows.map(teamFromRow);
    const selectedTeam =
      teams.find((team) => team.id === requestedTeamId) ?? teams[0];
    if (!selectedTeam) {
      throw notFound("team_not_found", "The user does not belong to a Team.");
    }

    const membershipsResult = await this.pool.query<MembershipRow>(
      `SELECT membership.*, user_account.id AS user_id, user_account.email,
              user_account.name, user_account.avatar_initials
       FROM team_memberships membership
       JOIN users user_account ON user_account.id = membership.user_id
       WHERE membership.team_id = ANY($1::TEXT[])
       ORDER BY membership.joined_at, membership.id`,
      [teams.map((team) => team.id)],
    );
    const teamMemberships = membershipsResult.rows.map(membershipFromRow);
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
                session.environmentId === selectedEnvironment.id &&
                !session.archived,
            )
          : undefined;

    return {
      viewer: userFromRow(viewer),
      teams,
      viewerMemberships: teamMemberships.filter(
        (membership) => membership.user.id === userId,
      ),
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
      `${ENVIRONMENT_SELECT}
       JOIN team_memberships membership
         ON membership.team_id = environment.team_id
        AND membership.user_id = $1
        AND membership.status = 'active'
       WHERE environment.created_by_user_id = $1
         AND environment.status <> 'archived'
       ORDER BY environment.created_at, environment.id`,
      [userId],
    );
    return result.rows.map(environmentFromRow);
  }

  async getEnvironment(userId: string, environmentId: string) {
    const result = await this.pool.query<EnvironmentRow>(
      `${ENVIRONMENT_SELECT}
       JOIN team_memberships membership
         ON membership.team_id = environment.team_id
        AND membership.user_id = $1
        AND membership.status = 'active'
       WHERE environment.created_by_user_id = $1
         AND environment.id = $2 AND environment.status <> 'archived'`,
      [userId, environmentId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("environment_not_found", "Environment not found.");
    return environmentFromRow(row);
  }

  async getEnvironmentById(environmentId: string) {
    const result = await this.pool.query<EnvironmentRow>(
      `${ENVIRONMENT_SELECT}
       WHERE environment.id = $1 AND environment.status <> 'archived'`,
      [environmentId],
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
    if (!membership.rowCount) throw notFound("team_not_found", "Team not found.");
    const id = `env_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO environments (
           id, team_id, created_by_user_id, name, description, color, status,
           revision, template_id, credential_revision, harness,
           harness_metadata, network_policy, functions
         ) VALUES (
           $1, $2, $3, $4, '', '#151515', 'updating', 1, 'coding-agent', 0,
           'codex', '{"label":"Codex","status":"not-connected"}'::JSONB,
           '{"mode":"allow-all","domainExceptions":[]}'::JSONB,
           '[]'::JSONB
         )`,
        [id, input.teamId, input.userId, input.name],
      );
      await client.query(
        `INSERT INTO environment_runtime (
           environment_id, desired_state, observed_state
         ) VALUES ($1, 'running', 'provisioning')`,
        [id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.getEnvironment(input.userId, id);
  }

  async recordEnvironmentAllocation(
    environmentId: string,
    resources: Partial<ProvisionedEnvironment>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (resources.workspaceVolumeId) {
        await client.query(
          `UPDATE environments
           SET workspace_volume_id = COALESCE(workspace_volume_id, $2)
           WHERE id = $1
             AND (workspace_volume_id IS NULL OR workspace_volume_id = $2)`,
          [environmentId, resources.workspaceVolumeId],
        );
      }
      if (resources.sandboxId) {
        await client.query(
          `UPDATE environment_runtime
           SET sandbox_id = COALESCE(sandbox_id, $2),
               observed_state = 'provisioning', provisioning_error = NULL
           WHERE environment_id = $1
             AND (sandbox_id IS NULL OR sandbox_id = $2)`,
          [environmentId, resources.sandboxId],
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

  async clearEnvironmentSandboxAllocation(
    environmentId: string,
    sandboxId: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET sandbox_id = NULL, supervisor_session_id = NULL,
           terminal_session_id = NULL, attempt_id = NULL,
           supervisor_cursor = 0, stdout_tail = '', runtime_generation = 0,
           decoder_attempt_id = NULL, decoder_runtime_generation = 0,
           lifecycle_policy_version = 0, sandbox_hard_expires_at = NULL,
           idle_pause_due_at = NULL, lifecycle_error = NULL, paused_at = NULL
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [environmentId, sandboxId],
    );
  }

  async markEnvironmentReady(
    environmentId: string,
    resources: ProvisionedEnvironment,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE environments
         SET status = 'ready', template_id = COALESCE(template_id, 'coding-agent'),
             workspace_volume_id = $2,
             rootfs_snapshot_id = COALESCE($3, rootfs_snapshot_id),
             provisioning_error = NULL
         WHERE id = $1`,
        [
          environmentId,
          resources.workspaceVolumeId,
          resources.rootfsSnapshotId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO environment_runtime (
           environment_id, sandbox_id, desired_state, observed_state,
           lifecycle_policy_version, sandbox_hard_expires_at
         ) VALUES ($1, $2, 'running', 'running', $3, $4)
         ON CONFLICT (environment_id) DO UPDATE
         SET sandbox_id = EXCLUDED.sandbox_id,
             desired_state = 'running', observed_state = 'running',
             lifecycle_policy_version = EXCLUDED.lifecycle_policy_version,
             sandbox_hard_expires_at = EXCLUDED.sandbox_hard_expires_at,
             lifecycle_error = NULL, paused_at = NULL,
             provisioning_error = NULL`,
        [
          environmentId,
          resources.sandboxId,
          resources.hardExpiresAt
            ? ENVIRONMENT_LIFECYCLE_POLICY_VERSION
            : 0,
          resources.hardExpiresAt ?? null,
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

  async markEnvironmentFailed(environmentId: string, error: string) {
    await this.pool.query(
      `UPDATE environments SET status = 'error', provisioning_error = $2
       WHERE id = $1`,
      [environmentId, error],
    );
    await this.pool.query(
      `INSERT INTO environment_runtime (
         environment_id, desired_state, observed_state, provisioning_error
       ) VALUES ($1, 'running', 'failed', $2)
       ON CONFLICT (environment_id) DO UPDATE
       SET observed_state = 'failed', provisioning_error = EXCLUDED.provisioning_error`,
      [environmentId, error],
    );
  }

  async markEnvironmentProvisioning(userId: string, environmentId: string) {
    await this.getEnvironment(userId, environmentId);
    await this.pool.query(
      `UPDATE environments
       SET status = 'updating', provisioning_error = NULL
       WHERE id = $1`,
      [environmentId],
    );
    await this.pool.query(
      `INSERT INTO environment_runtime (
         environment_id, desired_state, observed_state
       ) VALUES ($1, 'running', 'provisioning')
       ON CONFLICT (environment_id) DO UPDATE
       SET desired_state = 'running', observed_state = 'provisioning',
           provisioning_error = NULL`,
      [environmentId],
    );
    return this.getEnvironment(userId, environmentId);
  }

  async environmentsNeedingProvisioning() {
    const result = await this.pool.query<{ id: string }>(
      `SELECT environment.id
       FROM environments environment
       LEFT JOIN environment_runtime runtime
         ON runtime.environment_id = environment.id
       WHERE environment.status IN ('updating', 'error')
         AND environment.status <> 'archived'
         AND (
           environment.workspace_volume_id IS NULL
           OR runtime.sandbox_id IS NULL
           OR runtime.observed_state <> 'running'
         )
       ORDER BY environment.created_at`,
    );
    return result.rows;
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
    await this.pool.query(
      `UPDATE environments
       SET name = $2, description = $3, color = $4,
           network_policy = $5::JSONB, revision = revision + 1
       WHERE id = $1`,
      [
        environmentId,
        input.name,
        input.description,
        input.color,
        JSON.stringify(input.networkPolicy),
      ],
    );
    return this.getEnvironment(userId, environmentId);
  }

  async prepareEnvironmentDeletion(userId: string, environmentId: string) {
    const environment = await this.getEnvironment(userId, environmentId);
    if (environment.status === "updating") {
      throw conflict(
        "environment_provisioning_in_progress",
        "Wait for Environment provisioning to finish before deleting it.",
      );
    }
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'terminated', idle_pause_due_at = NULL,
           lifecycle_error = NULL, version = version + 1
       WHERE environment_id = $1`,
      [environmentId],
    );
    return {
      sandboxId: environment.sandboxId || undefined,
      workspaceVolumeId: environment.workspaceVolumeId || undefined,
      rootfsSnapshotId: environment.rootfsSnapshotId || undefined,
    } satisfies Partial<ProvisionedEnvironment>;
  }

  async recordEnvironmentDeletionFailure(environmentId: string, error: string) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'terminated', observed_state = 'failed',
           lifecycle_error = $2, version = version + 1
       WHERE environment_id = $1`,
      [environmentId, error],
    );
  }

  async deleteEnvironmentMetadata(userId: string, environmentId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const authorized = await client.query(
        `SELECT environment.id
         FROM environments environment
         JOIN team_memberships membership
           ON membership.team_id = environment.team_id
          AND membership.user_id = $1
          AND membership.status = 'active'
         WHERE environment.id = $2
           AND environment.created_by_user_id = $1
           AND environment.status <> 'archived'
         FOR UPDATE`,
        [userId, environmentId],
      );
      if (!authorized.rowCount) {
        throw notFound("environment_not_found", "Environment not found.");
      }
      // Sessions are product references to harness-native Sessions in the
      // Environment Sandbox. Deleting the Environment intentionally removes
      // every active and archived reference before the parent row.
      await client.query("DELETE FROM sessions WHERE environment_id = $1", [
        environmentId,
      ]);
      // Remove the credential binding before its source credential. Both are
      // Environment-owned, but the binding deliberately RESTRICTs direct
      // credential deletion while a live Sandbox still references it.
      await client.query(
        "DELETE FROM environment_credential_bindings WHERE environment_id = $1",
        [environmentId],
      );
      await client.query("DELETE FROM environments WHERE id = $1", [
        environmentId,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEnvironmentRuntime(userId: string, environmentId: string) {
    await this.getEnvironment(userId, environmentId);
    return this.environmentRuntime(environmentId);
  }

  async environmentRuntime(environmentId: string): Promise<StoredEnvironmentRuntime> {
    const result = await this.pool.query<EnvironmentRuntimeRow>(
      `${ENVIRONMENT_RUNTIME_SELECT} WHERE runtime.environment_id = $1`,
      [environmentId],
    );
    const row = result.rows[0];
    if (!row?.sandbox_id || !row.workspace_volume_id) {
      throw notFound(
        "environment_runtime_not_ready",
        "Environment runtime is not ready.",
      );
    }
    return environmentRuntimeFromRow(row);
  }

  /**
   * Records a successful user runtime access and grants it a fresh idle
   * window. Sandbox0 remains authoritative for the native lifecycle; these
   * fields are only Sandpi's desired/observed projection.
   */
  async recordEnvironmentRuntimeAccess(environmentId: string) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'running',
           observed_state = 'running',
           idle_pause_due_at = GREATEST(
             COALESCE(idle_pause_due_at, NOW()),
             NOW() + ($2::BIGINT * INTERVAL '1 millisecond')
           ),
           lifecycle_error = NULL,
           paused_at = NULL,
           version = version + 1
       WHERE environment_id = $1
         AND desired_state <> 'terminated'`,
      [environmentId, ENVIRONMENT_IDLE_PAUSE_DELAY_MS],
    );
    return this.environmentRuntime(environmentId);
  }

  /**
   * Extends an already-running Environment's idle window without projecting a
   * paused Sandbox back to running. This is used only for live connection
   * heartbeats that do not themselves prove Sandbox0 auto-resumed.
   */
  async touchRunningEnvironmentRuntime(environmentId: string) {
    const result = await this.pool.query(
      `UPDATE environment_runtime
       SET idle_pause_due_at = GREATEST(
             COALESCE(idle_pause_due_at, NOW()),
             NOW() + ($2::BIGINT * INTERVAL '1 millisecond')
           ),
           version = version + 1
       WHERE environment_id = $1
         AND desired_state = 'running'
         AND observed_state = 'running'
       RETURNING environment_id`,
      [environmentId, ENVIRONMENT_IDLE_PAUSE_DELAY_MS],
    );
    return Boolean(result.rowCount);
  }

  /**
   * Elects one Sandpi server for an Environment lifecycle transition. The
   * session-scoped lock survives ordinary transactions and is automatically
   * released by PostgreSQL if the worker process or connection disappears.
   */
  async withEnvironmentLifecycleLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const client = await this.advisoryLockPool.connect();
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, hashtext($2)) AS acquired",
        [ENVIRONMENT_LIFECYCLE_LOCK_NAMESPACE, environmentId],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return { acquired: false };
      return {
        acquired: true,
        value: await operation(this.onClient(client)),
      };
    } finally {
      if (acquired) {
        await client
          .query("SELECT pg_advisory_unlock($1, hashtext($2))", [
            ENVIRONMENT_LIFECYCLE_LOCK_NAMESPACE,
            environmentId,
          ])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  /**
   * Serializes Environment-scoped MCP and effective-network-policy mutations.
   * Callers that also need the lifecycle lock must acquire this lock first.
   */
  async withEnvironmentMcpMutationLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const client = await this.advisoryLockPool.connect();
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, hashtext($2)) AS acquired",
        [ENVIRONMENT_MCP_MUTATION_LOCK_NAMESPACE, environmentId],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return { acquired: false };
      return {
        acquired: true,
        value: await operation(this.onClient(client)),
      };
    } finally {
      if (acquired) {
        await client
          .query("SELECT pg_advisory_unlock($1, hashtext($2))", [
            ENVIRONMENT_MCP_MUTATION_LOCK_NAMESPACE,
            environmentId,
          ])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  /**
   * Serializes every whole-file MCP OAuth credential synchronization for one
   * Environment. When combined with other locks, the order is MCP mutation,
   * Environment lifecycle, then OAuth credential. Nested locks must be taken
   * through the lock-scoped Store passed to the outer callback.
   */
  async withEnvironmentMcpOAuthCredentialLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<T> {
    const client = await this.advisoryLockPool.connect();
    let acquired = false;
    try {
      await client.query(
        "SELECT pg_advisory_lock($1, hashtext($2))",
        [ENVIRONMENT_MCP_OAUTH_CREDENTIAL_LOCK_NAMESPACE, environmentId],
      );
      acquired = true;
      return await operation(this.onClient(client));
    } finally {
      if (acquired) {
        await client
          .query("SELECT pg_advisory_unlock($1, hashtext($2))", [
            ENVIRONMENT_MCP_OAUTH_CREDENTIAL_LOCK_NAMESPACE,
            environmentId,
          ])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  /**
   * Serializes a user runtime operation with pause, recovery, and deletion
   * while still allowing independent Workspace requests to run concurrently.
   */
  async withEnvironmentRuntimeAccessLock<T>(
    environmentId: string,
    operation: (store: SandpiStore) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const client = await this.advisoryLockPool.connect();
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock_shared($1, hashtext($2)) AS acquired",
        [ENVIRONMENT_LIFECYCLE_LOCK_NAMESPACE, environmentId],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return { acquired: false };
      return {
        acquired: true,
        value: await operation(this.onClient(client)),
      };
    } finally {
      if (acquired) {
        await client
          .query("SELECT pg_advisory_unlock_shared($1, hashtext($2))", [
            ENVIRONMENT_LIFECYCLE_LOCK_NAMESPACE,
            environmentId,
          ])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  async environmentLifecyclePolicyCandidateIds(limit = 50) {
    const result = await this.pool.query<{ environment_id: string }>(
      `SELECT runtime.environment_id
       FROM environment_runtime runtime
       JOIN environments environment ON environment.id = runtime.environment_id
       WHERE environment.status = 'ready'
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.lifecycle_policy_version < $1
         AND (
           runtime.lifecycle_error IS NULL
           OR runtime.updated_at <= NOW() - INTERVAL '1 minute'
         )
       ORDER BY runtime.created_at, runtime.environment_id
       LIMIT $2`,
      [ENVIRONMENT_LIFECYCLE_POLICY_VERSION, limit],
    );
    return result.rows.map((row) => row.environment_id);
  }

  async prepareEnvironmentLifecyclePolicy(environmentId: string) {
    const target = new Date(
      Date.now() + ENVIRONMENT_SANDBOX_HARD_TTL_SECONDS * 1_000,
    );
    const result = await this.pool.query<{ environment_id: string }>(
      `UPDATE environment_runtime
       SET sandbox_hard_expires_at = COALESCE(sandbox_hard_expires_at, $2),
           lifecycle_error = NULL
       WHERE environment_id = $1 AND sandbox_id IS NOT NULL
         AND lifecycle_policy_version < $3
       RETURNING environment_id`,
      [environmentId, target, ENVIRONMENT_LIFECYCLE_POLICY_VERSION],
    );
    if (!result.rowCount) return undefined;
    return this.environmentRuntime(environmentId);
  }

  async recordEnvironmentLifecyclePolicy(
    environmentId: string,
    sandboxId: string,
    hardExpiresAt: Date,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET lifecycle_policy_version = $3,
           sandbox_hard_expires_at = $4,
           lifecycle_error = NULL, version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [
        environmentId,
        sandboxId,
        ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
        hardExpiresAt,
      ],
    );
  }

  async recordEnvironmentLifecycleError(
    environmentId: string,
    sandboxId: string,
    error: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET lifecycle_error = $3, version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [environmentId, sandboxId, error],
    );
  }

  async environmentIdlePauseCandidateIds(limit = 50) {
    const result = await this.pool.query<{ environment_id: string }>(
      `SELECT runtime.environment_id
       FROM environment_runtime runtime
       JOIN environments environment ON environment.id = runtime.environment_id
       WHERE environment.status = 'ready'
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.idle_pause_due_at <= NOW()
         AND runtime.desired_state IN ('running', 'paused')
         AND runtime.observed_state <> 'paused'
       ORDER BY runtime.idle_pause_due_at, runtime.environment_id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.environment_id);
  }

  /** Rechecks the native Turn projection while holding the advisory lock. */
  async prepareEnvironmentIdlePause(environmentId: string) {
    const result = await this.pool.query<{ environment_id: string }>(
      `UPDATE environment_runtime runtime
       SET desired_state = 'paused', lifecycle_error = NULL,
           version = version + 1
       WHERE runtime.environment_id = $1
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.idle_pause_due_at <= NOW()
         AND runtime.desired_state IN ('running', 'paused')
         AND runtime.observed_state <> 'paused'
         AND NOT EXISTS (
           SELECT 1
           FROM sessions session
           JOIN session_runtime session_state
             ON session_state.session_id = session.id
           WHERE session.environment_id = runtime.environment_id
             AND session.archived = FALSE
             AND (
               session.status IN ('provisioning', 'running')
               OR session_state.active_native_turn_id IS NOT NULL
               OR session_state.pending_turn_phase IS NOT NULL
             )
         )
       RETURNING runtime.environment_id`,
      [environmentId],
    );
    if (!result.rowCount) return undefined;
    return this.environmentRuntime(environmentId);
  }

  async recordEnvironmentPaused(environmentId: string, sandboxId: string) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'paused', observed_state = 'paused',
           idle_pause_due_at = NULL, lifecycle_error = NULL,
           paused_at = NOW(), version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [environmentId, sandboxId],
    );
  }

  async recordEnvironmentPauseFailure(
    environmentId: string,
    sandboxId: string,
    error: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'paused', observed_state = 'failed',
           idle_pause_due_at = $3, lifecycle_error = $4,
           version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [
        environmentId,
        sandboxId,
        new Date(Date.now() + ENVIRONMENT_PAUSE_RETRY_DELAY_MS),
        error,
      ],
    );
  }

  async environmentWantsRunning(environmentId: string) {
    const result = await this.pool.query<{ desired_state: string }>(
      `SELECT desired_state FROM environment_runtime WHERE environment_id = $1`,
      [environmentId],
    );
    return result.rows[0]?.desired_state === "running";
  }

  async environmentRuntimeRecoveryCandidateIds() {
    const result = await this.pool.query<{ environment_id: string }>(
      `SELECT runtime.environment_id
       FROM environment_runtime runtime
       JOIN environments environment ON environment.id = runtime.environment_id
       WHERE environment.status = 'ready'
         AND runtime.desired_state = 'running'
         AND runtime.sandbox_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM sessions session
           JOIN session_runtime session_state
             ON session_state.session_id = session.id
           WHERE session.environment_id = runtime.environment_id
             AND session.archived = FALSE
             AND (
               session.status IN ('provisioning', 'running')
               OR session_state.active_native_turn_id IS NOT NULL
               OR session_state.pending_turn_phase IS NOT NULL
             )
         )`,
    );
    return result.rows.map((row) => row.environment_id);
  }

  async recordCodexEnvironmentRuntime(
    environmentId: string,
    recovered: RecoveredCodexEnvironmentRuntime,
  ) {
    const result = await this.pool.query<EnvironmentRuntimeRow>(
      `UPDATE environment_runtime runtime
       SET supervisor_session_id = $2,
           supervisor_cursor = CASE
             WHEN supervisor_session_id IS DISTINCT FROM $2 THEN 0
             ELSE supervisor_cursor
           END,
           stdout_tail = CASE
             WHEN supervisor_session_id IS DISTINCT FROM $2 THEN ''
             ELSE stdout_tail
           END,
           decoder_attempt_id = CASE
             WHEN supervisor_session_id IS DISTINCT FROM $2 THEN $3
             ELSE decoder_attempt_id
           END,
           decoder_runtime_generation = CASE
             WHEN supervisor_session_id IS DISTINCT FROM $2 THEN $4
             ELSE decoder_runtime_generation
           END,
           attempt_id = $3, runtime_generation = $4,
           idle_pause_due_at = CASE
             WHEN last_turn_completed_at IS NOT NULL
               AND (runtime.observed_state <> 'running' OR $5::BOOLEAN)
             THEN GREATEST(
               last_turn_completed_at + ($6::BIGINT * INTERVAL '1 millisecond'),
               NOW() + ($6::BIGINT * INTERVAL '1 millisecond')
             )
             ELSE idle_pause_due_at
           END,
           desired_state = 'running', observed_state = 'running',
           lifecycle_error = NULL, paused_at = NULL,
           provisioning_error = NULL,
           version = version + 1
       FROM environments environment
       WHERE runtime.environment_id = $1
         AND environment.id = runtime.environment_id
       RETURNING runtime.*, environment.workspace_volume_id`,
      [
        environmentId,
        recovered.supervisorSessionId,
        recovered.attemptId,
        recovered.runtimeGeneration,
        recovered.sandboxRestarted,
        ENVIRONMENT_IDLE_PAUSE_DELAY_MS,
      ],
    );
    const row = result.rows[0];
    if (!row) throw notFound("environment_not_found", "Environment not found.");
    return environmentRuntimeFromRow(row);
  }

  async commitEnvironmentTransport(
    environmentId: string,
    supervisorSessionId: string,
    attemptId: string | undefined,
    runtimeGeneration: number,
    before: CodexDecoderState,
    after: CodexDecoderState,
    transitions: readonly CodexControlTransition[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const committed = await client.query(
        `UPDATE environment_runtime
         SET supervisor_cursor = $6, stdout_tail = $7,
             decoder_attempt_id = $8,
             decoder_runtime_generation = $9,
             last_event_at = NOW(), version = version + 1
         WHERE environment_id = $1 AND supervisor_session_id = $2
           AND attempt_id IS NOT DISTINCT FROM $3
           AND runtime_generation = $4
           AND supervisor_cursor = $5
           AND desired_state = 'running'
           AND observed_state = 'running'
         RETURNING environment_id`,
        [
          environmentId,
          supervisorSessionId,
          attemptId ?? null,
          runtimeGeneration,
          before.supervisorCursor,
          after.supervisorCursor,
          after.tailBase64,
          after.attemptId ?? null,
          after.runtimeGeneration,
        ],
      );
      if (!committed.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const transition of transitions) {
        if (transition.type === "turnStarted") {
          await client.query(
            `UPDATE session_runtime runtime
             SET active_native_turn_id = $3,
                 pending_turn_phase = CASE
                   WHEN pending_turn_phase IS NULL THEN NULL ELSE 'accepted'
                 END,
                 pending_turn_native_turn_id = CASE
                   WHEN pending_turn_phase IS NULL THEN NULL ELSE $3
                 END,
                 version = version + 1
             FROM sessions session
             WHERE runtime.session_id = session.id
               AND session.environment_id = $1
               AND runtime.native_session_id = $2`,
            [environmentId, transition.nativeSessionId, transition.nativeTurnId],
          );
          await client.query(
            `UPDATE sessions session
             SET status = 'running'
             FROM session_runtime runtime
             WHERE runtime.session_id = session.id
               AND session.environment_id = $1
               AND runtime.native_session_id = $2`,
            [environmentId, transition.nativeSessionId],
          );
          continue;
        }
        await client.query(
          `UPDATE session_runtime runtime
           SET active_native_turn_id = NULL,
               pending_turn_request_id = NULL,
               pending_turn_client_message_id = NULL,
               pending_turn_stable_input_id = NULL,
               pending_turn_phase = NULL,
               pending_turn_native_turn_id = NULL,
               pending_turn_started_at = NULL,
               version = version + 1
           FROM sessions session
           WHERE runtime.session_id = session.id
             AND session.environment_id = $1
             AND runtime.native_session_id = $2
             AND (runtime.active_native_turn_id IS NULL
                  OR runtime.active_native_turn_id = $3)`,
          [environmentId, transition.nativeSessionId, transition.nativeTurnId],
        );
        await client.query(
          `UPDATE sessions session
           SET status = CASE WHEN status = 'failed' THEN status ELSE 'waiting' END,
               unread = TRUE
           FROM session_runtime runtime
           WHERE runtime.session_id = session.id
             AND session.environment_id = $1
             AND runtime.native_session_id = $2`,
          [environmentId, transition.nativeSessionId],
        );
      }
      const latestCompletedAt = transitions.reduce<Date | undefined>(
        (latest, transition) =>
          transition.type === "turnCompleted" &&
          (!latest || transition.completedAt > latest)
            ? transition.completedAt
            : latest,
        undefined,
      );
      if (latestCompletedAt) {
        await client.query(
          `UPDATE environment_runtime
           SET last_turn_completed_at = CASE
                 WHEN last_turn_completed_at IS NULL
                   OR last_turn_completed_at < $2 THEN $2
                 ELSE last_turn_completed_at
               END,
               idle_pause_due_at = (
                 CASE
                   WHEN last_turn_completed_at IS NULL
                     OR last_turn_completed_at < $2 THEN $2
                   ELSE last_turn_completed_at
                 END
               ) + ($3::BIGINT * INTERVAL '1 millisecond'),
               version = version + 1
           WHERE environment_id = $1`,
          [
            environmentId,
            latestCompletedAt,
            ENVIRONMENT_IDLE_PAUSE_DELAY_MS,
          ],
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

  async resetEnvironmentDecoder(environmentId: string, cursor: number) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET supervisor_cursor = $2, stdout_tail = '', version = version + 1
       WHERE environment_id = $1`,
      [environmentId, Math.max(0, cursor)],
    );
  }

  async setEnvironmentTerminalSession(
    environmentId: string,
    terminalSessionId: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime SET terminal_session_id = $2
       WHERE environment_id = $1`,
      [environmentId, terminalSessionId],
    );
  }

  async listSessions(userId: string): Promise<CodingSession[]> {
    const result = await this.pool.query<SessionRow>(
      `${SESSION_SELECT}
       WHERE membership.user_id = $1 AND membership.status = 'active'
         AND session.created_by_user_id = $1
       ORDER BY session.pinned DESC, session.updated_at DESC`,
      [userId],
    );
    return result.rows.map(sessionFromRow);
  }

  async getSession(userId: string, sessionId: string): Promise<CodingSession> {
    const result = await this.pool.query<SessionRow>(
      `${SESSION_SELECT}
       WHERE membership.user_id = $1 AND membership.status = 'active'
         AND session.created_by_user_id = $1 AND session.id = $2`,
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
    return this.insertSessionMetadata({ ...input, kind: "environment" });
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
    return this.insertSessionMetadata({
      userId: input.userId,
      environment: input.environment,
      title:
        input.title ??
        `${input.source.title} (${input.kind === "turn" ? "turn fork" : "fork"})`,
      modelId: input.modelId,
      kind: input.kind ?? "session",
      originLabel: input.source.title,
      sourceSessionId: input.source.id,
      sourceNativeItemId: input.sourceNativeItemId,
    });
  }

  private async insertSessionMetadata(input: {
    userId: string;
    environment: Environment;
    title: string;
    modelId?: string;
    kind: "environment" | "session" | "turn";
    originLabel?: string;
    sourceSessionId?: string;
    sourceNativeItemId?: string;
  }) {
    const id = `session_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions (
           id, team_id, environment_id, created_by_user_id, title, status,
           harness, harness_state, metadata, environment_revision,
           origin_kind, origin_label, source_session_id, source_native_item_id
         ) VALUES (
           $1, $2, $3, $4, $5, 'provisioning', 'codex', $6::JSONB,
           $7::JSONB, $8, $9, $10, $11, $12
         )`,
        [
          id,
          input.environment.teamId,
          input.environment.id,
          input.userId,
          input.title,
          JSON.stringify({ protocol: "codex-app-server" }),
          JSON.stringify({ modelId: input.modelId ?? null }),
          input.environment.revision,
          input.kind,
          input.originLabel ?? input.environment.name,
          input.sourceSessionId ?? null,
          input.sourceNativeItemId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO session_runtime (session_id, model_id)
         VALUES ($1, $2)`,
        [id, input.modelId ?? null],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSessionNativeReady(
    sessionId: string,
    nativeSessionId: string,
    options: {
      expectedNativeSessionId?: string;
      expectedHistoryRevision?: number;
      incrementHistoryRevision?: boolean;
      status?: "waiting" | "running";
    } = {},
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runtime = await client.query(
        `UPDATE session_runtime
         SET native_session_id = $2,
             history_revision = history_revision + CASE WHEN $5 THEN 1 ELSE 0 END,
             runtime_error_code = NULL, version = version + 1
         WHERE session_id = $1
           AND ($3::TEXT IS NULL OR native_session_id = $3)
           AND ($4::BIGINT IS NULL OR history_revision = $4)
         RETURNING session_id`,
        [
          sessionId,
          nativeSessionId,
          options.expectedNativeSessionId ?? null,
          options.expectedHistoryRevision ?? null,
          options.incrementHistoryRevision ?? false,
        ],
      );
      if (!runtime.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE sessions SET status = $2 WHERE id = $1`,
        [sessionId, options.status ?? "waiting"],
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
   * Reconciles the scalar active-Turn projection from one authoritative native
   * Thread response. The runtime version compare-and-swap prevents a snapshot
   * from overwriting a concurrent Turn admission or native event.
   */
  async reconcileNativeSessionState(input: {
    sessionId: string;
    nativeSessionId: string;
    historyRevision: number;
    runtimeVersion: number;
    environmentId: string;
    environmentSupervisorSessionId?: string;
    environmentAttemptId?: string;
    environmentRuntimeGeneration: number;
    activeNativeTurnId?: string;
    clearPendingWhenNativeIdle?: boolean;
    clearPendingRequestId?: string;
    clearPendingStartedBefore?: Date;
    requireUnarchived?: boolean;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const environment = await client.query<{ environment_id: string }>(
        `SELECT environment_id
         FROM environment_runtime
         WHERE environment_id = $1
           AND supervisor_session_id IS NOT DISTINCT FROM $2
           AND attempt_id IS NOT DISTINCT FROM $3
           AND runtime_generation = $4
           AND desired_state = 'running'
           AND observed_state = 'running'
         FOR SHARE`,
        [
          input.environmentId,
          input.environmentSupervisorSessionId ?? null,
          input.environmentAttemptId ?? null,
          input.environmentRuntimeGeneration,
        ],
      );
      if (!environment.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const current = await client.query<{
        active_native_turn_id: string | null;
        pending_turn_request_id: string | null;
        pending_turn_phase: TurnSubmissionPhase | null;
        pending_turn_started_at: Date | null;
      }>(
        `SELECT runtime.active_native_turn_id,
                runtime.pending_turn_request_id,
                runtime.pending_turn_phase,
                runtime.pending_turn_started_at
         FROM session_runtime runtime
         JOIN sessions session ON session.id = runtime.session_id
         WHERE runtime.session_id = $1 AND runtime.native_session_id = $2
           AND runtime.history_revision = $3 AND runtime.version = $4
           AND session.environment_id = $5
         FOR UPDATE OF runtime`,
        [
          input.sessionId,
          input.nativeSessionId,
          input.historyRevision,
          input.runtimeVersion,
          input.environmentId,
        ],
      );
      const projection = current.rows[0];
      if (!projection) {
        await client.query("ROLLBACK");
        return false;
      }
      // Lock order is Environment runtime, Session runtime, then Session
      // metadata. Rechecking archived under the final row lock prevents a
      // background repair selected before an archive from mutating it later.
      const session = await client.query(
        `SELECT id FROM sessions
         WHERE id = $1 AND environment_id = $2
           AND ($3::BOOLEAN = FALSE OR archived = FALSE)
         FOR UPDATE`,
        [
          input.sessionId,
          input.environmentId,
          input.requireUnarchived ?? false,
        ],
      );
      if (!session.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const activeNativeTurnId = input.activeNativeTurnId ?? null;
      const pendingRecoveryEligible =
        (input.clearPendingRequestId !== undefined &&
          projection.pending_turn_request_id ===
            input.clearPendingRequestId) ||
        (input.clearPendingStartedBefore !== undefined &&
          projection.pending_turn_started_at !== null &&
          projection.pending_turn_started_at.getTime() <=
            input.clearPendingStartedBefore.getTime());
      const clearPending =
        input.clearPendingWhenNativeIdle === true &&
        activeNativeTurnId === null &&
        projection.pending_turn_phase !== null &&
        pendingRecoveryEligible;
      if (clearPending) {
        await client.query(
          `UPDATE session_runtime
           SET active_native_turn_id = NULL,
               pending_turn_request_id = NULL,
               pending_turn_client_message_id = NULL,
               pending_turn_stable_input_id = NULL,
               pending_turn_phase = NULL,
               pending_turn_native_turn_id = NULL,
               pending_turn_started_at = NULL,
               version = version + 1
           WHERE session_id = $1`,
          [input.sessionId],
        );
      } else if (projection.active_native_turn_id !== activeNativeTurnId) {
        await client.query(
          `UPDATE session_runtime
           SET active_native_turn_id = $2, version = version + 1
           WHERE session_id = $1`,
          [input.sessionId, activeNativeTurnId],
        );
      }
      const status =
        activeNativeTurnId ||
        (!clearPending && projection.pending_turn_phase)
          ? "running"
          : "waiting";
      await client.query(
        `UPDATE sessions SET status = $2
         WHERE id = $1 AND status <> 'failed' AND status IS DISTINCT FROM $2`,
        [input.sessionId, status],
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

  async markSessionFailed(sessionId: string, error: string) {
    await this.pool.query(
      `UPDATE sessions SET status = 'failed', metadata = metadata || $2::JSONB
       WHERE id = $1`,
      [sessionId, JSON.stringify({ provisioningError: error })],
    );
    await this.pool.query(
      `UPDATE session_runtime
       SET runtime_error_code = 'native_session_failed', version = version + 1
       WHERE session_id = $1`,
      [sessionId],
    );
  }

  async getSessionRuntime(userId: string, sessionId: string) {
    await this.getSession(userId, sessionId);
    return this.sessionRuntime(sessionId);
  }

  async sessionRuntime(sessionId: string): Promise<StoredSessionRuntime> {
    const result = await this.pool.query<SessionRuntimeRow>(
      `${SESSION_RUNTIME_SELECT} WHERE runtime.session_id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("session_not_found", "Session not found.");
    return sessionRuntimeFromRow(row);
  }

  async environmentIdForSession(userId: string, sessionId: string) {
    const session = await this.getSession(userId, sessionId);
    return session.environmentId;
  }

  async sessionIdsForEnvironment(environmentId: string) {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM sessions
       WHERE environment_id = $1 AND status <> 'failed' AND archived = FALSE`,
      [environmentId],
    );
    return result.rows.map((row) => row.id);
  }

  async nativeSessionRecoveryCandidatesForEnvironment(environmentId: string) {
    const result = await this.pool.query<SessionRuntimeRow>(
      `${SESSION_RUNTIME_SELECT}
       WHERE session.environment_id = $1
         AND session.archived = FALSE
         AND session.status <> 'failed'
         AND runtime.native_session_id IS NOT NULL
         AND (
           runtime.active_native_turn_id IS NOT NULL
           OR runtime.pending_turn_phase IS NOT NULL
           OR (
             session.status = 'running'
             AND runtime.active_native_turn_id IS NULL
             AND runtime.pending_turn_phase IS NULL
           )
         )
       ORDER BY runtime.updated_at, runtime.session_id`,
      [environmentId],
    );
    return result.rows.map(sessionRuntimeFromRow);
  }

  async sessionIdForNativeThread(
    environmentId: string,
    nativeSessionId: string,
  ) {
    const result = await this.pool.query<{ session_id: string }>(
      `SELECT runtime.session_id
       FROM session_runtime runtime
       JOIN sessions session ON session.id = runtime.session_id
       WHERE session.environment_id = $1 AND runtime.native_session_id = $2`,
      [environmentId, nativeSessionId],
    );
    return result.rows[0]?.session_id;
  }

  async beginSessionTurn(
    userId: string,
    sessionId: string,
    modelId: string | undefined,
    submission: TurnSubmissionCoordinates,
  ) {
    await this.getSession(userId, sessionId);
    const deadline = Date.now() + 130_000;
    while (true) {
      const client = await this.pool.connect();
      let retry = false;
      try {
        await client.query("BEGIN");
        const session = await client.query<{ environment_id: string }>(
          "SELECT environment_id FROM sessions WHERE id = $1",
          [sessionId],
        );
        const environmentId = session.rows[0]?.environment_id;
        if (!environmentId) {
          throw notFound("session_not_found", "Session not found.");
        }
        // Try instead of queueing a PostgreSQL connection behind a potentially
        // slow Sandbox0 pause. No connection is held during backoff.
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS acquired",
          [ENVIRONMENT_LIFECYCLE_LOCK_NAMESPACE, environmentId],
        );
        if (lock.rows[0]?.acquired !== true) {
          await client.query("ROLLBACK");
          retry = true;
        } else {
          // Keep the row-lock order aligned with native event commits and
          // snapshot reconciliation: Environment runtime, Session runtime,
          // then Session metadata.
          await client.query(
            `UPDATE environment_runtime
             SET desired_state = 'running', lifecycle_error = NULL,
                 version = version + 1
             WHERE environment_id = $1`,
            [environmentId],
          );
          const metadata = await client.query<{ archived: boolean }>(
            "SELECT archived FROM sessions WHERE id = $1",
            [sessionId],
          );
          if (metadata.rows[0]?.archived) {
            throw conflict(
              "session_archived",
              "Unarchive this Session before starting a Codex Turn.",
            );
          }
          // Once pending delivery is durable, an idle worker must observe it
          // and defer pause before any native harness write occurs.
          const result = await client.query(
            `UPDATE session_runtime runtime
             SET model_id = COALESCE($2, model_id),
                 pending_turn_request_id = $3,
                 pending_turn_client_message_id = $4,
                 pending_turn_stable_input_id = $5,
                 pending_turn_phase = 'prepared',
                 pending_turn_started_at = NOW(),
                 version = version + 1
             FROM sessions session
             WHERE runtime.session_id = $1 AND session.id = runtime.session_id
               AND session.status = 'waiting'
               AND session.archived = FALSE
               AND runtime.native_session_id IS NOT NULL
               AND runtime.active_native_turn_id IS NULL
               AND runtime.pending_turn_phase IS NULL
             RETURNING runtime.session_id`,
            [
              sessionId,
              modelId ?? null,
              submission.requestId,
              submission.clientMessageId,
              submission.stableInputId,
            ],
          );
          if (!result.rowCount) {
            throw new HttpError(
              409,
              "session_turn_in_progress",
              "Wait for the current Codex Turn to finish.",
            );
          }
          await client.query(
            "UPDATE sessions SET status = 'running' WHERE id = $1",
            [sessionId],
          );
          await client.query("COMMIT");
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (!retry) return;
      if (Date.now() >= deadline) {
        throw new HttpError(
          503,
          "environment_lifecycle_busy",
          "The Environment is still changing lifecycle state. Try again.",
        );
      }
      await delayWithoutDatabaseConnection(250);
    }
  }

  async markTurnSubmitted(sessionId: string, requestId: string) {
    await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = 'submitted', version = version + 1
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase = 'prepared'`,
      [sessionId, requestId],
    );
  }

  async markTurnAccepted(
    sessionId: string,
    requestId: string,
    nativeTurnId: string,
  ) {
    await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = 'accepted',
           pending_turn_native_turn_id = $3,
           active_native_turn_id = COALESCE(active_native_turn_id, $3),
           version = version + 1
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase IN ('prepared', 'submitted', 'accepted')`,
      [sessionId, requestId, nativeTurnId],
    );
  }

  async abandonTurn(sessionId: string, requestId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const abandoned = await client.query(
        `UPDATE session_runtime
         SET pending_turn_request_id = NULL,
             pending_turn_client_message_id = NULL,
             pending_turn_stable_input_id = NULL,
             pending_turn_phase = NULL,
             pending_turn_native_turn_id = NULL,
             pending_turn_started_at = NULL,
             active_native_turn_id = NULL,
             version = version + 1
         WHERE session_id = $1 AND pending_turn_request_id = $2
         RETURNING session_id`,
        [sessionId, requestId],
      );
      if (abandoned.rowCount) {
        await client.query(
          `UPDATE sessions SET status = 'waiting'
           WHERE id = $1 AND status = 'running'`,
          [sessionId],
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
    if (changes.archived === true) {
      await this.archiveIdleSession(sessionId, changes);
      return this.getSession(userId, sessionId);
    }
    const result = await this.pool.query(
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
    if (!result.rowCount) throw notFound("session_not_found", "Session not found.");
    return this.getSession(userId, sessionId);
  }

  private async archiveIdleSession(
    sessionId: string,
    changes: {
      title?: string;
      pinned?: boolean;
      unread?: boolean;
    },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ environment_id: string }>(
        "SELECT environment_id FROM sessions WHERE id = $1",
        [sessionId],
      );
      const environmentId = owner.rows[0]?.environment_id;
      if (!environmentId) {
        throw notFound("session_not_found", "Session not found.");
      }
      // Match Turn/event/reconciliation lock order so archive cannot cross a
      // concurrent delivery boundary: Environment, Session runtime, metadata.
      await client.query(
        `SELECT environment_id FROM environment_runtime
         WHERE environment_id = $1 FOR SHARE`,
        [environmentId],
      );
      const runtime = await client.query<{
        active_native_turn_id: string | null;
        pending_turn_phase: TurnSubmissionPhase | null;
      }>(
        `SELECT active_native_turn_id, pending_turn_phase
         FROM session_runtime WHERE session_id = $1 FOR UPDATE`,
        [sessionId],
      );
      const metadata = await client.query<{ status: string }>(
        "SELECT status FROM sessions WHERE id = $1 FOR UPDATE",
        [sessionId],
      );
      const state = runtime.rows[0];
      const status = metadata.rows[0]?.status;
      if (
        !state ||
        !status ||
        status === "provisioning" ||
        status === "running" ||
        state.active_native_turn_id !== null ||
        state.pending_turn_phase !== null
      ) {
        throw conflict(
          "session_archive_in_progress",
          "Wait for the current Codex Turn to finish before archiving this Session.",
        );
      }
      await client.query(
        `UPDATE sessions
         SET title = COALESCE($2, title), pinned = COALESCE($3, pinned),
             archived = TRUE, unread = COALESCE($4, unread)
         WHERE id = $1`,
        [
          sessionId,
          changes.title ?? null,
          changes.pinned ?? null,
          changes.unread ?? null,
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

  async withTerminalAccess<T>(
    userId: string,
    environmentId: string,
    operation: (runtime: StoredEnvironmentRuntime) => Promise<T> | T,
  ) {
    return operation(await this.getEnvironmentRuntime(userId, environmentId));
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
      `UPDATE user_preferences
       SET language = $2, time_zone = $3, send_shortcut = $4,
           theme = $5, density = $6, notify_session_completed = $7,
           notify_needs_attention = $8
       WHERE user_id = $1`,
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
      `UPDATE team_memberships
       SET plan_id = $3,
           plan_quotas = jsonb_set(
             jsonb_set(
               jsonb_set(plan_quotas, '{weeklyExecution,limit}', to_jsonb($4::INTEGER)),
               '{concurrentSessions,limit}', to_jsonb($5::INTEGER)
             ),
             '{snapshotStorage,limit}', to_jsonb($6::INTEGER)
           )
       WHERE id = $2 AND team_id = $1
       RETURNING *`,
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
    return membershipFromRow({
      ...row,
      user_id: row.user_id,
      email: user.rows[0].email,
      name: user.rows[0].name,
      avatar_initials: user.rows[0].avatar_initials,
    });
  }
}

const ENVIRONMENT_SELECT = `
  SELECT environment.*, runtime.sandbox_id, runtime.supervisor_session_id,
         runtime.observed_state AS sandbox_state
  FROM environments environment
  LEFT JOIN environment_runtime runtime
    ON runtime.environment_id = environment.id
`;

const ENVIRONMENT_RUNTIME_SELECT = `
  SELECT runtime.*, environment.workspace_volume_id
  FROM environment_runtime runtime
  JOIN environments environment ON environment.id = runtime.environment_id
`;

const SESSION_SELECT = `
  SELECT session.*, runtime.native_session_id, runtime.model_id,
         runtime.history_revision
  FROM sessions session
  JOIN team_memberships membership ON membership.team_id = session.team_id
  LEFT JOIN session_runtime runtime ON runtime.session_id = session.id
`;

const SESSION_RUNTIME_SELECT = `
  SELECT runtime.*, session.environment_id, session.status
  FROM session_runtime runtime
  JOIN sessions session ON session.id = runtime.session_id
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
    sandboxId: row.sandbox_id ?? "",
    sandboxState:
      row.sandbox_state ??
      (row.status === "error"
        ? "failed"
        : row.status === "updating"
          ? "provisioning"
          : "pending"),
    supervisorSessionId: row.supervisor_session_id ?? "",
    workspaceRoot: "/workspace",
    credentialRevision: row.credential_revision,
    codingAgent: {
      harness: row.harness,
      label: typeof metadata.label === "string" ? metadata.label : "Codex",
      status: metadata.status === "connected" ? "connected" : "not-connected",
      account: typeof metadata.account === "string" ? metadata.account : undefined,
      lastVerified: parseUnixTimestamp(metadata.lastVerified),
    },
    networkPolicy: row.network_policy,
    functions: row.functions,
    provisioningError: row.provisioning_error ?? undefined,
  };
}

function environmentRuntimeFromRow(
  row: EnvironmentRuntimeRow,
): StoredEnvironmentRuntime {
  return {
    id: row.environment_id,
    sandboxId: row.sandbox_id!,
    workspaceVolumeId: row.workspace_volume_id!,
    supervisorSessionId: row.supervisor_session_id ?? undefined,
    terminalSessionId: row.terminal_session_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    runtimeGeneration: Number(row.runtime_generation),
    decoder: {
      supervisorCursor: Number(row.supervisor_cursor),
      tailBase64: row.stdout_tail,
      attemptId: row.decoder_attempt_id ?? row.attempt_id ?? undefined,
      runtimeGeneration: Number(
        row.decoder_runtime_generation ?? row.runtime_generation,
      ),
    },
    version: Number(row.version),
    desiredState: row.desired_state,
    observedState: row.observed_state,
    provisioningError: row.provisioning_error ?? undefined,
    lifecyclePolicyVersion: Number(row.lifecycle_policy_version),
    hardExpiresAt: row.sandbox_hard_expires_at ?? undefined,
    lastTurnCompletedAt: row.last_turn_completed_at ?? undefined,
    idlePauseDueAt: row.idle_pause_due_at ?? undefined,
    lifecycleError: row.lifecycle_error ?? undefined,
    pausedAt: row.paused_at ?? undefined,
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
  return {
    id: row.id,
    environmentId: row.environment_id,
    title: row.title,
    status: publicSessionStatus(row.status),
    unread: row.unread,
    pinned: row.pinned,
    archived: row.archived,
    harness: "codex",
    harnessLabel: "Codex",
    harnessState,
    createdAt: toUnixTimestamp(row.created_at),
    updatedAt: toUnixTimestamp(row.updated_at),
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
  };
}

function sessionRuntimeFromRow(row: SessionRuntimeRow): StoredSessionRuntime {
  return {
    sessionId: row.session_id,
    environmentId: row.environment_id,
    nativeSessionId: row.native_session_id ?? undefined,
    modelId: row.model_id ?? undefined,
    historyRevision: Number(row.history_revision),
    activeNativeTurnId: row.active_native_turn_id ?? undefined,
    pendingTurnRequestId: row.pending_turn_request_id ?? undefined,
    pendingTurnClientMessageId: row.pending_turn_client_message_id ?? undefined,
    pendingTurnStableInputId: row.pending_turn_stable_input_id ?? undefined,
    pendingTurnPhase: row.pending_turn_phase ?? undefined,
    pendingTurnNativeTurnId: row.pending_turn_native_turn_id ?? undefined,
    pendingTurnStartedAt: row.pending_turn_started_at ?? undefined,
    runtimeErrorCode: row.runtime_error_code ?? undefined,
    version: Number(row.version),
    sessionStatus:
      row.status === "provisioning"
        ? "provisioning"
        : publicSessionStatus(row.status),
  };
}

function delayWithoutDatabaseConnection(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function publicSessionStatus(value: string): CodingSession["status"] {
  if (value === "running") return "running";
  if (value === "paused") return "paused";
  if (value === "failed") return "failed";
  if (value === "completed") return "completed";
  return "waiting";
}
