import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { CodexDecoderState } from "./jsonl";
import { toUnixTimestamp, type UnixTimestamp } from "@/lib/time";
import type { EncryptedValue } from "@/server/secrets";
import {
  CODEX_ENVIRONMENT_CREDENTIAL_PATH,
  CODEX_MCP_OAUTH_CREDENTIAL_PATH,
  type CodexAuthRuntime,
} from "@/server/runtime/types";
import { notFound } from "@/server/http-error";

export type CodexDeviceAuthStatus =
  | "provisioning"
  | "starting"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface CodexDeviceAuthFlow {
  id: string;
  environmentId: string;
  status: CodexDeviceAuthStatus;
  runtime?: CodexAuthRuntime;
  decoder: CodexDecoderState;
  nativeLoginId?: string;
  verificationUrl?: string;
  userCode?: string;
  protocolMessages: Record<string, unknown>[];
  error?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicCodexDeviceAuthFlow {
  id: string;
  environmentId: string;
  status: CodexDeviceAuthStatus;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  expiresAt: UnixTimestamp;
  createdAt: UnixTimestamp;
  updatedAt: UnixTimestamp;
}

interface FlowRow extends QueryResultRow {
  id: string;
  environment_id: string;
  status: CodexDeviceAuthStatus;
  sandbox_id: string | null;
  supervisor_session_id: string | null;
  attempt_id: string | null;
  runtime_generation: number;
  supervisor_cursor: string;
  stdout_tail: string;
  native_login_id: string | null;
  verification_url: string | null;
  user_code: string | null;
  protocol_messages: Record<string, unknown>[];
  error: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface CredentialRow extends QueryResultRow {
  id: string;
  environment_id: string;
  harness: string;
  credential_slot: string;
  revision: number;
  ciphertext: Buffer;
  initialization_vector: Buffer;
  authentication_tag: Buffer;
  encryption_algorithm: "aes-256-gcm";
  encryption_key_id: string;
  non_secret_metadata: Record<string, unknown>;
}

interface RuntimeCredentialRow extends CredentialRow {
  binding_source_id: string | null;
  binding_revision: number | null;
  binding_status: "active" | "stale" | "revoked" | null;
}

type CodexCredentialSlot = "account" | "mcp-oauth";

const ACTIVE_STATUSES: CodexDeviceAuthStatus[] = [
  "provisioning",
  "starting",
  "awaiting_user",
];

export class CodexAuthStore {
  constructor(private readonly pool: Pool) {}

  async createFlow(input: {
    userId: string;
    environmentId: string;
    expiresAt: Date;
  }) {
    const existing = await this.findActiveFlow(input.userId, input.environmentId);
    if (existing) return { flow: existing, created: false } as const;

    const id = `codex_auth_${randomUUID()}`;
    try {
      const result = await this.pool.query<FlowRow>(
        `
          INSERT INTO codex_device_auth_flows (
            id, environment_id, created_by_user_id, status, expires_at
          )
          SELECT $1, e.id, $2, 'provisioning', $4
          FROM environments e
          JOIN team_memberships m
            ON m.team_id = e.team_id
           AND m.user_id = $2
           AND m.status = 'active'
          WHERE e.id = $3 AND e.status <> 'archived'
            AND (
              e.created_by_user_id = $2
              OR (e.visibility = 'team' AND m.role IN ('owner', 'admin'))
            )
          RETURNING *
        `,
        [id, input.userId, input.environmentId, input.expiresAt],
      );
      const row = result.rows[0];
      if (!row) throw notFound("environment_not_found", "Environment not found.");
      return { flow: flowFromRow(row), created: true } as const;
    } catch (error) {
      // Concurrent starts converge on the environment's unique active-flow row.
      if (isUniqueViolation(error)) {
        const concurrent = await this.findActiveFlow(
          input.userId,
          input.environmentId,
        );
        if (concurrent) return { flow: concurrent, created: false } as const;
      }
      throw error;
    }
  }

  async findActiveFlow(userId: string, environmentId: string) {
    const result = await this.pool.query<FlowRow>(
      `${authorizedFlowSelect()}
       WHERE m.user_id = $1
         AND (
           e.created_by_user_id = $1
           OR (e.visibility = 'team' AND m.role IN ('owner', 'admin'))
         )
         AND f.environment_id = $2
         AND f.status = ANY($3::TEXT[])
         AND f.expires_at > NOW()
       ORDER BY f.created_at DESC
       LIMIT 1`,
      [userId, environmentId, ACTIVE_STATUSES],
    );
    return result.rows[0] ? flowFromRow(result.rows[0]) : undefined;
  }

  async findExpiredFlow(userId: string, environmentId: string) {
    const result = await this.pool.query<FlowRow>(
      `${authorizedFlowSelect()}
       WHERE m.user_id = $1
         AND (
           e.created_by_user_id = $1
           OR (e.visibility = 'team' AND m.role IN ('owner', 'admin'))
         )
         AND f.environment_id = $2
         AND f.status = ANY($3::TEXT[]) AND f.expires_at <= NOW()
       ORDER BY f.created_at DESC
       LIMIT 1`,
      [userId, environmentId, ACTIVE_STATUSES],
    );
    return result.rows[0] ? flowFromRow(result.rows[0]) : undefined;
  }

  async expiredFlows() {
    const result = await this.pool.query<FlowRow>(
      `SELECT * FROM codex_device_auth_flows
       WHERE status = ANY($1::TEXT[]) AND expires_at <= NOW()
       ORDER BY created_at`,
      [ACTIVE_STATUSES],
    );
    return result.rows.map(flowFromRow);
  }

  async getFlow(userId: string, environmentId: string, flowId: string) {
    const result = await this.pool.query<FlowRow>(
      `${authorizedFlowSelect()}
       WHERE m.user_id = $1
         AND (
           e.created_by_user_id = $1
           OR (e.visibility = 'team' AND m.role IN ('owner', 'admin'))
         )
         AND f.environment_id = $2 AND f.id = $3`,
      [userId, environmentId, flowId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("codex_auth_flow_not_found", "Login flow not found.");
    return flowFromRow(row);
  }

  async getFlowById(flowId: string) {
    const result = await this.pool.query<FlowRow>(
      "SELECT * FROM codex_device_auth_flows WHERE id = $1",
      [flowId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("codex_auth_flow_not_found", "Login flow not found.");
    return flowFromRow(row);
  }

  async resumableFlows() {
    const result = await this.pool.query<FlowRow>(
      `SELECT * FROM codex_device_auth_flows
       WHERE status IN ('starting', 'awaiting_user') AND expires_at > NOW()
       ORDER BY created_at`,
    );
    return result.rows.map(flowFromRow);
  }

  async failInterruptedProvisioningFlows() {
    await this.pool.query(
      `UPDATE codex_device_auth_flows
       SET status = 'failed',
           error = 'Sandpi restarted before the login sandbox was recorded.',
           updated_at = NOW()
       WHERE status = 'provisioning'`,
    );
  }

  async attachRuntime(flowId: string, runtime: CodexAuthRuntime) {
    const result = await this.pool.query<FlowRow>(
      `UPDATE codex_device_auth_flows
       SET status = 'starting', sandbox_id = $2, supervisor_session_id = $3,
           attempt_id = $4, runtime_generation = $5, updated_at = NOW()
       WHERE id = $1 AND status = 'provisioning'
       RETURNING *`,
      [
        flowId,
        runtime.sandboxId,
        runtime.supervisorSessionId,
        runtime.attemptId,
        runtime.runtimeGeneration,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Codex login flow is no longer provisioning");
    return flowFromRow(row);
  }

  async persistProtocol(
    flowId: string,
    state: CodexDecoderState,
    messages: readonly Record<string, unknown>[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<FlowRow>(
        "SELECT * FROM codex_device_auth_flows WHERE id = $1 FOR UPDATE",
        [flowId],
      );
      const row = locked.rows[0];
      if (!row) throw notFound("codex_auth_flow_not_found", "Login flow not found.");
      const protocolMessages = [...row.protocol_messages, ...messages].slice(-256);
      const result = await client.query<FlowRow>(
        `UPDATE codex_device_auth_flows
         SET supervisor_cursor = $2, stdout_tail = $3, attempt_id = $4,
             runtime_generation = $5, protocol_messages = $6::JSONB,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          flowId,
          state.supervisorCursor,
          state.tailBase64,
          state.attemptId ?? null,
          state.runtimeGeneration,
          JSON.stringify(protocolMessages),
        ],
      );
      await client.query("COMMIT");
      return flowFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAwaitingUser(
    flowId: string,
    value: { nativeLoginId: string; verificationUrl: string; userCode: string },
  ) {
    const result = await this.pool.query<FlowRow>(
      `UPDATE codex_device_auth_flows
       SET status = 'awaiting_user', native_login_id = $2,
           verification_url = $3, user_code = $4, updated_at = NOW()
       WHERE id = $1 AND status IN ('starting', 'awaiting_user')
       RETURNING *`,
      [flowId, value.nativeLoginId, value.verificationUrl, value.userCode],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Codex login flow cannot enter awaiting_user");
    return flowFromRow(row);
  }

  async markTerminal(
    flowId: string,
    status: Extract<CodexDeviceAuthStatus, "failed" | "cancelled" | "expired">,
    error?: string,
  ) {
    const result = await this.pool.query<FlowRow>(
      `UPDATE codex_device_auth_flows
       SET status = $2, error = $3, updated_at = NOW()
       WHERE id = $1 AND status = ANY($4::TEXT[])
       RETURNING *`,
      [flowId, status, error ?? null, ACTIVE_STATUSES],
    );
    return result.rows[0] ? flowFromRow(result.rows[0]) : this.getFlowById(flowId);
  }

  async completeWithCredential(input: {
    flowId: string;
    environmentId: string;
    encrypted: EncryptedValue;
    metadata: Record<string, unknown>;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lockedFlow = await client.query<FlowRow>(
        "SELECT * FROM codex_device_auth_flows WHERE id = $1 FOR UPDATE",
        [input.flowId],
      );
      const currentFlow = lockedFlow.rows[0];
      if (!currentFlow || currentFlow.environment_id !== input.environmentId) {
        throw notFound("codex_auth_flow_not_found", "Login flow not found.");
      }
      if (currentFlow.status === "completed") {
        await client.query("COMMIT");
        return flowFromRow(currentFlow);
      }
      if (!ACTIVE_STATUSES.includes(currentFlow.status)) {
        throw new Error(`Codex login flow is ${currentFlow.status}`);
      }
      await replaceEnvironmentCredentialSource(client, {
        environmentId: input.environmentId,
        encrypted: input.encrypted,
        metadata: input.metadata,
      });
      const flow = await client.query<FlowRow>(
        `UPDATE codex_device_auth_flows
         SET status = 'completed', error = NULL, updated_at = NOW()
         WHERE id = $1 AND environment_id = $2
         RETURNING *`,
        [input.flowId, input.environmentId],
      );
      await client.query("COMMIT");
      const row = flow.rows[0];
      if (!row) throw new Error("Codex login flow was not completed");
      return flowFromRow(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCredential(userId: string, environmentId: string) {
    const result = await this.pool.query<CredentialRow>(
      `SELECT c.*
       FROM harness_credentials c
       JOIN environments e ON e.id = c.environment_id
       JOIN team_memberships m
         ON m.team_id = e.team_id
        AND m.user_id = $1
        AND m.status = 'active'
       WHERE c.environment_id = $2 AND c.harness = 'codex'
         AND (e.visibility = 'team' OR e.created_by_user_id = $1)
         AND c.credential_slot = 'account'
         AND c.revoked_at IS NULL
       LIMIT 1`,
      [userId, environmentId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      sourceId: row.id,
      revision: row.revision,
      encrypted: {
        ciphertext: row.ciphertext,
        initializationVector: row.initialization_vector,
        authenticationTag: row.authentication_tag,
        algorithm: row.encryption_algorithm,
        keyId: row.encryption_key_id,
      } satisfies EncryptedValue,
      metadata: row.non_secret_metadata,
    };
  }

  /**
   * Deployment-side import for the documented headless Codex auth-cache
   * fallback. This is intentionally not exposed as a user HTTP endpoint.
   */
  async importCredential(input: {
    environmentId: string;
    encrypted: EncryptedValue;
    metadata: Record<string, unknown>;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const environment = await client.query(
        `SELECT id FROM environments
         WHERE id = $1 AND harness = 'codex' AND status <> 'archived'
         FOR UPDATE`,
        [input.environmentId],
      );
      if (!environment.rowCount) {
        throw notFound("environment_not_found", "Codex Environment not found.");
      }
      const credential = await replaceEnvironmentCredentialSource(client, input);
      await client.query("COMMIT");
      return credential;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCredentialForEnvironmentRuntime(environmentId: string) {
    const result = await this.pool.query<RuntimeCredentialRow>(
      `SELECT c.*, b.credential_source_id AS binding_source_id,
              b.source_revision AS binding_revision,
              b.status AS binding_status
       FROM harness_credentials c
       LEFT JOIN environment_credential_bindings b
         ON b.environment_id = c.environment_id
        AND b.harness = 'codex'
        AND b.credential_slot = 'account'
       WHERE c.environment_id = $1
        AND c.harness = 'codex'
        AND c.credential_slot = 'account'
        AND c.revoked_at IS NULL
       LIMIT 1`,
      [environmentId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      environmentId: row.environment_id,
      sourceId: row.id,
      revision: row.revision,
      encrypted: encryptedCredential(row),
      metadata: row.non_secret_metadata,
      bindingSourceId: row.binding_source_id ?? undefined,
      bindingRevision: row.binding_revision ?? undefined,
      bindingStatus: row.binding_status ?? undefined,
    };
  }

  async replaceCredentialFromEnvironment(
    environmentId: string,
    expectedSourceId: string | undefined,
    encrypted: EncryptedValue,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const environment = await client.query(
        `SELECT id FROM environments
         WHERE id = $1 AND harness = 'codex' AND status <> 'archived'
         FOR UPDATE`,
        [environmentId],
      );
      if (!environment.rowCount) {
        throw notFound("environment_not_found", "Environment not found.");
      }
      const current = await client.query<CredentialRow>(
        `SELECT * FROM harness_credentials
         WHERE environment_id = $1 AND harness = 'codex'
           AND credential_slot = 'account' AND revoked_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [environmentId],
      );
      const currentSource = current.rows[0];
      if (!currentSource) {
        throw new Error("Environment has no active Codex Credential Source");
      }
      const binding = await client.query<{ credential_source_id: string }>(
        `SELECT credential_source_id FROM environment_credential_bindings
         WHERE environment_id = $1 AND harness = 'codex'
           AND credential_slot = 'account'`,
        [environmentId],
      );
      const boundSourceId =
        expectedSourceId ?? binding.rows[0]?.credential_source_id;
      if (boundSourceId && currentSource.id !== boundSourceId) {
        await client.query(
          `UPDATE environment_credential_bindings
           SET status = 'stale', updated_at = NOW()
           WHERE environment_id = $1 AND harness = 'codex'
             AND credential_slot = 'account'
             AND status <> 'revoked'`,
          [environmentId],
        );
        await client.query("COMMIT");
        return { replaced: false as const, credential: credentialFromRow(currentSource) };
      }
      const next = await replaceEnvironmentCredentialSource(client, {
        environmentId,
        encrypted,
        metadata: currentSource.non_secret_metadata ?? { type: "chatgpt" },
      });
      await client.query(
        `UPDATE environment_credential_bindings
         SET status = 'active', credential_source_id = $2,
             source_revision = $3, last_synced_at = NOW(), updated_at = NOW()
         WHERE environment_id = $1 AND harness = 'codex'
           AND credential_slot = 'account'
           AND status <> 'revoked'`,
        [environmentId, next.sourceId, next.revision],
      );
      await client.query("COMMIT");
      return {
        replaced: true as const,
        credential: {
          sourceId: next.sourceId,
          revision: next.revision,
          encrypted,
          metadata: currentSource.non_secret_metadata,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markCredentialMaterialized(
    environmentId: string,
    sourceId: string,
    sourceRevision: number,
  ) {
    const result = await this.pool.query(
      `INSERT INTO environment_credential_bindings (
         id, environment_id, sandbox_id, credential_source_id, harness,
         credential_slot, source_revision, native_target_path, status
       )
       SELECT $1, e.id, r.sandbox_id, c.id, 'codex', 'account',
              c.revision, $5, 'active'
       FROM environments e
       JOIN environment_runtime r
         ON r.environment_id = e.id AND r.sandbox_id IS NOT NULL
       JOIN harness_credentials c
         ON c.id = $2
        AND c.environment_id = e.id
        AND c.harness = 'codex'
        AND c.credential_slot = 'account'
        AND c.revoked_at IS NULL
       WHERE e.id = $3 AND c.revision = $4
       ON CONFLICT (environment_id, harness, credential_slot) DO UPDATE
       SET sandbox_id = EXCLUDED.sandbox_id,
           credential_source_id = EXCLUDED.credential_source_id,
           source_revision = EXCLUDED.source_revision,
           native_target_path = EXCLUDED.native_target_path,
           status = 'active', materialized_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [
        `binding_${randomUUID()}`,
        sourceId,
        environmentId,
        sourceRevision,
        CODEX_ENVIRONMENT_CREDENTIAL_PATH,
      ],
    );
    if (!result.rowCount) {
      throw new Error("Codex Credential Source cannot be bound to this Environment");
    }
  }

  async getMcpOAuthCredentialForEnvironmentRuntime(environmentId: string) {
    const result = await this.pool.query<RuntimeCredentialRow>(
      `SELECT c.*, b.credential_source_id AS binding_source_id,
              b.source_revision AS binding_revision,
              b.status AS binding_status
       FROM harness_credentials c
       LEFT JOIN environment_credential_bindings b
         ON b.environment_id = c.environment_id
        AND b.harness = 'codex'
        AND b.credential_slot = 'mcp-oauth'
       WHERE c.environment_id = $1
         AND c.harness = 'codex'
         AND c.credential_slot = 'mcp-oauth'
         AND c.revoked_at IS NULL
       LIMIT 1`,
      [environmentId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      environmentId: row.environment_id,
      sourceId: row.id,
      revision: row.revision,
      encrypted: encryptedCredential(row),
      metadata: row.non_secret_metadata,
      bindingSourceId: row.binding_source_id ?? undefined,
      bindingRevision: row.binding_revision ?? undefined,
      bindingStatus: row.binding_status ?? undefined,
    };
  }

  async replaceMcpOAuthCredentialFromEnvironment(
    environmentId: string,
    expectedSourceId: string | undefined,
    encrypted: EncryptedValue,
    metadata: Record<string, unknown>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const environment = await client.query(
        `SELECT id FROM environments
         WHERE id = $1 AND harness = 'codex' AND status <> 'archived'
         FOR UPDATE`,
        [environmentId],
      );
      if (!environment.rowCount) {
        throw notFound("environment_not_found", "Environment not found.");
      }
      const current = await client.query<CredentialRow>(
        `SELECT * FROM harness_credentials
         WHERE environment_id = $1 AND harness = 'codex'
           AND credential_slot = 'mcp-oauth' AND revoked_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [environmentId],
      );
      const currentSource = current.rows[0];
      if (currentSource && currentSource.id !== expectedSourceId) {
        await client.query("COMMIT");
        return {
          replaced: false as const,
          credential: credentialFromRow(currentSource),
        };
      }
      const next = await replaceNativeCredentialSlot(client, {
        environmentId,
        slot: "mcp-oauth",
        credentialType: "codex-mcp-oauth-json",
        encrypted,
        metadata,
      });
      await client.query(
        `UPDATE environment_credential_bindings
         SET status = 'active', credential_source_id = $2,
             source_revision = $3, materialized_at = NOW(),
             last_synced_at = NOW(), updated_at = NOW()
         WHERE environment_id = $1 AND harness = 'codex'
           AND credential_slot = 'mcp-oauth'
           AND status <> 'revoked'`,
        [environmentId, next.sourceId, next.revision],
      );
      await client.query("COMMIT");
      return { replaced: true as const, credential: next };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeMcpOAuthCredentialFromEnvironment(
    environmentId: string,
    expectedSourceId: string | undefined,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const environment = await client.query(
        `SELECT id FROM environments
         WHERE id = $1 AND harness = 'codex' AND status <> 'archived'
         FOR UPDATE`,
        [environmentId],
      );
      if (!environment.rowCount) {
        throw notFound("environment_not_found", "Environment not found.");
      }
      const current = await client.query<CredentialRow>(
        `SELECT * FROM harness_credentials
         WHERE environment_id = $1 AND harness = 'codex'
           AND credential_slot = 'mcp-oauth' AND revoked_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [environmentId],
      );
      const currentSource = current.rows[0];
      if (currentSource && currentSource.id !== expectedSourceId) {
        await client.query("COMMIT");
        return {
          revoked: false as const,
          credential: credentialFromRow(currentSource),
        };
      }
      if (currentSource) {
        await client.query(
          `UPDATE harness_credentials
           SET revoked_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND revoked_at IS NULL`,
          [currentSource.id],
        );
      }
      await client.query(
        `UPDATE environment_credential_bindings
         SET status = 'revoked', last_synced_at = NOW(), updated_at = NOW()
         WHERE environment_id = $1 AND harness = 'codex'
           AND credential_slot = 'mcp-oauth'`,
        [environmentId],
      );
      await client.query("COMMIT");
      return { revoked: true as const };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markMcpOAuthCredentialMaterialized(
    environmentId: string,
    sourceId: string,
    sourceRevision: number,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT id FROM environments
         WHERE id = $1 AND harness = 'codex' AND status <> 'archived'
         FOR UPDATE`,
        [environmentId],
      );
      const result = await client.query(
        `INSERT INTO environment_credential_bindings (
           id, environment_id, sandbox_id, credential_source_id, harness,
           credential_slot, source_revision, native_target_path, status
         )
         SELECT $1, e.id, r.sandbox_id, c.id, 'codex', 'mcp-oauth',
                c.revision, $5, 'active'
         FROM environments e
         JOIN environment_runtime r
           ON r.environment_id = e.id AND r.sandbox_id IS NOT NULL
         JOIN harness_credentials c
           ON c.id = $2
          AND c.environment_id = e.id
          AND c.harness = 'codex'
          AND c.credential_slot = 'mcp-oauth'
          AND c.revoked_at IS NULL
         WHERE e.id = $3 AND c.revision = $4
         ON CONFLICT (environment_id, harness, credential_slot) DO UPDATE
         SET sandbox_id = EXCLUDED.sandbox_id,
             credential_source_id = EXCLUDED.credential_source_id,
             source_revision = EXCLUDED.source_revision,
             native_target_path = EXCLUDED.native_target_path,
             status = 'active', materialized_at = NOW(), updated_at = NOW()
         RETURNING id`,
        [
          `binding_${randomUUID()}`,
          sourceId,
          environmentId,
          sourceRevision,
          CODEX_MCP_OAUTH_CREDENTIAL_PATH,
        ],
      );
      if (!result.rowCount) {
        throw new Error(
          "Codex MCP OAuth credential cannot be bound to this Environment",
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
}

export function publicCodexDeviceAuthFlow(
  flow: CodexDeviceAuthFlow,
): PublicCodexDeviceAuthFlow {
  return {
    id: flow.id,
    environmentId: flow.environmentId,
    status: flow.status,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    error: flow.error,
    expiresAt: toUnixTimestamp(flow.expiresAt),
    createdAt: toUnixTimestamp(flow.createdAt),
    updatedAt: toUnixTimestamp(flow.updatedAt),
  };
}

function authorizedFlowSelect() {
  return `SELECT f.*
          FROM codex_device_auth_flows f
          JOIN environments e ON e.id = f.environment_id
          JOIN team_memberships m
            ON m.team_id = e.team_id
           AND m.status = 'active'`;
}

function encryptedCredential(row: CredentialRow): EncryptedValue {
  return {
    ciphertext: row.ciphertext,
    initializationVector: row.initialization_vector,
    authenticationTag: row.authentication_tag,
    algorithm: row.encryption_algorithm,
    keyId: row.encryption_key_id,
  };
}

function credentialFromRow(row: CredentialRow) {
  return {
    sourceId: row.id,
    revision: row.revision,
    encrypted: encryptedCredential(row),
    metadata: row.non_secret_metadata,
  };
}

async function replaceEnvironmentCredentialSource(
  client: PoolClient,
  input: {
    environmentId: string;
    encrypted: EncryptedValue;
    metadata: Record<string, unknown>;
  },
) {
  const environment = await client.query<{ credential_revision: number }>(
    `SELECT credential_revision FROM environments
     WHERE id = $1 AND harness = 'codex' AND status <> 'archived'
     FOR UPDATE`,
    [input.environmentId],
  );
  if (!environment.rowCount) {
    throw notFound("environment_not_found", "Codex Environment not found.");
  }
  const revision = Number(environment.rows[0]?.credential_revision ?? 0) + 1;
  const sourceId = `credential_${randomUUID()}`;
  await client.query(
    `UPDATE harness_credentials
     SET revoked_at = NOW(), updated_at = NOW()
     WHERE environment_id = $1 AND harness = 'codex'
       AND credential_slot = 'account' AND revoked_at IS NULL`,
    [input.environmentId],
  );
  await client.query(
    `INSERT INTO harness_credentials (
       id, environment_id, harness, credential_slot, revision,
       credential_type, ciphertext,
       initialization_vector, authentication_tag, encryption_algorithm,
       encryption_key_id, non_secret_metadata, last_verified_at
     ) VALUES (
       $1, $2, 'codex', 'account', $3, 'codex-native-auth-json', $4, $5, $6,
       $7, $8, $9::JSONB, NOW()
     )`,
    [
      sourceId,
      input.environmentId,
      revision,
      input.encrypted.ciphertext,
      input.encrypted.initializationVector,
      input.encrypted.authenticationTag,
      input.encrypted.algorithm,
      input.encrypted.keyId,
      JSON.stringify(input.metadata),
    ],
  );
  await client.query(
    `UPDATE environment_credential_bindings
     SET status = 'stale', updated_at = NOW()
     WHERE environment_id = $1 AND harness = 'codex'
       AND credential_slot = 'account'
       AND status <> 'revoked'`,
    [input.environmentId],
  );
  await client.query(
    `UPDATE environments
     SET credential_revision = $2,
         harness_metadata = harness_metadata || $3::JSONB,
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.environmentId,
      revision,
      JSON.stringify({
        status: "connected",
        account:
          typeof input.metadata.email === "string"
            ? input.metadata.email
            : typeof input.metadata.account === "string"
              ? input.metadata.account
              : "Codex",
        lastVerified: toUnixTimestamp(new Date()),
      }),
    ],
  );
  return { sourceId, revision, encrypted: input.encrypted, metadata: input.metadata };
}

async function replaceNativeCredentialSlot(
  client: PoolClient,
  input: {
    environmentId: string;
    slot: CodexCredentialSlot;
    credentialType: string;
    encrypted: EncryptedValue;
    metadata: Record<string, unknown>;
  },
) {
  const revisionResult = await client.query<{ revision: number }>(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
     FROM harness_credentials
     WHERE environment_id = $1 AND harness = 'codex'
       AND credential_slot = $2`,
    [input.environmentId, input.slot],
  );
  const revision = Number(revisionResult.rows[0]?.revision ?? 1);
  const sourceId = `credential_${randomUUID()}`;
  await client.query(
    `UPDATE harness_credentials
     SET revoked_at = NOW(), updated_at = NOW()
     WHERE environment_id = $1 AND harness = 'codex'
       AND credential_slot = $2 AND revoked_at IS NULL`,
    [input.environmentId, input.slot],
  );
  await client.query(
    `INSERT INTO harness_credentials (
       id, environment_id, harness, credential_slot, revision,
       credential_type, ciphertext, initialization_vector,
       authentication_tag, encryption_algorithm, encryption_key_id,
       non_secret_metadata, last_verified_at
     ) VALUES (
       $1, $2, 'codex', $3, $4, $5, $6, $7, $8, $9, $10, $11::JSONB, NOW()
     )`,
    [
      sourceId,
      input.environmentId,
      input.slot,
      revision,
      input.credentialType,
      input.encrypted.ciphertext,
      input.encrypted.initializationVector,
      input.encrypted.authenticationTag,
      input.encrypted.algorithm,
      input.encrypted.keyId,
      JSON.stringify(input.metadata),
    ],
  );
  await client.query(
    `UPDATE environment_credential_bindings
     SET status = 'stale', updated_at = NOW()
     WHERE environment_id = $1 AND harness = 'codex'
       AND credential_slot = $2 AND status <> 'revoked'`,
    [input.environmentId, input.slot],
  );
  return {
    sourceId,
    revision,
    encrypted: input.encrypted,
    metadata: input.metadata,
  };
}

function flowFromRow(row: FlowRow): CodexDeviceAuthFlow {
  const hasRuntime =
    row.sandbox_id && row.supervisor_session_id && row.attempt_id;
  return {
    id: row.id,
    environmentId: row.environment_id,
    status: row.status,
    runtime: hasRuntime
      ? {
          sandboxId: row.sandbox_id!,
          supervisorSessionId: row.supervisor_session_id!,
          attemptId: row.attempt_id!,
          runtimeGeneration: Number(row.runtime_generation),
        }
      : undefined,
    decoder: {
      supervisorCursor: Number(row.supervisor_cursor),
      tailBase64: row.stdout_tail,
      attemptId: row.attempt_id ?? undefined,
      runtimeGeneration: Number(row.runtime_generation),
    },
    nativeLoginId: row.native_login_id ?? undefined,
    verificationUrl: row.verification_url ?? undefined,
    userCode: row.user_code ?? undefined,
    protocolMessages: row.protocol_messages ?? [],
    error: row.error ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}
