import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CodexHarnessState } from "@/harnesses/codex/types";
import type {
  CodingSession,
  Environment,
  EnvironmentPauseInterval,
  EnvironmentWorkspaceBackup,
  NetworkPolicy,
  SandpiBootstrap,
  SandpiCloudSnapshot,
  SandpiDeploymentSummary,
  SandpiPreferences,
  SandpiUser,
} from "@/lib/types";
import type {
  EnvironmentCredentialProjection,
  EnvironmentCredentialResolverKind,
  EnvironmentCredentialRule,
  EnvironmentCredentialStatus,
  EnvironmentEgressCredential,
  EnvironmentEgressCredentialConfiguration,
} from "@/lib/environment-credentials";
import { parseUnixTimestamp, toUnixTimestamp } from "@/lib/time";
import { conflict, HttpError, notFound } from "@/server/http-error";
import {
  ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
  ENVIRONMENT_PAUSE_RETRY_DELAY_MS,
} from "@/server/environments/lifecycle-policy";
import type { CodexDecoderState } from "@/server/harnesses/codex/jsonl";
import type {
  EnvironmentRuntimeRecord,
  ProvisionedEnvironment,
  RecoveredCodexEnvironmentRuntime,
  RuntimeWorkspaceBackupSnapshot,
} from "@/server/runtime/types";

export interface EnvironmentRecord extends Environment {
  provisioningError?: string;
}

export interface StoredEnvironmentEgressCredential
  extends EnvironmentEgressCredential {
  /** Opaque Sandbox0 source name. This value is never returned to browsers. */
  sourceRef: string;
}

export type TurnSubmissionPhase = "prepared" | "submitted" | "accepted";

export interface TurnSubmissionCoordinates {
  requestId: string;
  clientMessageId: string;
  stableInputId: string;
}

export interface IdempotentResourceState {
  status: "processing" | "completed" | "failed";
  resourceId: string;
  responseStatus?: number;
  responseBody?: Record<string, unknown>;
}

export interface IdempotentResourceClaim extends IdempotentResourceState {
  claimed: boolean;
}

export interface StoredEnvironmentRuntime extends EnvironmentRuntimeRecord {
  /**
   * Derived from the active Environment credential revision and its Sandbox
   * materialization binding. It is not a second copy of credential state.
   */
  codexCredentialBindingCurrent?: boolean;
  version: number;
  desiredState: "running" | "paused" | "terminated";
  provisioningError?: string;
  lifecyclePolicyVersion: number;
  lastTurnCompletedAt?: Date;
  idlePauseDueAt?: Date;
  lifecycleError?: string;
  pausedAt?: Date;
}

export interface PreparedEnvironmentWorkspaceBackup {
  runtime: StoredEnvironmentRuntime;
  createBackup: boolean;
  retentionCount: number;
}

export interface PreparedEnvironmentWorkspaceRestore {
  runtime: StoredEnvironmentRuntime;
  backup: EnvironmentWorkspaceBackup;
  resumeAfterRestore: boolean;
}

export const WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR =
  "workspace_restored_session_unavailable";

export interface StoredSessionRuntime {
  sessionId: string;
  environmentId: string;
  nativeSessionId?: string;
  modelId?: string;
  reasoningEffort?: string;
  historyRevision: number;
  activeNativeTurnId?: string;
  activeTurnAttemptId?: string;
  activeTurnRuntimeGeneration?: number;
  pendingTurnRequestId?: string;
  pendingTurnClientMessageId?: string;
  pendingTurnStableInputId?: string;
  pendingTurnPhase?: TurnSubmissionPhase;
  pendingTurnNativeTurnId?: string;
  pendingTurnStartedAt?: Date;
  pendingTurnAttemptId?: string;
  pendingTurnRuntimeGeneration?: number;
  interruptRequestedNativeTurnId?: string;
  recoverySourceNativeTurnId?: string;
  recoveryPromptVersion?: number;
  recoveryAttemptCount: number;
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
  created_by_user_id: string;
  idle_pause_timeout_seconds: number;
  sandbox_memory_mib: number;
  workspace_backup_interval_seconds: number;
  workspace_backup_retention_count: number;
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
  provisioning_error: string | null;
  sandbox_id: string | null;
  supervisor_session_id: string | null;
  workspace_backup_due_at: Date | null;
  workspace_backup_last_completed_at: Date | null;
  workspace_backup_error: string | null;
}

interface EnvironmentEgressCredentialRow extends QueryResultRow {
  id: string;
  environment_id: string;
  display_name: string;
  source_ref: string;
  resolver_kind: EnvironmentCredentialResolverKind;
  projection: EnvironmentCredentialProjection;
  rule: EnvironmentCredentialRule;
  enabled: boolean;
  status: EnvironmentCredentialStatus;
  source_version: string | number | null;
  source_status: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SessionRow extends QueryResultRow {
  id: string;
  environment_id: string;
  title: string;
  status: string;
  unread: boolean;
  pinned: boolean;
  completed: boolean;
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
  reasoning_effort: string | null;
  history_revision: string | number | null;
  owner_id: string | null;
  owner_email: string | null;
  owner_name: string | null;
  owner_avatar_initials: string | null;
}

interface IdempotencyKeyRow extends QueryResultRow {
  request_hash: Buffer;
  status: IdempotentResourceState["status"];
  resource_id: string | null;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
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
  provisioning_error: string | null;
  lifecycle_policy_version: string | number;
  last_turn_completed_at: Date | null;
  idle_pause_due_at: Date | null;
  lifecycle_error: string | null;
  paused_at: Date | null;
  version: string | number;
  credential_revision?: string | number;
  bound_credential_revision?: string | number | null;
  credential_binding_status?: "active" | "stale" | "revoked" | null;
}

interface EnvironmentPauseIntervalRow extends QueryResultRow {
  paused_at: Date;
  resumed_at: Date | null;
  reason: EnvironmentPauseInterval["reason"];
}

interface EnvironmentWorkspaceBackupRow extends QueryResultRow {
  snapshot_id: string;
  environment_id: string;
  workspace_volume_id: string;
  name: string;
  size_bytes: string | number;
  backup_kind: EnvironmentWorkspaceBackup["kind"];
  created_at: Date;
}

interface SessionRuntimeRow extends QueryResultRow {
  session_id: string;
  environment_id: string;
  native_session_id: string | null;
  model_id: string | null;
  reasoning_effort: string | null;
  history_revision: string | number;
  active_native_turn_id: string | null;
  active_turn_attempt_id: string | null;
  active_turn_runtime_generation: string | number | null;
  pending_turn_request_id: string | null;
  pending_turn_client_message_id: string | null;
  pending_turn_stable_input_id: string | null;
  pending_turn_phase: TurnSubmissionPhase | null;
  pending_turn_native_turn_id: string | null;
  pending_turn_started_at: Date | null;
  pending_turn_attempt_id: string | null;
  pending_turn_runtime_generation: string | number | null;
  interrupt_requested_native_turn_id: string | null;
  recovery_source_native_turn_id: string | null;
  recovery_prompt_version: string | number | null;
  recovery_attempt_count: string | number;
  runtime_error_code: string | null;
  version: string | number;
  status: string;
}

// Shared with transaction-scoped Turn admission and session-scoped lifecycle
// workers. The second advisory-lock key is hashtext(Environment.id).
const ENVIRONMENT_LIFECYCLE_LOCK_NAMESPACE = 1_907_424_101;

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

    const environments = await this.listEnvironments(userId);
    const sessions = await this.listSessions(userId);
    const preferences = await this.getPreferences(userId);
    const requestedSession = requestedSessionId
      ? sessions.find(
          (session) => session.id === requestedSessionId && !session.archived,
        )
      : undefined;
    const requestedSessionEnvironment = requestedSession
      ? environments.find(
          (environment) => environment.id === requestedSession.environmentId,
        )
      : undefined;
    const requestedEnvironment = requestedEnvironmentId
      ? environments.find(
          (environment) => environment.id === requestedEnvironmentId,
        )
      : undefined;
    const selectedEnvironment =
      requestedSessionEnvironment ?? requestedEnvironment ?? environments[0];
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
      deployment,
      environments,
      sessions,
      preferences,
      selectedEnvironmentId: selectedEnvironment?.id ?? "",
      selectedSessionId: selectedSession?.id ?? "",
    };
  }

  async getCloudSnapshot(userId: string): Promise<SandpiCloudSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const store = this.onClient(client);
      const environments = (await store.listEnvironments(userId)).map(
        (environment) => {
          const { sandboxState, ...cloudState } = environment;
          void sandboxState;
          return cloudState;
        },
      );
      const sessions = await store.listSessions(userId);
      const preferences = await store.getPreferences(userId);
      await client.query("COMMIT");
      return { environments, sessions, preferences };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listEnvironments(userId: string): Promise<EnvironmentRecord[]> {
    const result = await this.pool.query<EnvironmentRow>(
      `${ENVIRONMENT_SELECT}
       WHERE environment.status <> 'archived'
         AND environment.created_by_user_id = $1
       ORDER BY environment.display_order, environment.id`,
      [userId],
    );
    return result.rows.map(environmentFromRow);
  }

  async reorderEnvironments(userId: string, environmentIds: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`sandpi:environment-limit:${userId}`],
      );
      const owned = await client.query<{ id: string }>(
        `SELECT id
         FROM environments
         WHERE created_by_user_id = $1 AND status <> 'archived'
         FOR UPDATE`,
        [userId],
      );
      const ownedIds = new Set(owned.rows.map(({ id }) => id));
      if (
        ownedIds.size !== environmentIds.length ||
        environmentIds.some((id) => !ownedIds.has(id))
      ) {
        throw conflict(
          "environment_order_mismatch",
          "Environment order must contain every accessible Environment exactly once.",
        );
      }
      await client.query(
        `UPDATE environments environment
         SET display_order = (ordered.ordinality - 1)::INTEGER
         FROM UNNEST($2::TEXT[]) WITH ORDINALITY
              AS ordered(id, ordinality)
         WHERE environment.created_by_user_id = $1
           AND environment.id = ordered.id`,
        [userId, environmentIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEnvironment(userId: string, environmentId: string) {
    const result = await this.pool.query<EnvironmentRow>(
      `${ENVIRONMENT_SELECT}
       WHERE environment.id = $2 AND environment.status <> 'archived'
         AND environment.created_by_user_id = $1`,
      [userId, environmentId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("environment_not_found", "Environment not found.");
    return environmentFromRow(row);
  }

  async getManageableEnvironment(userId: string, environmentId: string) {
    const result = await this.pool.query<EnvironmentRow>(
      `${ENVIRONMENT_SELECT}
       WHERE environment.id = $2 AND environment.status <> 'archived'
         AND environment.created_by_user_id = $1`,
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

  async listEnvironmentEgressCredentials(
    userId: string,
    environmentId: string,
  ): Promise<StoredEnvironmentEgressCredential[]> {
    await this.getManageableEnvironment(userId, environmentId);
    return this.listEnvironmentEgressCredentialsByEnvironmentId(environmentId);
  }

  async listEnvironmentEgressCredentialsByEnvironmentId(
    environmentId: string,
  ): Promise<StoredEnvironmentEgressCredential[]> {
    const result = await this.pool.query<EnvironmentEgressCredentialRow>(
      `${ENVIRONMENT_EGRESS_CREDENTIAL_SELECT}
       WHERE credential.environment_id = $1
       ORDER BY credential.created_at, credential.id`,
      [environmentId],
    );
    return result.rows.map(environmentEgressCredentialFromRow);
  }

  async getEnvironmentEgressCredential(
    userId: string,
    environmentId: string,
    credentialId: string,
  ): Promise<StoredEnvironmentEgressCredential> {
    await this.getManageableEnvironment(userId, environmentId);
    return this.getEnvironmentEgressCredentialById(
      environmentId,
      credentialId,
    );
  }

  async getEnvironmentEgressCredentialById(
    environmentId: string,
    credentialId: string,
  ): Promise<StoredEnvironmentEgressCredential> {
    const result = await this.pool.query<EnvironmentEgressCredentialRow>(
      `${ENVIRONMENT_EGRESS_CREDENTIAL_SELECT}
       WHERE credential.environment_id = $1 AND credential.id = $2`,
      [environmentId, credentialId],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound(
        "environment_credential_not_found",
        "Environment credential not found.",
      );
    }
    return environmentEgressCredentialFromRow(row);
  }

  async createEnvironmentEgressCredential(
    environmentId: string,
    input: EnvironmentEgressCredentialConfiguration & {
      id: string;
      sourceRef: string;
    },
  ): Promise<StoredEnvironmentEgressCredential> {
    try {
      await this.pool.query(
        `INSERT INTO environment_egress_credentials (
           id, environment_id, display_name, source_ref, resolver_kind,
           projection, rule, enabled, status
         ) VALUES ($1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, $8, 'provisioning')`,
        [
          input.id,
          environmentId,
          input.name,
          input.sourceRef,
          input.resolverKind,
          JSON.stringify(input.projection),
          JSON.stringify(input.rule),
          input.enabled,
        ],
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === "23505") {
        throw conflict(
          "environment_credential_name_conflict",
          "An Environment credential already uses this name.",
        );
      }
      throw error;
    }
    return this.getEnvironmentEgressCredentialById(environmentId, input.id);
  }

  async updateEnvironmentEgressCredentialConfiguration(
    environmentId: string,
    credentialId: string,
    input: EnvironmentEgressCredentialConfiguration,
  ): Promise<StoredEnvironmentEgressCredential> {
    try {
      const result = await this.pool.query(
        `UPDATE environment_egress_credentials
         SET display_name = $3, projection = $4::JSONB, rule = $5::JSONB,
             enabled = $6, status = 'provisioning', last_error = NULL
         WHERE environment_id = $1 AND id = $2 AND resolver_kind = $7`,
        [
          environmentId,
          credentialId,
          input.name,
          JSON.stringify(input.projection),
          JSON.stringify(input.rule),
          input.enabled,
          input.resolverKind,
        ],
      );
      if (!result.rowCount) {
        throw notFound(
          "environment_credential_not_found",
          "Environment credential not found.",
        );
      }
    } catch (error) {
      if ((error as { code?: unknown }).code === "23505") {
        throw conflict(
          "environment_credential_name_conflict",
          "An Environment credential already uses this name.",
        );
      }
      throw error;
    }
    return this.getEnvironmentEgressCredentialById(
      environmentId,
      credentialId,
    );
  }

  async recordEnvironmentEgressCredentialSource(
    environmentId: string,
    credentialId: string,
    metadata: { currentVersion?: number; status?: string },
  ) {
    const result = await this.pool.query(
      `UPDATE environment_egress_credentials
       SET source_version = $3, source_status = $4,
           status = 'provisioning', last_error = NULL
       WHERE environment_id = $1 AND id = $2`,
      [
        environmentId,
        credentialId,
        metadata.currentVersion ?? null,
        metadata.status ?? null,
      ],
    );
    if (!result.rowCount) {
      throw notFound(
        "environment_credential_not_found",
        "Environment credential not found.",
      );
    }
  }

  async recordEnvironmentEgressCredentialStatus(
    environmentId: string,
    credentialId: string,
    status: EnvironmentCredentialStatus,
    error?: string,
  ) {
    const result = await this.pool.query(
      `UPDATE environment_egress_credentials
       SET status = $3, last_error = $4
       WHERE environment_id = $1 AND id = $2`,
      [environmentId, credentialId, status, error ?? null],
    );
    if (!result.rowCount) {
      throw notFound(
        "environment_credential_not_found",
        "Environment credential not found.",
      );
    }
  }

  async recordEnvironmentEgressCredentialSourceMissing(
    environmentId: string,
    credentialId: string,
    error: string,
  ) {
    const result = await this.pool.query(
      `UPDATE environment_egress_credentials
       SET source_version = NULL, source_status = NULL,
           status = 'error', last_error = $3
       WHERE environment_id = $1 AND id = $2`,
      [environmentId, credentialId, error],
    );
    if (!result.rowCount) {
      throw notFound(
        "environment_credential_not_found",
        "Environment credential not found.",
      );
    }
  }

  async deleteEnvironmentEgressCredentialRecord(
    environmentId: string,
    credentialId: string,
  ) {
    await this.pool.query(
      `DELETE FROM environment_egress_credentials
       WHERE environment_id = $1 AND id = $2`,
      [environmentId, credentialId],
    );
  }

  async environmentEgressCredentialReconciliationIds() {
    const result = await this.pool.query<{ environment_id: string }>(
      `SELECT DISTINCT environment_id
       FROM environment_egress_credentials
       WHERE status IN ('provisioning', 'error', 'deleting')
       ORDER BY environment_id`,
    );
    return result.rows.map((row) => row.environment_id);
  }

  async createEnvironmentMetadata(input: {
    userId: string;
    name: string;
    sandboxMemoryMiB: number;
    environmentLimit?: number | null;
  }) {
    const id = `env_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`sandpi:environment-limit:${input.userId}`],
      );
      if (input.environmentLimit != null) {
        const count = await client.query<{ count: string }>(
          `SELECT COUNT(*)::TEXT AS count
           FROM environments
           WHERE created_by_user_id = $1 AND status <> 'archived'`,
          [input.userId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= input.environmentLimit) {
          throw new HttpError(
            429,
            "environment_plan_limit",
            `The current plan allows ${input.environmentLimit} Environment${input.environmentLimit === 1 ? "" : "s"}.`,
            { environmentLimit: input.environmentLimit },
          );
        }
      }
      await client.query(
        `INSERT INTO environments (
           id, created_by_user_id, name, description, color, status,
           revision, template_id, credential_revision, harness,
           harness_metadata, network_policy, sandbox_memory_mib,
           display_order
         ) VALUES (
           $1, $2, $3, '', '#151515', 'updating', 1, 'coding-agent', 0,
           'codex', '{"label":"Codex","status":"not-connected"}'::JSONB,
           '{"mode":"allow-all","domainExceptions":[]}'::JSONB, $4,
           (SELECT COALESCE(MAX(display_order), -1) + 1
            FROM environments
            WHERE created_by_user_id = $2)
         )`,
        [id, input.userId, input.name, input.sandboxMemoryMiB],
      );
      await client.query(
        `INSERT INTO environment_runtime (
           environment_id, desired_state
         ) VALUES ($1, 'running')`,
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
               provisioning_error = NULL
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
           lifecycle_policy_version = 0,
           idle_pause_due_at = NULL, lifecycle_error = NULL, paused_at = NULL,
           workspace_backup_due_at = NULL,
           workspace_backup_retry_at = NULL,
           workspace_backup_error = NULL
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
           environment_id, sandbox_id, desired_state,
           lifecycle_policy_version, idle_pause_due_at,
           workspace_backup_due_at
         )
         SELECT $1, $2, 'running', $3,
                CASE
                  WHEN environment.idle_pause_timeout_seconds = 0 THEN NULL
                  ELSE NOW() + (
                    environment.idle_pause_timeout_seconds::BIGINT
                    * INTERVAL '1 second'
                  )
                END,
                CASE
                  WHEN environment.workspace_backup_interval_seconds = 0
                    THEN NULL
                  ELSE NOW() + (
                    environment.workspace_backup_interval_seconds::BIGINT
                    * INTERVAL '1 second'
                  )
                END
         FROM environments environment
         WHERE environment.id = $1
         ON CONFLICT (environment_id) DO UPDATE
         SET sandbox_id = EXCLUDED.sandbox_id,
             desired_state = 'running',
             lifecycle_policy_version = EXCLUDED.lifecycle_policy_version,
             idle_pause_due_at = EXCLUDED.idle_pause_due_at,
             workspace_backup_due_at = EXCLUDED.workspace_backup_due_at,
             workspace_backup_retry_at = NULL,
             workspace_backup_error = NULL,
             lifecycle_error = NULL, paused_at = NULL,
             provisioning_error = NULL`,
        [
          environmentId,
          resources.sandboxId,
          ENVIRONMENT_LIFECYCLE_POLICY_VERSION,
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
         environment_id, desired_state, provisioning_error
       ) VALUES ($1, 'running', $2)
       ON CONFLICT (environment_id) DO UPDATE
       SET provisioning_error = EXCLUDED.provisioning_error`,
      [environmentId, error],
    );
  }

  async markEnvironmentProvisioning(userId: string, environmentId: string) {
    await this.getManageableEnvironment(userId, environmentId);
    await this.pool.query(
      `UPDATE environments
       SET status = 'updating', provisioning_error = NULL
       WHERE id = $1`,
      [environmentId],
    );
    await this.pool.query(
      `INSERT INTO environment_runtime (
         environment_id, desired_state
       ) VALUES ($1, 'running')
       ON CONFLICT (environment_id) DO UPDATE
       SET desired_state = 'running', provisioning_error = NULL`,
      [environmentId],
    );
    return this.getManageableEnvironment(userId, environmentId);
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
      idlePauseTimeoutSeconds: number;
      sandboxMemoryMiB: number;
      workspaceBackup: Pick<
        Environment["workspaceBackup"],
        "intervalSeconds" | "retentionCount"
      >;
      networkPolicy: NetworkPolicy;
    },
  ) {
    const current = await this.getManageableEnvironment(userId, environmentId);
    const timeoutChanged =
      current.idlePauseTimeoutSeconds !== input.idlePauseTimeoutSeconds;
    const backupIntervalChanged =
      current.workspaceBackup.intervalSeconds !==
      input.workspaceBackup.intervalSeconds;
    const backupPolicyChanged =
      backupIntervalChanged ||
      current.workspaceBackup.retentionCount !==
        input.workspaceBackup.retentionCount;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE environments
         SET name = $2, description = $3, color = $4,
             idle_pause_timeout_seconds = $5,
             sandbox_memory_mib = $6,
             workspace_backup_interval_seconds = $7,
             workspace_backup_retention_count = $8,
             network_policy = $9::JSONB,
             revision = revision + 1
         WHERE id = $1`,
        [
          environmentId,
          input.name,
          input.description,
          input.color,
          input.idlePauseTimeoutSeconds,
          input.sandboxMemoryMiB,
          input.workspaceBackup.intervalSeconds,
          input.workspaceBackup.retentionCount,
          JSON.stringify(input.networkPolicy),
        ],
      );
      if (timeoutChanged) {
        await client.query(
          `UPDATE environment_runtime
           SET idle_pause_due_at = CASE
                 WHEN $2::INTEGER = 0 THEN NULL
                 WHEN desired_state = 'running'
                 THEN NOW() + ($2::BIGINT * INTERVAL '1 second')
                 ELSE idle_pause_due_at
               END,
               lifecycle_error = CASE
                 WHEN desired_state = 'running' THEN NULL
                 ELSE lifecycle_error
               END,
               version = version + 1
           WHERE environment_id = $1`,
          [environmentId, input.idlePauseTimeoutSeconds],
        );
      }
      if (backupPolicyChanged) {
        await client.query(
          `UPDATE environment_runtime
           SET workspace_backup_due_at = CASE
                 WHEN $2::INTEGER = 0 THEN NULL
                 WHEN $3::BOOLEAN OR workspace_backup_due_at IS NULL
                 THEN NOW() + ($2::BIGINT * INTERVAL '1 second')
                 ELSE workspace_backup_due_at
               END,
               workspace_backup_retry_at = NULL,
               workspace_backup_error = NULL,
               version = version + 1
           WHERE environment_id = $1`,
          [
            environmentId,
            input.workspaceBackup.intervalSeconds,
            backupIntervalChanged,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.getManageableEnvironment(userId, environmentId);
  }

  async updateEnvironmentSandboxMemory(
    environmentId: string,
    sandboxMemoryMiB: number,
  ) {
    await this.pool.query(
      `UPDATE environments
       SET sandbox_memory_mib = $2, revision = revision + 1
       WHERE id = $1 AND sandbox_memory_mib <> $2`,
      [environmentId, sandboxMemoryMiB],
    );
  }

  async prepareEnvironmentDeletion(userId: string, environmentId: string) {
    const environment = await this.getManageableEnvironment(
      userId,
      environmentId,
    );
    if (environment.status === "updating") {
      throw conflict(
        "environment_provisioning_in_progress",
        "Wait for Environment provisioning to finish before deleting it.",
      );
    }
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'terminated', idle_pause_due_at = NULL,
           lifecycle_error = NULL, workspace_backup_due_at = NULL,
           workspace_backup_retry_at = NULL,
           workspace_backup_error = NULL, version = version + 1
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
       SET desired_state = 'terminated', lifecycle_error = $2,
           version = version + 1
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

  /**
   * Returns the historical projection of Sandpi-owned idle pauses that overlap
   * a metrics window. The caller must authorize the Environment first.
   */
  async environmentPauseIntervals(
    environmentId: string,
    startedAt: Date,
    endedAt: Date,
  ): Promise<EnvironmentPauseInterval[]> {
    const result = await this.pool.query<EnvironmentPauseIntervalRow>(
      `SELECT paused_at, resumed_at, reason
       FROM environment_pause_intervals
       WHERE environment_id = $1
         AND paused_at < $3
         AND (resumed_at IS NULL OR resumed_at > $2)
       ORDER BY paused_at`,
      [environmentId, startedAt, endedAt],
    );
    return result.rows.map((row) => ({
      startedAt: toUnixTimestamp(row.paused_at),
      ...(row.resumed_at ? { endedAt: toUnixTimestamp(row.resumed_at) } : {}),
      reason: row.reason,
    }));
  }

  async environmentRuntime(
    environmentId: string,
  ): Promise<StoredEnvironmentRuntime> {
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
   * window. Sandbox0 remains authoritative for the native lifecycle; this
   * stores only Sandpi's lifecycle intent and pause-action history.
   */
  async recordEnvironmentRuntimeAccess(environmentId: string) {
    await this.pool.query(
      `UPDATE environment_runtime runtime
       SET desired_state = 'running',
           idle_pause_due_at = CASE
             WHEN environment.idle_pause_timeout_seconds = 0 THEN NULL
             ELSE GREATEST(
               COALESCE(runtime.idle_pause_due_at, NOW()),
               NOW() + (
                 environment.idle_pause_timeout_seconds::BIGINT
                 * INTERVAL '1 second'
               )
             )
           END,
           lifecycle_error = NULL,
           paused_at = NULL,
           version = version + 1
       FROM environments environment
       WHERE runtime.environment_id = $1
         AND environment.id = runtime.environment_id
         AND runtime.desired_state <> 'terminated'`,
      [environmentId],
    );
  }

  /**
   * Extends an Environment's idle window only while Sandpi still wants it
   * running. This is used for throttled live user activity and never changes
   * Sandbox0 lifecycle state.
   */
  async touchRunningEnvironmentActivity(environmentId: string) {
    const result = await this.pool.query(
      `UPDATE environment_runtime runtime
       SET idle_pause_due_at = CASE
             WHEN environment.idle_pause_timeout_seconds = 0 THEN NULL
             ELSE GREATEST(
               COALESCE(runtime.idle_pause_due_at, NOW()),
               NOW() + (
                 environment.idle_pause_timeout_seconds::BIGINT
                 * INTERVAL '1 second'
               )
             )
           END,
           version = version + 1
       FROM environments environment
       WHERE runtime.environment_id = $1
         AND environment.id = runtime.environment_id
         AND runtime.desired_state = 'running'
       RETURNING runtime.environment_id`,
      [environmentId],
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
    const result = await this.pool.query<{ environment_id: string }>(
      `UPDATE environment_runtime
       SET lifecycle_error = NULL
       WHERE environment_id = $1 AND sandbox_id IS NOT NULL
         AND lifecycle_policy_version < $2
       RETURNING environment_id`,
      [environmentId, ENVIRONMENT_LIFECYCLE_POLICY_VERSION],
    );
    if (!result.rowCount) return undefined;
    return this.environmentRuntime(environmentId);
  }

  async recordEnvironmentLifecyclePolicy(
    environmentId: string,
    sandboxId: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET lifecycle_policy_version = $3,
           lifecycle_error = NULL, version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [environmentId, sandboxId, ENVIRONMENT_LIFECYCLE_POLICY_VERSION],
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

  async environmentWorkspaceBackupCandidateIds(limit = 50) {
    const result = await this.pool.query<{ environment_id: string }>(
      `SELECT runtime.environment_id
       FROM environment_runtime runtime
       JOIN environments environment ON environment.id = runtime.environment_id
       WHERE environment.status = 'ready'
         AND environment.workspace_volume_id IS NOT NULL
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.desired_state <> 'terminated'
         AND NOT EXISTS (
           SELECT 1
           FROM sessions session
           JOIN session_runtime session_state
             ON session_state.session_id = session.id
           WHERE session.environment_id = runtime.environment_id
             AND (
               session.status IN ('provisioning', 'running')
               OR session_state.active_native_turn_id IS NOT NULL
               OR session_state.pending_turn_phase IS NOT NULL
             )
         )
         AND (
           runtime.workspace_backup_retry_at IS NULL
           OR runtime.workspace_backup_retry_at <= NOW()
         )
         AND (
           (
             environment.workspace_backup_interval_seconds > 0
             AND (
               runtime.workspace_backup_due_at IS NULL
               OR runtime.workspace_backup_due_at <= NOW()
             )
           )
           OR (
             SELECT COUNT(*)
             FROM environment_workspace_backups backup
             WHERE backup.environment_id = runtime.environment_id
           ) > environment.workspace_backup_retention_count
         )
       ORDER BY COALESCE(
                  runtime.workspace_backup_retry_at,
                  runtime.workspace_backup_due_at,
                  runtime.created_at
                ),
                runtime.environment_id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.environment_id);
  }

  /** Rechecks backup policy and publishes a short crash-recovery lease. */
  async prepareEnvironmentWorkspaceBackup(
    environmentId: string,
    forceCreate = false,
  ): Promise<PreparedEnvironmentWorkspaceBackup | undefined> {
    const result = await this.pool.query<{
      create_backup: boolean;
      retention_count: number;
    }>(
      `UPDATE environment_runtime runtime
       SET workspace_backup_retry_at = NOW() + INTERVAL '1 minute',
           workspace_backup_error = NULL,
           version = version + 1
       FROM environments environment
       WHERE runtime.environment_id = $1
         AND environment.id = runtime.environment_id
         AND environment.status = 'ready'
         AND environment.workspace_volume_id IS NOT NULL
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.desired_state <> 'terminated'
         AND NOT EXISTS (
           SELECT 1
           FROM sessions session
           JOIN session_runtime session_state
             ON session_state.session_id = session.id
           WHERE session.environment_id = runtime.environment_id
             AND (
               session.status IN ('provisioning', 'running')
               OR session_state.active_native_turn_id IS NOT NULL
               OR session_state.pending_turn_phase IS NOT NULL
             )
         )
         AND (
           $2::BOOLEAN
           OR (
             (
               runtime.workspace_backup_retry_at IS NULL
               OR runtime.workspace_backup_retry_at <= NOW()
             )
             AND (
               (
                 environment.workspace_backup_interval_seconds > 0
                 AND (
                   runtime.workspace_backup_due_at IS NULL
                   OR runtime.workspace_backup_due_at <= NOW()
                 )
               )
               OR (
                 SELECT COUNT(*)
                 FROM environment_workspace_backups backup
                 WHERE backup.environment_id = runtime.environment_id
               ) > environment.workspace_backup_retention_count
             )
           )
         )
       RETURNING
         (
           $2::BOOLEAN
           OR (
             environment.workspace_backup_interval_seconds > 0
             AND (
               runtime.workspace_backup_due_at IS NULL
               OR runtime.workspace_backup_due_at <= NOW()
             )
           )
         ) AS create_backup,
         environment.workspace_backup_retention_count AS retention_count`,
      [environmentId, forceCreate],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      runtime: await this.environmentRuntime(environmentId),
      createBackup: row.create_backup,
      retentionCount: row.retention_count,
    };
  }

  async recordEnvironmentWorkspaceBackup(
    environmentId: string,
    sandboxId: string,
    snapshot: RuntimeWorkspaceBackupSnapshot,
    kind: EnvironmentWorkspaceBackup["kind"],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO environment_workspace_backups (
           snapshot_id, environment_id, workspace_volume_id, name,
           size_bytes, backup_kind, created_at
         )
         SELECT $2, $1, environment.workspace_volume_id, $3, $4, $5, $6
         FROM environments environment
         WHERE environment.id = $1
           AND environment.workspace_volume_id IS NOT NULL`,
        [
          environmentId,
          snapshot.id,
          snapshot.name,
          snapshot.sizeBytes,
          kind,
          snapshot.createdAt,
        ],
      );
      const updated = await client.query(
        `UPDATE environment_runtime runtime
         SET workspace_backup_due_at = CASE
               WHEN environment.workspace_backup_interval_seconds = 0 THEN NULL
               ELSE NOW() + (
                 environment.workspace_backup_interval_seconds::BIGINT
                 * INTERVAL '1 second'
               )
             END,
             workspace_backup_last_completed_at = $3,
             workspace_backup_retry_at = NULL,
             workspace_backup_error = NULL,
             version = version + 1
         FROM environments environment
         WHERE runtime.environment_id = $1
           AND environment.id = runtime.environment_id
           AND runtime.sandbox_id = $2`,
        [environmentId, sandboxId, snapshot.createdAt],
      );
      if (!updated.rowCount) {
        throw conflict(
          "environment_runtime_changed",
          "The Environment runtime changed while its Workspace backup was being recorded.",
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

  async recordEnvironmentWorkspaceBackupFailure(
    environmentId: string,
    sandboxId: string,
    error: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET workspace_backup_retry_at = NOW() + INTERVAL '1 minute',
           workspace_backup_error = $3,
           version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [environmentId, sandboxId, error.slice(0, 2_000)],
    );
  }

  async recordEnvironmentWorkspaceBackupHealthy(
    environmentId: string,
    sandboxId: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET workspace_backup_retry_at = NULL,
           workspace_backup_error = NULL,
           version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [environmentId, sandboxId],
    );
  }

  async listEnvironmentWorkspaceBackups(
    userId: string,
    environmentId: string,
    limit = 30,
  ): Promise<EnvironmentWorkspaceBackup[]> {
    await this.getEnvironment(userId, environmentId);
    const result = await this.pool.query<EnvironmentWorkspaceBackupRow>(
      `SELECT snapshot_id, environment_id, workspace_volume_id, name,
              size_bytes, backup_kind, created_at
       FROM environment_workspace_backups
       WHERE environment_id = $1
       ORDER BY created_at DESC, snapshot_id DESC
       LIMIT $2`,
      [environmentId, limit],
    );
    return result.rows.map(environmentWorkspaceBackupFromRow);
  }

  async assertEnvironmentWorkspaceQuiescent(environmentId: string) {
    const result = await this.pool.query<{ busy: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM sessions session
         JOIN session_runtime runtime ON runtime.session_id = session.id
         WHERE session.environment_id = $1
           AND (
             session.status IN ('provisioning', 'running')
             OR runtime.active_native_turn_id IS NOT NULL
             OR runtime.pending_turn_phase IS NOT NULL
           )
       ) AS busy`,
      [environmentId],
    );
    if (result.rows[0]?.busy) {
      throw conflict(
        "environment_workspace_busy",
        "Wait for every running Turn and Session operation in this Environment to finish.",
      );
    }
  }

  async prepareEnvironmentWorkspaceRestore(
    environmentId: string,
    snapshotId: string,
  ): Promise<PreparedEnvironmentWorkspaceRestore> {
    const backupResult = await this.pool.query<EnvironmentWorkspaceBackupRow>(
      `SELECT snapshot_id, environment_id, workspace_volume_id, name,
              size_bytes, backup_kind, created_at
       FROM environment_workspace_backups
       WHERE environment_id = $1 AND snapshot_id = $2`,
      [environmentId, snapshotId],
    );
    const backupRow = backupResult.rows[0];
    if (!backupRow) {
      throw notFound(
        "environment_workspace_backup_not_found",
        "Workspace backup not found.",
      );
    }
    const runtime = await this.environmentRuntime(environmentId);
    if (runtime.desiredState === "terminated") {
      throw conflict(
        "environment_terminated",
        "The Environment is being deleted.",
      );
    }
    if (backupRow.workspace_volume_id !== runtime.workspaceVolumeId) {
      throw conflict(
        "environment_workspace_backup_stale",
        "This backup belongs to an older Workspace Volume and cannot be restored into the current Environment.",
      );
    }
    await this.assertEnvironmentWorkspaceQuiescent(environmentId);
    return {
      runtime,
      backup: environmentWorkspaceBackupFromRow(backupRow),
      resumeAfterRestore: runtime.desiredState === "running",
    };
  }

  /**
   * Reconciles product Session metadata after the native Volume has committed
   * a restore. Sessions created after the snapshot have no native harness
   * state in that snapshot, so they remain visible but fail explicitly.
   */
  async recordEnvironmentWorkspaceRestored(
    environmentId: string,
    sandboxId: string,
    snapshotId: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const backupResult = await client.query<{
        created_at: Date;
        workspace_volume_id: string;
      }>(
        `SELECT backup.created_at, backup.workspace_volume_id
         FROM environment_workspace_backups backup
         JOIN environment_runtime runtime
           ON runtime.environment_id = backup.environment_id
         WHERE backup.environment_id = $1
           AND backup.snapshot_id = $2
           AND runtime.sandbox_id = $3
         FOR UPDATE OF backup, runtime`,
        [environmentId, snapshotId, sandboxId],
      );
      const backup = backupResult.rows[0];
      if (!backup) {
        throw conflict(
          "environment_runtime_changed",
          "The Environment runtime changed while its Workspace was being restored.",
        );
      }
      const volumeResult = await client.query<{
        workspace_volume_id: string | null;
      }>(
        "SELECT workspace_volume_id FROM environments WHERE id = $1 FOR UPDATE",
        [environmentId],
      );
      if (
        volumeResult.rows[0]?.workspace_volume_id !== backup.workspace_volume_id
      ) {
        throw conflict(
          "environment_workspace_backup_stale",
          "The Workspace Volume changed while its backup was being restored.",
        );
      }

      const restoredAt = new Date();
      await client.query(
        `UPDATE sessions session
         SET status = 'waiting', unread = TRUE,
             metadata = metadata - 'workspaceRestore'
         FROM session_runtime runtime
         WHERE runtime.session_id = session.id
           AND session.environment_id = $1
           AND session.created_at <= $2
           AND runtime.runtime_error_code = $3`,
        [
          environmentId,
          backup.created_at,
          WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
        ],
      );
      const unavailable = await client.query<{ id: string }>(
        `UPDATE sessions
         SET status = 'failed', unread = TRUE,
             metadata = metadata || jsonb_build_object(
               'workspaceRestore', jsonb_build_object(
                 'snapshotId', $3::TEXT,
                 'restoredAt', $4::TIMESTAMPTZ,
                 'reason', 'native-session-created-after-backup'
               )
             )
         WHERE environment_id = $1 AND created_at > $2
         RETURNING id`,
        [environmentId, backup.created_at, snapshotId, restoredAt],
      );
      await client.query(
        `UPDATE session_runtime runtime
         SET runtime_error_code = CASE
               WHEN session.created_at > $2 THEN $3
               WHEN runtime.runtime_error_code = $3 THEN NULL
               ELSE runtime.runtime_error_code
             END,
             version = version + 1
         FROM sessions session
         WHERE runtime.session_id = session.id
           AND session.environment_id = $1`,
        [
          environmentId,
          backup.created_at,
          WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
        ],
      );
      await client.query(
        "UPDATE sessions SET unread = TRUE WHERE environment_id = $1",
        [environmentId],
      );
      await client.query("COMMIT");
      return { unavailableSessionCount: unavailable.rowCount ?? 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async environmentWorkspaceBackupsBeyondRetention(
    environmentId: string,
    retentionCount: number,
  ): Promise<EnvironmentWorkspaceBackup[]> {
    const result = await this.pool.query<EnvironmentWorkspaceBackupRow>(
      `SELECT snapshot_id, environment_id, workspace_volume_id, name,
              size_bytes, backup_kind, created_at
       FROM environment_workspace_backups
       WHERE environment_id = $1
       ORDER BY created_at DESC, snapshot_id DESC
       OFFSET $2`,
      [environmentId, retentionCount],
    );
    return result.rows.map(environmentWorkspaceBackupFromRow);
  }

  async deleteEnvironmentWorkspaceBackupRecord(
    environmentId: string,
    snapshotId: string,
  ) {
    await this.pool.query(
      `DELETE FROM environment_workspace_backups
       WHERE environment_id = $1 AND snapshot_id = $2`,
      [environmentId, snapshotId],
    );
  }

  async environmentIdlePauseCandidateIds(limit = 50) {
    const result = await this.pool.query<{ environment_id: string }>(
      `SELECT runtime.environment_id
       FROM environment_runtime runtime
       JOIN environments environment ON environment.id = runtime.environment_id
       WHERE environment.status = 'ready'
         AND environment.idle_pause_timeout_seconds > 0
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.idle_pause_due_at <= NOW()
         AND runtime.desired_state IN ('running', 'paused')
         AND runtime.paused_at IS NULL
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
       FROM environments environment
       WHERE runtime.environment_id = $1
         AND environment.id = runtime.environment_id
         AND environment.idle_pause_timeout_seconds > 0
         AND runtime.sandbox_id IS NOT NULL
         AND runtime.idle_pause_due_at <= NOW()
         AND runtime.desired_state IN ('running', 'paused')
         AND runtime.paused_at IS NULL
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

  async prepareEnvironmentQuotaPause(environmentId: string) {
    const result = await this.pool.query<{ environment_id: string }>(
      `UPDATE environment_runtime
       SET desired_state = 'paused', lifecycle_error = NULL,
           version = version + 1
       WHERE environment_id = $1
         AND sandbox_id IS NOT NULL
         AND desired_state <> 'terminated'
         AND paused_at IS NULL
       RETURNING environment_id`,
      [environmentId],
    );
    if (!result.rowCount) return undefined;
    return this.environmentRuntime(environmentId);
  }

  async prepareEnvironmentManualPause(
    userId: string,
    environmentId: string,
  ) {
    const environment = await this.getManageableEnvironment(
      userId,
      environmentId,
    );
    if (
      environment.status !== "ready" ||
      !environment.sandboxId ||
      !environment.workspaceVolumeId
    ) {
      throw conflict(
        "environment_runtime_not_ready",
        "Wait for the Environment Sandbox to become ready.",
      );
    }
    const result = await this.pool.query<{ environment_id: string }>(
      `UPDATE environment_runtime
       SET desired_state = 'paused', lifecycle_error = NULL,
           version = version + 1
       WHERE environment_id = $1
         AND sandbox_id IS NOT NULL
         AND desired_state <> 'terminated'
       RETURNING environment_id`,
      [environmentId],
    );
    if (!result.rowCount) {
      throw conflict(
        "environment_terminated",
        "The Environment is being deleted.",
      );
    }
    return this.environmentRuntime(environmentId);
  }

  async recordEnvironmentPaused(
    environmentId: string,
    sandboxId: string,
    reason: "idle" | "quota" | "manual" = "idle",
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'paused',
           idle_pause_due_at = NULL, lifecycle_error = NULL,
           pause_reason = CASE
             WHEN paused_at IS NULL THEN $3
             ELSE pause_reason
           END,
           paused_at = COALESCE(paused_at, NOW()),
           version = version + 1
       WHERE environment_id = $1 AND sandbox_id = $2`,
      [environmentId, sandboxId, reason],
    );
  }

  async recordEnvironmentManualLifecycleFailure(
    environmentId: string,
    sandboxId: string,
    error: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = CASE
             WHEN paused_at IS NULL THEN 'running'
             ELSE 'paused'
           END,
           lifecycle_error = $3,
           version = version + 1
       WHERE environment_id = $1
         AND sandbox_id = $2
         AND desired_state <> 'terminated'`,
      [environmentId, sandboxId, error],
    );
  }

  async recordEnvironmentQuotaPauseFailure(
    environmentId: string,
    sandboxId: string,
    error: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'paused', lifecycle_error = $3,
           version = version + 1
       WHERE environment_id = $1
         AND sandbox_id = $2
         AND paused_at IS NULL`,
      [environmentId, sandboxId, error],
    );
  }

  async recordEnvironmentPauseFailure(
    environmentId: string,
    sandboxId: string,
    error: string,
  ) {
    await this.pool.query(
      `UPDATE environment_runtime
       SET desired_state = 'paused',
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
             WHEN environment.idle_pause_timeout_seconds = 0 THEN NULL
             WHEN last_turn_completed_at IS NOT NULL
               AND (runtime.paused_at IS NOT NULL OR $5::BOOLEAN)
             THEN GREATEST(
               last_turn_completed_at + (
                 environment.idle_pause_timeout_seconds::BIGINT
                 * INTERVAL '1 second'
               ),
               NOW() + (
                 environment.idle_pause_timeout_seconds::BIGINT
                 * INTERVAL '1 second'
               )
             )
             ELSE idle_pause_due_at
           END,
           desired_state = 'running',
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
                 active_turn_attempt_id = $4::TEXT,
                 active_turn_runtime_generation = $5::BIGINT,
                 pending_turn_phase = CASE
                   WHEN pending_turn_phase IS NULL THEN NULL ELSE 'accepted'
                 END,
                 pending_turn_native_turn_id = CASE
                   WHEN pending_turn_phase IS NULL THEN NULL ELSE $3
                 END,
                 pending_turn_attempt_id = CASE
                   WHEN pending_turn_phase IS NULL THEN NULL ELSE $4::TEXT
                 END,
                 pending_turn_runtime_generation = CASE
                   WHEN pending_turn_phase IS NULL THEN NULL ELSE $5::BIGINT
                 END,
                 version = version + 1
             FROM sessions session
             WHERE runtime.session_id = session.id
               AND session.environment_id = $1
               AND runtime.native_session_id = $2
               AND runtime.recovery_source_native_turn_id IS DISTINCT FROM $3`,
            [
              environmentId,
              transition.nativeSessionId,
              transition.nativeTurnId,
              attemptId ?? null,
              runtimeGeneration,
            ],
          );
          await client.query(
            `UPDATE sessions session
             SET status = 'running', completed = FALSE
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
               active_turn_attempt_id = NULL,
               active_turn_runtime_generation = NULL,
               pending_turn_request_id = NULL,
               pending_turn_client_message_id = NULL,
               pending_turn_stable_input_id = NULL,
               pending_turn_phase = NULL,
               pending_turn_native_turn_id = NULL,
               pending_turn_started_at = NULL,
               pending_turn_attempt_id = NULL,
               pending_turn_runtime_generation = NULL,
               interrupt_requested_native_turn_id = NULL,
               recovery_source_native_turn_id = NULL,
               recovery_prompt_version = NULL,
               recovery_attempt_count = 0,
               runtime_error_code = CASE
                 WHEN runtime_error_code LIKE 'automatic_turn_recovery_%'
                   THEN NULL
                 ELSE runtime_error_code
               END,
               version = version + 1
           FROM sessions session
           WHERE runtime.session_id = session.id
             AND session.environment_id = $1
             AND runtime.native_session_id = $2
             AND (
               runtime.active_native_turn_id = $3
               OR (
                 runtime.active_native_turn_id IS NULL
                 AND runtime.recovery_source_native_turn_id IS NULL
               )
             )`,
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
          `UPDATE environment_runtime runtime
           SET last_turn_completed_at = CASE
                 WHEN runtime.last_turn_completed_at IS NULL
                   OR runtime.last_turn_completed_at < $2 THEN $2
                 ELSE runtime.last_turn_completed_at
               END,
               idle_pause_due_at = CASE
                 WHEN environment.idle_pause_timeout_seconds = 0 THEN NULL
                 ELSE (
                   CASE
                     WHEN runtime.last_turn_completed_at IS NULL
                       OR runtime.last_turn_completed_at < $2 THEN $2
                     ELSE runtime.last_turn_completed_at
                   END
                 ) + (
                   environment.idle_pause_timeout_seconds::BIGINT
                   * INTERVAL '1 second'
                 )
               END,
               version = version + 1
           FROM environments environment
           WHERE runtime.environment_id = $1
             AND environment.id = runtime.environment_id`,
          [environmentId, latestCompletedAt],
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

  async resetEnvironmentDecoder(
    environmentId: string,
    expectedCursor: number,
    cursor: number,
  ) {
    const result = await this.pool.query(
      `UPDATE environment_runtime
       SET supervisor_cursor = $2, stdout_tail = '', version = version + 1
       WHERE environment_id = $1 AND supervisor_cursor = $3
       RETURNING environment_id`,
      [environmentId, Math.max(0, cursor), Math.max(0, expectedCursor)],
    );
    return Boolean(result.rowCount);
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
       WHERE environment.created_by_user_id = $1
       ORDER BY (pin.user_id IS NOT NULL) DESC, session.updated_at DESC,
                session.id`,
      [userId],
    );
    return result.rows.map(sessionFromRow);
  }

  async getSession(userId: string, sessionId: string): Promise<CodingSession> {
    const result = await this.pool.query<SessionRow>(
      `${SESSION_SELECT}
       WHERE environment.created_by_user_id = $1
         AND session.id = $2`,
      [userId, sessionId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("session_not_found", "Session not found.");
    return sessionFromRow(row);
  }

  async claimIdempotentResource(input: {
    userId: string;
    operation: string;
    key: string;
    requestFingerprint: string;
    resourceId: string;
    expiresAt: Date;
  }): Promise<IdempotentResourceClaim> {
    const keyHash = sha256Buffer(input.key);
    const requestHash = sha256Buffer(input.requestFingerprint);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM idempotency_keys WHERE expires_at <= NOW()",
      );
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (
           user_id, operation, key_hash, request_hash, resource_id, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, operation, key_hash) DO NOTHING
         RETURNING id`,
        [
          input.userId,
          input.operation,
          keyHash,
          requestHash,
          input.resourceId,
          input.expiresAt,
        ],
      );
      const current = await client.query<IdempotencyKeyRow>(
        `SELECT request_hash, status, resource_id,
                response_status, response_body
         FROM idempotency_keys
         WHERE user_id = $1 AND operation = $2 AND key_hash = $3
         FOR UPDATE`,
        [input.userId, input.operation, keyHash],
      );
      const row = current.rows[0];
      if (!row) {
        throw new Error("The idempotency claim disappeared during creation.");
      }
      assertIdempotencyRequestHash(row, requestHash);
      const state = idempotentResourceState(row);
      await client.query("COMMIT");
      return { ...state, claimed: Boolean(inserted.rowCount) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readIdempotentResource(input: {
    userId: string;
    operation: string;
    key: string;
    requestFingerprint: string;
  }): Promise<IdempotentResourceState> {
    const requestHash = sha256Buffer(input.requestFingerprint);
    const result = await this.pool.query<IdempotencyKeyRow>(
      `SELECT request_hash, status, resource_id,
              response_status, response_body
       FROM idempotency_keys
       WHERE user_id = $1 AND operation = $2 AND key_hash = $3
         AND expires_at > NOW()`,
      [input.userId, input.operation, sha256Buffer(input.key)],
    );
    const row = result.rows[0];
    if (!row) {
      throw conflict(
        "idempotency_key_expired",
        "This Session creation request can no longer be resumed.",
      );
    }
    assertIdempotencyRequestHash(row, requestHash);
    return idempotentResourceState(row);
  }

  async completeIdempotentResource(input: {
    userId: string;
    operation: string;
    key: string;
    requestFingerprint: string;
    resourceId: string;
  }) {
    const result = await this.pool.query(
      `UPDATE idempotency_keys
       SET status = 'completed', response_status = 201,
           response_body = jsonb_build_object('resourceId', resource_id),
           updated_at = NOW()
       WHERE user_id = $1 AND operation = $2 AND key_hash = $3
         AND request_hash = $4 AND resource_id = $5
         AND status = 'processing' AND expires_at > NOW()
       RETURNING id`,
      [
        input.userId,
        input.operation,
        sha256Buffer(input.key),
        sha256Buffer(input.requestFingerprint),
        input.resourceId,
      ],
    );
    if (!result.rowCount) {
      throw new Error("The idempotent Session creation could not be completed.");
    }
  }

  async failIdempotentResource(input: {
    userId: string;
    operation: string;
    key: string;
    requestFingerprint: string;
    resourceId: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
  }) {
    const result = await this.pool.query(
      `UPDATE idempotency_keys
       SET status = 'failed', response_status = $6,
           response_body = $7::JSONB, updated_at = NOW()
       WHERE user_id = $1 AND operation = $2 AND key_hash = $3
         AND request_hash = $4 AND resource_id = $5
         AND status = 'processing' AND expires_at > NOW()
       RETURNING id`,
      [
        input.userId,
        input.operation,
        sha256Buffer(input.key),
        sha256Buffer(input.requestFingerprint),
        input.resourceId,
        input.responseStatus,
        JSON.stringify(input.responseBody),
      ],
    );
    return Boolean(result.rowCount);
  }

  async createSessionMetadata(input: {
    userId: string;
    environment: Environment;
    title: string;
    modelId?: string;
    reasoningEffort?: string;
    sessionId?: string;
  }) {
    return this.insertSessionMetadata({ ...input, kind: "environment" });
  }

  /**
   * Creates the deterministic product Session reserved by one Automation run.
   * Retrying the same run returns its existing row; another owner or run can
   * never adopt that id.
   */
  async ensureAutomationSessionMetadata(input: {
    sessionId: string;
    automationRunId: string;
    automationKind: "schedule" | "webhook";
    userId: string;
    environment: Environment;
    title: string;
    modelId?: string;
    reasoningEffort?: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO sessions (
           id, environment_id, created_by_user_id, title, status,
           harness, harness_state, metadata, environment_revision,
           origin_kind, origin_label
         ) VALUES (
           $1, $2, $3, $4, 'provisioning', 'codex', $5::JSONB,
           $6::JSONB, $7, 'environment', $8
         )
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          input.sessionId,
          input.environment.id,
          input.userId,
          input.title,
          JSON.stringify({ protocol: "codex-app-server" }),
          JSON.stringify({
            modelId: input.modelId ?? null,
            reasoningEffort: input.reasoningEffort ?? null,
            automationRunId: input.automationRunId,
            automationKind: input.automationKind,
            ...(input.automationKind === "schedule"
              ? { scheduleRunId: input.automationRunId }
              : {}),
          }),
          input.environment.revision,
          input.environment.name,
        ],
      );
      if (inserted.rowCount) {
        await client.query(
          `INSERT INTO session_runtime (
             session_id, model_id, reasoning_effort
           ) VALUES ($1, $2, $3)`,
          [
            input.sessionId,
            input.modelId ?? null,
            input.reasoningEffort ?? null,
          ],
        );
      } else {
        const existing = await client.query(
          `SELECT session.id
           FROM sessions session
           JOIN environments environment
             ON environment.id = session.environment_id
           JOIN session_runtime runtime ON runtime.session_id = session.id
           WHERE session.id = $1 AND session.environment_id = $2
             AND session.created_by_user_id = $3
             AND environment.created_by_user_id = $3
             AND (
               (
                 session.metadata ->> 'automationRunId' = $4
                 AND session.metadata ->> 'automationKind' = $5
               )
               OR (
                 $5 = 'schedule'
                 AND session.metadata ->> 'scheduleRunId' = $4
               )
             )`,
          [
            input.sessionId,
            input.environment.id,
            input.userId,
            input.automationRunId,
            input.automationKind,
          ],
        );
        if (!existing.rowCount) {
          throw conflict(
            "environment_automation_session_conflict",
            "The Automation run Session id belongs to another resource.",
          );
        }
      }
      await client.query("COMMIT");
      return input.sessionId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createForkSessionMetadata(input: {
    userId: string;
    environment: Environment;
    source: CodingSession;
    modelId?: string;
    reasoningEffort?: string;
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
      reasoningEffort: input.reasoningEffort,
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
    reasoningEffort?: string;
    sessionId?: string;
    kind: "environment" | "session" | "turn";
    originLabel?: string;
    sourceSessionId?: string;
    sourceNativeItemId?: string;
  }) {
    const id = input.sessionId ?? `session_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sessions (
           id, environment_id, created_by_user_id, title, status,
           harness, harness_state, metadata, environment_revision,
           origin_kind, origin_label, source_session_id, source_native_item_id
         ) VALUES (
           $1, $2, $3, $4, 'provisioning', 'codex', $5::JSONB,
           $6::JSONB, $7, $8, $9, $10, $11
         )`,
        [
          id,
          input.environment.id,
          input.userId,
          input.title,
          JSON.stringify({ protocol: "codex-app-server" }),
          JSON.stringify({
            modelId: input.modelId ?? null,
            reasoningEffort: input.reasoningEffort ?? null,
          }),
          input.environment.revision,
          input.kind,
          input.originLabel ?? input.environment.name,
          input.sourceSessionId ?? null,
          input.sourceNativeItemId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO session_runtime (
           session_id, model_id, reasoning_effort
         ) VALUES ($1, $2, $3)`,
        [id, input.modelId ?? null, input.reasoningEffort ?? null],
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
      await client.query(`UPDATE sessions SET status = $2 WHERE id = $1`, [
        sessionId,
        options.status ?? "waiting",
      ]);
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
    clearRecoveryState?: boolean;
    recoveryErrorCode?: string;
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
          projection.pending_turn_request_id === input.clearPendingRequestId) ||
        (input.clearPendingStartedBefore !== undefined &&
          projection.pending_turn_started_at !== null &&
          projection.pending_turn_started_at.getTime() <=
            input.clearPendingStartedBefore.getTime());
      const clearPending =
        input.clearPendingWhenNativeIdle === true &&
        activeNativeTurnId === null &&
        projection.pending_turn_phase !== null &&
        pendingRecoveryEligible;
      const clearRecovery =
        input.clearRecoveryState === true && activeNativeTurnId === null;
      const clearControlState = clearPending || clearRecovery;
      if (clearControlState) {
        await client.query(
          `UPDATE session_runtime
           SET active_native_turn_id = NULL,
               active_turn_attempt_id = NULL,
               active_turn_runtime_generation = NULL,
               pending_turn_request_id = NULL,
               pending_turn_client_message_id = NULL,
               pending_turn_stable_input_id = NULL,
               pending_turn_phase = NULL,
               pending_turn_native_turn_id = NULL,
               pending_turn_started_at = NULL,
               pending_turn_attempt_id = NULL,
               pending_turn_runtime_generation = NULL,
               interrupt_requested_native_turn_id = NULL,
               recovery_source_native_turn_id = NULL,
               recovery_prompt_version = NULL,
               recovery_attempt_count = 0,
               runtime_error_code = CASE
                 WHEN $3::BOOLEAN THEN $2::TEXT
                 ELSE runtime_error_code
               END,
               version = version + 1
           WHERE session_id = $1`,
          [input.sessionId, input.recoveryErrorCode ?? null, clearRecovery],
        );
      } else if (projection.active_native_turn_id !== activeNativeTurnId) {
        await client.query(
          `UPDATE session_runtime
           SET active_native_turn_id = $2::TEXT,
               active_turn_attempt_id = CASE
                 WHEN $2::TEXT IS NULL THEN NULL ELSE $3::TEXT
               END,
               active_turn_runtime_generation = CASE
                 WHEN $2::TEXT IS NULL THEN NULL ELSE $4::BIGINT
               END,
               version = version + 1
           WHERE session_id = $1`,
          [
            input.sessionId,
            activeNativeTurnId,
            input.environmentAttemptId ?? null,
            input.environmentRuntimeGeneration,
          ],
        );
      }
      const status =
        activeNativeTurnId ||
        (!clearPending && projection.pending_turn_phase)
          ? "running"
          : "waiting";
      await client.query(
        `UPDATE sessions
         SET status = $2,
             completed = CASE WHEN $3::BOOLEAN THEN FALSE ELSE completed END
         WHERE id = $1 AND status <> 'failed'
           AND (
             status IS DISTINCT FROM $2
             OR ($3::BOOLEAN AND completed)
           )`,
        [input.sessionId, status, activeNativeTurnId !== null],
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

  async sessionIdsForEnvironment(
    environmentId: string,
    options: { includeFailed?: boolean } = {},
  ) {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM sessions
       WHERE environment_id = $1
         AND ($2::BOOLEAN OR status <> 'failed')
         AND archived = FALSE`,
      [environmentId, options.includeFailed ?? false],
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
    reasoningEffort?: string,
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
                 reasoning_effort = COALESCE($3, reasoning_effort),
                 pending_turn_request_id = $4,
                 pending_turn_client_message_id = $5,
                 pending_turn_stable_input_id = $6,
                 pending_turn_phase = 'prepared',
                 pending_turn_started_at = NOW(),
                 pending_turn_attempt_id = NULL,
                 pending_turn_runtime_generation = NULL,
                 interrupt_requested_native_turn_id = NULL,
                 recovery_source_native_turn_id = NULL,
                 recovery_prompt_version = NULL,
                 recovery_attempt_count = 0,
                 runtime_error_code = NULL,
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
              reasoningEffort ?? null,
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

  async markTurnSubmitted(
    sessionId: string,
    requestId: string,
    attemptId: string | undefined,
    runtimeGeneration: number,
  ) {
    const result = await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = 'submitted',
           pending_turn_attempt_id = $3,
           pending_turn_runtime_generation = $4,
           version = version + 1
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase = 'prepared'
         AND interrupt_requested_native_turn_id IS NULL`,
      [sessionId, requestId, attemptId ?? null, runtimeGeneration],
    );
    return Boolean(result.rowCount);
  }

  /**
   * A durable user-authored delivery may be retried only after the Supervisor
   * epoch that received its ambiguous submission has been replaced and native
   * Thread state has already proved the input absent.
   */
  async prepareDurableTurnReplay(input: {
    sessionId: string;
    submission: TurnSubmissionCoordinates;
    environmentAttemptId?: string;
    environmentRuntimeGeneration: number;
  }) {
    const result = await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = 'prepared',
           pending_turn_attempt_id = NULL,
           pending_turn_runtime_generation = NULL,
           version = version + 1
       WHERE session_id = $1
         AND pending_turn_request_id = $2
         AND pending_turn_client_message_id = $3
         AND pending_turn_stable_input_id = $4
         AND pending_turn_phase = 'submitted'
         AND (
           pending_turn_attempt_id IS DISTINCT FROM $5
           OR pending_turn_runtime_generation IS DISTINCT FROM $6
         )
       RETURNING session_id`,
      [
        input.sessionId,
        input.submission.requestId,
        input.submission.clientMessageId,
        input.submission.stableInputId,
        input.environmentAttemptId ?? null,
        input.environmentRuntimeGeneration,
      ],
    );
    return Boolean(result.rowCount);
  }

  async markTurnAccepted(
    sessionId: string,
    requestId: string,
    nativeTurnId: string,
    attemptId: string | undefined,
    runtimeGeneration: number,
  ) {
    await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = 'accepted',
           pending_turn_native_turn_id = $3,
           pending_turn_attempt_id = $4,
           pending_turn_runtime_generation = $5,
           active_native_turn_id = $3,
           active_turn_attempt_id = $4,
           active_turn_runtime_generation = $5,
           version = version + 1
       WHERE session_id = $1 AND pending_turn_request_id = $2
         AND pending_turn_phase IN ('prepared', 'submitted', 'accepted')`,
      [
        sessionId,
        requestId,
        nativeTurnId,
        attemptId ?? null,
        runtimeGeneration,
      ],
    );
  }

  /**
   * Atomically chooses and marks the native Turn that an interrupt request
   * should target. The browser's Turn id is advisory because its native
   * snapshot can legitimately lag a newer accepted Turn.
   */
  async requestTurnInterrupt(
    sessionId: string,
    preferredNativeTurnId?: string,
  ) {
    const result = await this.pool.query<{ native_turn_id: string }>(
      `WITH interrupt_target AS (
         SELECT runtime.session_id,
                CASE
                  WHEN $2::TEXT IS NOT NULL
                    AND (
                      runtime.pending_turn_native_turn_id = $2::TEXT
                      OR runtime.active_native_turn_id = $2::TEXT
                      OR runtime.recovery_source_native_turn_id = $2::TEXT
                    )
                    THEN $2::TEXT
                  ELSE COALESCE(
                    runtime.pending_turn_native_turn_id,
                    runtime.active_native_turn_id,
                    runtime.recovery_source_native_turn_id
                  )
                END AS native_turn_id
         FROM session_runtime runtime
         JOIN sessions session ON session.id = runtime.session_id
         WHERE runtime.session_id = $1
           AND session.archived = FALSE
           AND session.status = 'running'
         FOR UPDATE OF runtime
       )
       UPDATE session_runtime runtime
       SET interrupt_requested_native_turn_id = target.native_turn_id,
           version = version + 1
       FROM interrupt_target target
       WHERE runtime.session_id = target.session_id
         AND target.native_turn_id IS NOT NULL
       RETURNING runtime.interrupt_requested_native_turn_id AS native_turn_id`,
      [sessionId, preferredNativeTurnId ?? null],
    );
    return result.rows[0]?.native_turn_id;
  }

  /**
   * Atomically replaces one runtime-interrupted native Turn projection with a
   * server-defined recovery Turn delivery. The original prompt is never copied
   * into PostgreSQL; the recovery prompt is derived from its stored version.
   */
  async claimInterruptedTurnRecovery(input: {
    sessionId: string;
    nativeSessionId: string;
    historyRevision: number;
    runtimeVersion: number;
    environmentId: string;
    environmentSupervisorSessionId?: string;
    environmentAttemptId?: string;
    environmentRuntimeGeneration: number;
    sourceNativeTurnId: string;
    sourcePendingClientMessageId?: string;
    submission: TurnSubmissionCoordinates;
    promptVersion: number;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const environment = await client.query(
        `SELECT environment_id
         FROM environment_runtime
         WHERE environment_id = $1
           AND supervisor_session_id IS NOT DISTINCT FROM $2
           AND attempt_id IS NOT DISTINCT FROM $3
           AND runtime_generation = $4
           AND desired_state = 'running'
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
      const claimed = await client.query(
        `UPDATE session_runtime runtime
         SET active_native_turn_id = NULL,
             active_turn_attempt_id = NULL,
             active_turn_runtime_generation = NULL,
             pending_turn_request_id = $10,
             pending_turn_client_message_id = $11,
             pending_turn_stable_input_id = $12,
             pending_turn_phase = 'prepared',
             pending_turn_native_turn_id = NULL,
             pending_turn_started_at = NOW(),
             pending_turn_attempt_id = NULL,
             pending_turn_runtime_generation = NULL,
             interrupt_requested_native_turn_id = NULL,
             recovery_source_native_turn_id = $8,
             recovery_prompt_version = $13,
             recovery_attempt_count = recovery_attempt_count + 1,
             runtime_error_code = NULL,
             version = version + 1
         FROM sessions session
         WHERE runtime.session_id = $5 AND session.id = runtime.session_id
           AND runtime.native_session_id = $6
           AND runtime.history_revision = $7
           AND runtime.version = $9
           AND session.environment_id = $1
           AND session.archived = FALSE
           AND session.status <> 'failed'
           AND EXISTS (
             SELECT 1
             FROM environment_runtime environment
             WHERE environment.environment_id = $1
               AND environment.supervisor_session_id IS NOT DISTINCT FROM $2
               AND environment.attempt_id IS NOT DISTINCT FROM $3
               AND environment.runtime_generation = $4
               AND environment.desired_state = 'running'
           )
           AND runtime.interrupt_requested_native_turn_id IS DISTINCT FROM $8
           AND runtime.recovery_source_native_turn_id IS NULL
           AND runtime.recovery_attempt_count = 0
           AND (
             (
               runtime.active_native_turn_id = $8
               AND (
                 runtime.active_turn_attempt_id IS DISTINCT FROM $3
                 OR runtime.active_turn_runtime_generation IS DISTINCT FROM $4
               )
             )
             OR
             (
               (
                 runtime.pending_turn_native_turn_id = $8
                 OR (
                   $14::TEXT IS NOT NULL
                   AND runtime.pending_turn_client_message_id = $14
                 )
               )
               AND (
                 runtime.pending_turn_attempt_id IS DISTINCT FROM $3
                 OR runtime.pending_turn_runtime_generation IS DISTINCT FROM $4
               )
             )
           )
         RETURNING runtime.session_id`,
        [
          input.environmentId,
          input.environmentSupervisorSessionId ?? null,
          input.environmentAttemptId ?? null,
          input.environmentRuntimeGeneration,
          input.sessionId,
          input.nativeSessionId,
          input.historyRevision,
          input.sourceNativeTurnId,
          input.runtimeVersion,
          input.submission.requestId,
          input.submission.clientMessageId,
          input.submission.stableInputId,
          input.promptVersion,
          input.sourcePendingClientMessageId ?? null,
        ],
      );
      if (!claimed.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE sessions SET status = 'running'
         WHERE id = $1 AND environment_id = $2`,
        [input.sessionId, input.environmentId],
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
   * A recovery prompt is server-defined and may be redelivered only after the
   * Supervisor epoch that received its ambiguous submission has disappeared.
   */
  async prepareInterruptedTurnRecoveryReplay(input: {
    sessionId: string;
    nativeSessionId: string;
    runtimeVersion: number;
    requestId: string;
    environmentAttemptId?: string;
    environmentRuntimeGeneration: number;
  }) {
    const result = await this.pool.query(
      `UPDATE session_runtime
       SET pending_turn_phase = 'prepared',
           pending_turn_attempt_id = NULL,
           pending_turn_runtime_generation = NULL,
           version = version + 1
       WHERE session_id = $1 AND native_session_id = $2 AND version = $3
         AND pending_turn_request_id = $4
         AND pending_turn_phase = 'submitted'
         AND recovery_source_native_turn_id IS NOT NULL
         AND (
           pending_turn_attempt_id IS DISTINCT FROM $5
           OR pending_turn_runtime_generation IS DISTINCT FROM $6
         )
       RETURNING session_id`,
      [
        input.sessionId,
        input.nativeSessionId,
        input.runtimeVersion,
        input.requestId,
        input.environmentAttemptId ?? null,
        input.environmentRuntimeGeneration,
      ],
    );
    return Boolean(result.rowCount);
  }

  async failInterruptedTurnRecovery(
    sessionId: string,
    requestId: string,
    errorCode: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query(
        `UPDATE session_runtime
         SET active_native_turn_id = NULL,
             active_turn_attempt_id = NULL,
             active_turn_runtime_generation = NULL,
             pending_turn_request_id = NULL,
             pending_turn_client_message_id = NULL,
             pending_turn_stable_input_id = NULL,
             pending_turn_phase = NULL,
             pending_turn_native_turn_id = NULL,
             pending_turn_started_at = NULL,
             pending_turn_attempt_id = NULL,
             pending_turn_runtime_generation = NULL,
             interrupt_requested_native_turn_id = NULL,
             recovery_source_native_turn_id = NULL,
             recovery_prompt_version = NULL,
             recovery_attempt_count = 0,
             runtime_error_code = $3,
             version = version + 1
         WHERE session_id = $1 AND pending_turn_request_id = $2
           AND recovery_source_native_turn_id IS NOT NULL
         RETURNING session_id`,
        [sessionId, requestId, errorCode],
      );
      if (failed.rowCount) {
        await client.query(
          `UPDATE sessions SET status = 'waiting'
           WHERE id = $1 AND status <> 'failed'`,
          [sessionId],
        );
      }
      await client.query("COMMIT");
      return Boolean(failed.rowCount);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
             pending_turn_attempt_id = NULL,
             pending_turn_runtime_generation = NULL,
             active_native_turn_id = NULL,
             active_turn_attempt_id = NULL,
             active_turn_runtime_generation = NULL,
             interrupt_requested_native_turn_id = NULL,
             recovery_source_native_turn_id = NULL,
             recovery_prompt_version = NULL,
             recovery_attempt_count = 0,
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
      completed?: boolean;
      archived?: boolean;
      unread?: boolean;
    },
  ) {
    await this.getSession(userId, sessionId);
    if (changes.archived === true) {
      await this.archiveIdleSession(userId, sessionId, changes);
      return this.getSession(userId, sessionId);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE sessions
         SET title = COALESCE($2, title),
             archived = COALESCE($3, archived),
             unread = COALESCE($4, unread),
             completed = COALESCE($5, completed)
         WHERE id = $1 RETURNING id`,
        [
          sessionId,
          changes.title ?? null,
          changes.archived ?? null,
          changes.unread ?? null,
          changes.completed ?? null,
        ],
      );
      if (!result.rowCount) {
        throw notFound("session_not_found", "Session not found.");
      }
      await this.setSessionPin(client, userId, sessionId, changes.pinned);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.getSession(userId, sessionId);
  }

  private async archiveIdleSession(
    userId: string,
    sessionId: string,
    changes: {
      title?: string;
      pinned?: boolean;
      completed?: boolean;
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
         SET title = COALESCE($2, title), archived = TRUE,
             unread = COALESCE($3, unread),
             completed = COALESCE($4, completed)
         WHERE id = $1`,
        [
          sessionId,
          changes.title ?? null,
          changes.unread ?? null,
          changes.completed ?? null,
        ],
      );
      await this.setSessionPin(client, userId, sessionId, changes.pinned);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async setSessionPin(
    client: PoolClient,
    userId: string,
    sessionId: string,
    pinned: boolean | undefined,
  ) {
    if (pinned === undefined) return;
    if (pinned) {
      await client.query(
        `INSERT INTO session_pins (session_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [sessionId, userId],
      );
      return;
    }
    await client.query(
      "DELETE FROM session_pins WHERE session_id = $1 AND user_id = $2",
      [sessionId, userId],
    );
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
      `SELECT language, time_zone, send_shortcut, theme, density
       FROM user_preferences
       WHERE user_id = $1`,
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
    };
  }

  async updatePreferences(userId: string, value: SandpiPreferences) {
    await this.pool.query(
      `UPDATE user_preferences
       SET language = $2, time_zone = $3, send_shortcut = $4,
           theme = $5, density = $6
       WHERE user_id = $1`,
      [
        userId,
        value.general.language,
        value.general.timeZone,
        value.general.sendShortcut,
        value.appearance.theme,
        value.appearance.density,
      ],
    );
    return this.getPreferences(userId);
  }
}

const ENVIRONMENT_SELECT = `
  SELECT environment.*, runtime.sandbox_id, runtime.supervisor_session_id,
         runtime.workspace_backup_due_at,
         runtime.workspace_backup_last_completed_at,
         runtime.workspace_backup_error
  FROM environments environment
  LEFT JOIN environment_runtime runtime
    ON runtime.environment_id = environment.id
`;

const ENVIRONMENT_RUNTIME_SELECT = `
  SELECT runtime.*, environment.workspace_volume_id,
         environment.credential_revision,
         credential_binding.source_revision AS bound_credential_revision,
         credential_binding.status AS credential_binding_status
  FROM environment_runtime runtime
  JOIN environments environment ON environment.id = runtime.environment_id
  LEFT JOIN environment_credential_bindings credential_binding
    ON credential_binding.environment_id = runtime.environment_id
   AND credential_binding.harness = 'codex'
   AND credential_binding.credential_slot = 'account'
`;

const ENVIRONMENT_EGRESS_CREDENTIAL_SELECT = `
  SELECT credential.id, credential.environment_id, credential.display_name,
         credential.source_ref, credential.resolver_kind,
         credential.projection, credential.rule, credential.enabled,
         credential.status, credential.source_version,
         credential.source_status, credential.last_error,
         credential.created_at, credential.updated_at
  FROM environment_egress_credentials credential
`;

const SESSION_SELECT = `
  SELECT session.*, runtime.native_session_id, runtime.model_id,
         runtime.reasoning_effort,
         runtime.history_revision,
         (pin.user_id IS NOT NULL) AS pinned,
         owner.id AS owner_id, owner.email AS owner_email,
         owner.name AS owner_name,
         owner.avatar_initials AS owner_avatar_initials
  FROM sessions session
  JOIN environments environment ON environment.id = session.environment_id
  LEFT JOIN session_pins pin
    ON pin.session_id = session.id AND pin.user_id = $1
  LEFT JOIN users owner ON owner.id = session.created_by_user_id
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

function environmentFromRow(row: EnvironmentRow): EnvironmentRecord {
  const metadata = row.harness_metadata ?? {};
  return {
    id: row.id,
    ownerId: row.created_by_user_id,
    idlePauseTimeoutSeconds: row.idle_pause_timeout_seconds,
    sandboxMemoryMiB: row.sandbox_memory_mib,
    workspaceBackup: {
      intervalSeconds: row.workspace_backup_interval_seconds,
      retentionCount: row.workspace_backup_retention_count,
      ...(row.workspace_backup_due_at
        ? { nextBackupAt: toUnixTimestamp(row.workspace_backup_due_at) }
        : {}),
      ...(row.workspace_backup_last_completed_at
        ? {
            lastBackupAt: toUnixTimestamp(
              row.workspace_backup_last_completed_at,
            ),
          }
        : {}),
      ...(row.workspace_backup_error
        ? { lastError: row.workspace_backup_error }
        : {}),
    },
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
      row.status === "error"
        ? "failed"
        : row.status === "updating"
          ? "provisioning"
          : "pending",
    supervisorSessionId: row.supervisor_session_id ?? "",
    workspaceRoot: "/workspace",
    credentialRevision: row.credential_revision,
    codingAgent: {
      harness: row.harness,
      label: typeof metadata.label === "string" ? metadata.label : "Codex",
      status: metadata.status === "connected" ? "connected" : "not-connected",
      account:
        typeof metadata.account === "string" ? metadata.account : undefined,
      lastVerified: parseUnixTimestamp(metadata.lastVerified),
    },
    networkPolicy: row.network_policy,
    provisioningError: row.provisioning_error ?? undefined,
  };
}

function environmentEgressCredentialFromRow(
  row: EnvironmentEgressCredentialRow,
): StoredEnvironmentEgressCredential {
  const currentVersion =
    row.source_version === null ? undefined : Number(row.source_version);
  return {
    id: row.id,
    environmentId: row.environment_id,
    name: row.display_name,
    sourceRef: row.source_ref,
    resolverKind: row.resolver_kind,
    projection: row.projection,
    rule: row.rule,
    enabled: row.enabled,
    status: row.status,
    ...(currentVersion ? { currentVersion } : {}),
    ...(row.source_status ? { sourceStatus: row.source_status } : {}),
    ...(row.last_error ? { error: row.last_error } : {}),
    createdAt: toUnixTimestamp(row.created_at),
    updatedAt: toUnixTimestamp(row.updated_at),
  };
}

function environmentWorkspaceBackupFromRow(
  row: EnvironmentWorkspaceBackupRow,
): EnvironmentWorkspaceBackup {
  return {
    id: row.snapshot_id,
    environmentId: row.environment_id,
    name: row.name,
    sizeBytes: Number(row.size_bytes),
    kind: row.backup_kind,
    createdAt: toUnixTimestamp(row.created_at),
  };
}

function environmentRuntimeFromRow(
  row: EnvironmentRuntimeRow,
): StoredEnvironmentRuntime {
  const hasCredentialBindingProjection =
    row.credential_revision !== undefined;
  return {
    id: row.environment_id,
    sandboxId: row.sandbox_id!,
    workspaceVolumeId: row.workspace_volume_id!,
    supervisorSessionId: row.supervisor_session_id ?? undefined,
    terminalSessionId: row.terminal_session_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    runtimeGeneration: Number(row.runtime_generation),
    ...(hasCredentialBindingProjection
      ? {
          codexCredentialBindingCurrent:
            row.credential_binding_status === "active" &&
            row.bound_credential_revision !== null &&
            row.bound_credential_revision !== undefined &&
            Number(row.bound_credential_revision) ===
              Number(row.credential_revision),
        }
      : {}),
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
    provisioningError: row.provisioning_error ?? undefined,
    lifecyclePolicyVersion: Number(row.lifecycle_policy_version),
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
    reasoningEffort:
      row.reasoning_effort ?? row.harness_state.reasoningEffort ?? "",
    harnessVersion: row.harness_state.harnessVersion ?? "runtime",
    protocolVersion: "v2",
    historyRevision: Number(row.history_revision ?? 0),
  };
  return {
    id: row.id,
    environmentId: row.environment_id,
    owner:
      row.owner_id &&
      row.owner_email &&
      row.owner_name &&
      row.owner_avatar_initials
        ? {
            id: row.owner_id,
            email: row.owner_email,
            name: row.owner_name,
            avatarInitials: row.owner_avatar_initials,
          }
        : null,
    title: row.title,
    status: publicSessionStatus(row.status),
    unread: row.unread,
    pinned: row.pinned,
    completed: row.completed,
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
    reasoningEffort: row.reasoning_effort ?? undefined,
    historyRevision: Number(row.history_revision),
    activeNativeTurnId: row.active_native_turn_id ?? undefined,
    activeTurnAttemptId: row.active_turn_attempt_id ?? undefined,
    activeTurnRuntimeGeneration:
      row.active_turn_runtime_generation == null
        ? undefined
        : Number(row.active_turn_runtime_generation),
    pendingTurnRequestId: row.pending_turn_request_id ?? undefined,
    pendingTurnClientMessageId: row.pending_turn_client_message_id ?? undefined,
    pendingTurnStableInputId: row.pending_turn_stable_input_id ?? undefined,
    pendingTurnPhase: row.pending_turn_phase ?? undefined,
    pendingTurnNativeTurnId: row.pending_turn_native_turn_id ?? undefined,
    pendingTurnStartedAt: row.pending_turn_started_at ?? undefined,
    pendingTurnAttemptId: row.pending_turn_attempt_id ?? undefined,
    pendingTurnRuntimeGeneration:
      row.pending_turn_runtime_generation == null
        ? undefined
        : Number(row.pending_turn_runtime_generation),
    interruptRequestedNativeTurnId:
      row.interrupt_requested_native_turn_id ?? undefined,
    recoverySourceNativeTurnId: row.recovery_source_native_turn_id ?? undefined,
    recoveryPromptVersion:
      row.recovery_prompt_version == null
        ? undefined
        : Number(row.recovery_prompt_version),
    recoveryAttemptCount: Number(row.recovery_attempt_count ?? 0),
    runtimeErrorCode: row.runtime_error_code ?? undefined,
    version: Number(row.version),
    sessionStatus:
      row.status === "provisioning"
        ? "provisioning"
        : publicSessionStatus(row.status),
  };
}

function sha256Buffer(value: string) {
  return createHash("sha256").update(value).digest();
}

function assertIdempotencyRequestHash(
  row: IdempotencyKeyRow,
  expected: Buffer,
) {
  if (row.request_hash.equals(expected)) return;
  throw conflict(
    "idempotency_key_reused",
    "This idempotency key was already used for a different request.",
  );
}

function idempotentResourceState(
  row: IdempotencyKeyRow,
): IdempotentResourceState {
  if (!row.resource_id) {
    throw new Error("The idempotency record is missing its resource id.");
  }
  return {
    status: row.status,
    resourceId: row.resource_id,
    responseStatus: row.response_status ?? undefined,
    responseBody: row.response_body ?? undefined,
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
