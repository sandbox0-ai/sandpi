import { randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

import { normalizeNetworkDomain } from "@/lib/network-policy";
import { conflict, notFound } from "@/server/http-error";
import type { ManagedMcpCredentialBinding } from "@/server/runtime/network-policy";

export type McpIntegrationAuthMode = "none" | "oauth" | "bearer" | "header";
export type McpToolPolicyMode = "all" | "selected";
export type McpToolPolicyStatus = "active" | "updating" | "error";

export type McpIntegrationLifecycleStatus =
  | "provisioning"
  | "active"
  | "updating"
  | "deleting"
  | "error";

export type McpIntegrationCredentialStatus =
  | "not-required"
  | "missing"
  | "configured"
  | "authorizing"
  | "authorized"
  | "reauth-required"
  | "error";

export interface EnvironmentMcpIntegration {
  environmentId: string;
  serverName: string;
  presetId?: string;
  authMode: McpIntegrationAuthMode;
  credentialSourceRef?: string;
  credentialBindingRef?: string;
  credentialHeaderName?: string;
  credentialValueTemplate?: string;
  bindingEnabled?: boolean;
  pendingCredentialSourceRef?: string;
  pendingCredentialBindingRef?: string;
  pendingCredentialHeaderName?: string;
  pendingCredentialValueTemplate?: string;
  retiringCredentialSourceRef?: string;
  oauthConfigFingerprint?: string;
  version?: number;
  endpointFingerprint: string;
  destinationDomain: string;
  destinationPath: string;
  toolPolicyMode: McpToolPolicyMode;
  allowedTools: string[];
  toolPolicyStatus: McpToolPolicyStatus;
  toolPolicyError?: string;
  lifecycleStatus: McpIntegrationLifecycleStatus;
  credentialStatus: McpIntegrationCredentialStatus;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertEnvironmentMcpIntegration {
  environmentId: string;
  serverName: string;
  presetId?: string;
  authMode: McpIntegrationAuthMode;
  credentialSourceRef?: string;
  credentialBindingRef?: string;
  credentialHeaderName?: string;
  credentialValueTemplate?: string;
  bindingEnabled?: boolean;
  endpointFingerprint: string;
  destinationDomain: string;
  destinationPath: string;
  lifecycleStatus?: McpIntegrationLifecycleStatus;
  credentialStatus?: McpIntegrationCredentialStatus;
  lastError?: string;
}

export type McpOAuthFlowStatus =
  | "starting"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * Durable coordinates of one decoded native Codex record. Codex does not
 * always expose an attempt id, so the persistence boundary normalizes an
 * absent attempt to the empty string.
 */
export interface CodexMcpNativeEventIdentity {
  runtimeGeneration: number;
  supervisorSequence: number;
  recordIndex: number;
  attemptId?: string;
}

export type CodexMcpNativeRuntimeIdentity = Pick<
  CodexMcpNativeEventIdentity,
  "runtimeGeneration" | "attemptId"
>;

export interface EnvironmentMcpOAuthFlow {
  id: string;
  environmentId: string;
  serverName: string;
  configFingerprint: string;
  endpointFingerprint: string;
  status: McpOAuthFlowStatus;
  nativeThreadId?: string;
  nativeRuntime?: CodexMcpNativeRuntimeIdentity;
  nativeThreadCleanupCompletedAt?: Date;
  error?: string;
  cleanupCompletedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IntegrationRow extends QueryResultRow {
  environment_id: string;
  server_name: string;
  preset_id: string | null;
  auth_mode: McpIntegrationAuthMode;
  credential_source_ref: string | null;
  credential_binding_ref: string | null;
  credential_header_name: string | null;
  credential_value_template: string | null;
  binding_enabled: boolean;
  pending_credential_source_ref: string | null;
  pending_credential_binding_ref: string | null;
  pending_credential_header_name: string | null;
  pending_credential_value_template: string | null;
  retiring_credential_source_ref: string | null;
  oauth_config_fingerprint: string | null;
  version: string | number;
  endpoint_fingerprint: string;
  destination_domain: string;
  destination_path: string;
  tool_policy_mode: McpToolPolicyMode;
  allowed_tools: string[];
  tool_policy_status: McpToolPolicyStatus;
  tool_policy_error: string | null;
  lifecycle_status: McpIntegrationLifecycleStatus;
  credential_status: McpIntegrationCredentialStatus;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface OAuthFlowRow extends QueryResultRow {
  id: string;
  environment_id: string;
  server_name: string;
  config_fingerprint: string;
  endpoint_fingerprint: string;
  status: McpOAuthFlowStatus;
  native_thread_id: string | null;
  native_runtime_generation: string | number | null;
  native_attempt_id: string | null;
  native_thread_cleanup_completed_at: Date | string | null;
  error: string | null;
  cleanup_completed_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OAuthTerminalEventOutcomeRow extends QueryResultRow {
  disposition: "applied" | "duplicate" | "stale";
  flow: OAuthFlowRow | null;
}

const ACTIVE_OAUTH_FLOW_STATUSES: McpOAuthFlowStatus[] = [
  "starting",
  "awaiting_user",
];
const BLOCKING_OAUTH_FLOW_STATUSES: McpOAuthFlowStatus[] = [
  ...ACTIVE_OAUTH_FLOW_STATUSES,
  "cancelled",
];
const TERMINAL_OAUTH_FLOW_STATUSES: McpOAuthFlowStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "expired",
];

export const MCP_TOKEN_VALUE_TEMPLATE = "{{ .token }}";
export const MCP_BEARER_VALUE_TEMPLATE = `Bearer ${MCP_TOKEN_VALUE_TEMPLATE}`;

/**
 * Persists only Sandpi's non-sensitive MCP orchestration metadata. Codex owns
 * native MCP definitions and Sandbox0 owns static credential values.
 */
export class EnvironmentMcpIntegrationStore {
  constructor(private readonly pool: Pool) {}

  async listIntegrations(userId: string, environmentId: string) {
    await this.assertEnvironmentAccess(userId, environmentId);
    const result = await this.pool.query<IntegrationRow>(
      `SELECT integration.*
       FROM environment_mcp_integrations integration
       WHERE integration.environment_id = $1
       ORDER BY integration.server_name`,
      [environmentId],
    );
    return result.rows.map(integrationFromRow);
  }

  async getIntegration(
    userId: string,
    environmentId: string,
    serverName: string,
  ) {
    await this.assertEnvironmentAccess(userId, environmentId);
    const result = await this.pool.query<IntegrationRow>(
      `SELECT *
       FROM environment_mcp_integrations
       WHERE environment_id = $1 AND server_name = $2`,
      [environmentId, serverName],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound("mcp_integration_not_found", "MCP integration not found.");
    }
    return integrationFromRow(row);
  }

  async listActiveStaticIntegrationsForRuntime(environmentId: string) {
    const result = await this.pool.query<IntegrationRow>(
      `SELECT *
       FROM environment_mcp_integrations
       WHERE environment_id = $1
         AND auth_mode IN ('bearer', 'header')
         AND lifecycle_status <> 'deleting'
         AND binding_enabled = TRUE
         AND credential_status IN ('configured', 'authorized')
         AND credential_source_ref IS NOT NULL
         AND credential_binding_ref IS NOT NULL
       ORDER BY server_name`,
      [environmentId],
    );
    return result.rows.map(integrationFromRow);
  }

  async listToolPolicyIntegrationsForRuntime(environmentId: string) {
    const result = await this.pool.query<IntegrationRow>(
      `SELECT *
       FROM environment_mcp_integrations
       WHERE environment_id = $1
       ORDER BY server_name`,
      [environmentId],
    );
    return result.rows.map(integrationFromRow);
  }

  async listReconciliationCandidatesForRuntime() {
    const result = await this.pool.query<IntegrationRow>(
      `SELECT integration.*
       FROM environment_mcp_integrations integration
       JOIN environments environment
         ON environment.id = integration.environment_id
       WHERE environment.status <> 'archived'
         AND (
           integration.lifecycle_status <> 'active'
           OR integration.credential_status = 'error'
           OR integration.tool_policy_status <> 'active'
           OR integration.pending_credential_source_ref IS NOT NULL
           OR integration.retiring_credential_source_ref IS NOT NULL
         )
       ORDER BY integration.environment_id, integration.server_name`,
    );
    return result.rows.map(integrationFromRow);
  }

  async getIntegrationForRuntime(
    environmentId: string,
    serverName: string,
  ) {
    const result = await this.pool.query<IntegrationRow>(
      `SELECT *
       FROM environment_mcp_integrations
       WHERE environment_id = $1 AND server_name = $2`,
      [environmentId, serverName],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound("mcp_integration_not_found", "MCP integration not found.");
    }
    return integrationFromRow(row);
  }

  async upsertIntegration(
    userId: string,
    input: UpsertEnvironmentMcpIntegration,
  ) {
    const normalized = normalizeIntegrationInput(input);
    const result = await this.pool.query<IntegrationRow>(
      `INSERT INTO environment_mcp_integrations AS integration (
         environment_id, server_name, preset_id, auth_mode,
         credential_source_ref, credential_binding_ref,
         credential_header_name, credential_value_template,
         binding_enabled,
         endpoint_fingerprint, destination_domain, destination_path,
         lifecycle_status, credential_status, last_error
       )
       SELECT environment.id, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $12, $13, $14, $15, $16
       FROM environments environment
       WHERE environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
       ON CONFLICT (environment_id, server_name) DO UPDATE
       SET preset_id = EXCLUDED.preset_id,
           auth_mode = EXCLUDED.auth_mode,
           credential_source_ref = EXCLUDED.credential_source_ref,
           credential_binding_ref = EXCLUDED.credential_binding_ref,
           credential_header_name = EXCLUDED.credential_header_name,
           credential_value_template = EXCLUDED.credential_value_template,
           binding_enabled = EXCLUDED.binding_enabled,
           endpoint_fingerprint = EXCLUDED.endpoint_fingerprint,
           destination_domain = EXCLUDED.destination_domain,
           destination_path = EXCLUDED.destination_path,
           lifecycle_status = EXCLUDED.lifecycle_status,
           credential_status = EXCLUDED.credential_status,
           last_error = EXCLUDED.last_error,
           oauth_config_fingerprint = CASE
             WHEN integration.auth_mode = EXCLUDED.auth_mode
              AND integration.endpoint_fingerprint =
                  EXCLUDED.endpoint_fingerprint
               THEN integration.oauth_config_fingerprint
             ELSE NULL
           END,
           version = integration.version + 1
       WHERE integration.pending_credential_source_ref IS NULL
         AND integration.retiring_credential_source_ref IS NULL
         AND integration.credential_source_ref IS NOT DISTINCT FROM
             EXCLUDED.credential_source_ref
         AND integration.credential_binding_ref IS NOT DISTINCT FROM
             EXCLUDED.credential_binding_ref
         AND integration.credential_header_name IS NOT DISTINCT FROM
             EXCLUDED.credential_header_name
         AND integration.credential_value_template IS NOT DISTINCT FROM
             EXCLUDED.credential_value_template
       RETURNING *`,
      [
        userId,
        normalized.environmentId,
        normalized.serverName,
        normalized.presetId ?? null,
        normalized.authMode,
        normalized.credentialSourceRef ?? null,
        normalized.credentialBindingRef ?? null,
        normalized.credentialHeaderName ?? null,
        normalized.credentialValueTemplate ?? null,
        normalized.bindingEnabled,
        normalized.endpointFingerprint,
        normalized.destinationDomain,
        normalized.destinationPath,
        normalized.lifecycleStatus,
        normalized.credentialStatus,
        normalized.lastError ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      await this.assertEnvironmentAccess(userId, normalized.environmentId);
      throw integrationChanged();
    }
    return integrationFromRow(row);
  }

  async setToolPolicy(
    userId: string,
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedEndpointFingerprint: string;
      mode: McpToolPolicyMode;
      allowedTools: readonly string[];
    },
  ) {
    assertVersion(input.expectedVersion);
    assertSha256Fingerprint(input.expectedEndpointFingerprint, "MCP endpoint");
    const allowedTools = normalizeAllowedTools(input.mode, input.allowedTools);
    await this.assertEnvironmentAccess(userId, environmentId);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET tool_policy_mode = $6,
           allowed_tools = $7::TEXT[],
           tool_policy_status = 'updating',
           tool_policy_error = NULL,
           version = integration.version + 1
       FROM environments environment
       WHERE integration.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND integration.server_name = $3
         AND integration.lifecycle_status <> 'deleting'
         AND integration.version = $4
         AND integration.endpoint_fingerprint = $5
       RETURNING integration.*`,
      [
        userId,
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedEndpointFingerprint.toLowerCase(),
        input.mode,
        allowedTools,
      ],
    );
    const row = result.rows[0];
    if (!row) throw integrationChanged();
    return integrationFromRow(row);
  }

  async markToolPolicyErrorForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedEndpointFingerprint: string;
      error: string;
    },
  ) {
    assertSha256Fingerprint(input.expectedEndpointFingerprint, "MCP endpoint");
    const error = requiredNonEmpty(input.error, "MCP tool policy error");
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations
       SET tool_policy_status = 'error',
           tool_policy_error = $4,
           version = version + 1
       WHERE environment_id = $1
         AND server_name = $2
         AND endpoint_fingerprint = $3
         AND lifecycle_status <> 'deleting'
       RETURNING *`,
      [
        environmentId,
        serverName,
        input.expectedEndpointFingerprint.toLowerCase(),
        error,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async markToolPoliciesActiveForRuntime(environmentId: string) {
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations
       SET tool_policy_status = 'active',
           tool_policy_error = NULL,
           version = version + 1
       WHERE environment_id = $1
         AND tool_policy_status <> 'active'
       RETURNING *`,
      [environmentId],
    );
    return result.rows.map(integrationFromRow);
  }

  async markIntegration(
    userId: string,
    environmentId: string,
    serverName: string,
    update: {
      lifecycleStatus: McpIntegrationLifecycleStatus;
      credentialStatus?: McpIntegrationCredentialStatus;
      lastError?: string | null;
    },
  ) {
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET lifecycle_status = $4,
           credential_status = CASE WHEN $5 THEN $6 ELSE credential_status END,
           last_error = CASE WHEN $7 THEN $8 ELSE last_error END,
           version = integration.version + 1
       FROM environments environment
       WHERE integration.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND integration.server_name = $3
       RETURNING integration.*`,
      [
        userId,
        environmentId,
        serverName,
        update.lifecycleStatus,
        update.credentialStatus !== undefined,
        update.credentialStatus ?? null,
        update.lastError !== undefined,
        update.lastError ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound("mcp_integration_not_found", "MCP integration not found.");
    }
    return integrationFromRow(row);
  }

  async markIntegrationForRuntime(
    environmentId: string,
    serverName: string,
    update: {
      lifecycleStatus: McpIntegrationLifecycleStatus;
      credentialStatus?: McpIntegrationCredentialStatus;
      lastError?: string | null;
      expectedEndpointFingerprint?: string;
    },
  ) {
    if (update.expectedEndpointFingerprint) {
      assertSha256Fingerprint(
        update.expectedEndpointFingerprint,
        "MCP endpoint",
      );
    }
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations
       SET lifecycle_status = $3,
           credential_status = CASE WHEN $4 THEN $5 ELSE credential_status END,
           last_error = CASE WHEN $6 THEN $7 ELSE last_error END,
           version = version + 1
       WHERE environment_id = $1
         AND server_name = $2
         AND ($8::TEXT IS NULL OR endpoint_fingerprint = $8)
         AND (
           NOT $4
           OR $5::TEXT IS DISTINCT FROM 'authorized'
         )
         AND (
           auth_mode NOT IN ('bearer', 'header')
           OR lifecycle_status = 'active'
         )
       RETURNING *`,
      [
        environmentId,
        serverName,
        update.lifecycleStatus,
        update.credentialStatus !== undefined,
        update.credentialStatus ?? null,
        update.lastError !== undefined,
        update.lastError ?? null,
        update.expectedEndpointFingerprint?.toLowerCase() ?? null,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async clearStaticCredentialForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedSourceRef: string;
    },
  ) {
    assertVersion(input.expectedVersion);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET credential_source_ref = NULL,
           credential_binding_ref = NULL,
           binding_enabled = FALSE,
           lifecycle_status = CASE
             WHEN pending_credential_source_ref IS NULL
              AND retiring_credential_source_ref IS NULL
               THEN 'active'
             ELSE 'deleting'
           END,
           credential_status = 'missing',
           last_error = NULL,
           version = integration.version + 1
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status = 'deleting'
         AND integration.version = $3
         AND integration.credential_source_ref = $4
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedSourceRef,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async clearPendingStaticCredentialForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedPendingSourceRef: string;
    },
  ) {
    assertVersion(input.expectedVersion);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET pending_credential_source_ref = NULL,
           pending_credential_binding_ref = NULL,
           pending_credential_header_name = NULL,
           pending_credential_value_template = NULL,
           binding_enabled = FALSE,
           lifecycle_status = CASE
             WHEN credential_source_ref IS NULL
              AND retiring_credential_source_ref IS NULL
               THEN 'active'
             ELSE 'deleting'
           END,
           credential_status = CASE
             WHEN credential_source_ref IS NULL THEN 'missing'
             ELSE credential_status
           END,
           last_error = NULL,
           version = integration.version + 1
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status = 'deleting'
         AND integration.version = $3
         AND integration.pending_credential_source_ref = $4
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedPendingSourceRef,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async clearRetiringStaticCredentialForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedRetiringSourceRef: string;
    },
  ) {
    assertVersion(input.expectedVersion);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET retiring_credential_source_ref = NULL,
           binding_enabled = FALSE,
           lifecycle_status = CASE
             WHEN credential_source_ref IS NULL
              AND pending_credential_source_ref IS NULL
               THEN 'active'
             ELSE 'deleting'
           END,
           last_error = NULL,
           version = integration.version + 1
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status = 'deleting'
         AND integration.version = $3
         AND integration.retiring_credential_source_ref = $4
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedRetiringSourceRef,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async finishStaticCredentialDeletionForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedEndpointFingerprint: string;
    },
  ) {
    assertVersion(input.expectedVersion);
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET binding_enabled = FALSE,
           lifecycle_status = 'active',
           credential_status = 'missing',
           last_error = NULL,
           version = integration.version + 1
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status = 'deleting'
         AND integration.version = $3
         AND integration.endpoint_fingerprint = $4
         AND integration.credential_source_ref IS NULL
         AND integration.pending_credential_source_ref IS NULL
         AND integration.retiring_credential_source_ref IS NULL
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedEndpointFingerprint.toLowerCase(),
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async beginStaticCredentialPending(
    userId: string,
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedEndpointFingerprint: string;
      expectedCurrentSourceRef: string | null;
      pendingSourceRef: string;
      pendingBindingRef: string;
      credentialHeaderName: string;
      credentialValueTemplate: string;
    },
  ) {
    await this.assertEnvironmentAccess(userId, environmentId);
    assertVersion(input.expectedVersion);
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const pendingSourceRef = requiredNonEmpty(
      input.pendingSourceRef,
      "MCP pending credential source ref",
    );
    const pendingBindingRef = requiredNonEmpty(
      input.pendingBindingRef,
      "MCP pending credential binding ref",
    );
    const projection = normalizeStaticProjectionMetadata(
      input.credentialHeaderName,
      input.credentialValueTemplate,
    );
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET pending_credential_source_ref = $7,
           pending_credential_binding_ref = $8,
           pending_credential_header_name = $9,
           pending_credential_value_template = $10,
           lifecycle_status = 'updating',
           last_error = NULL,
           version = integration.version + 1
       FROM environments environment
       JOIN environment_runtime runtime
         ON runtime.environment_id = environment.id
       WHERE integration.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND runtime.desired_state <> 'terminated'
         AND integration.server_name = $3
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status = 'active'
         AND integration.version = $4
         AND integration.endpoint_fingerprint = $5
         AND integration.credential_source_ref IS NOT DISTINCT FROM $6
         AND integration.pending_credential_source_ref IS NULL
         AND integration.retiring_credential_source_ref IS NULL
       RETURNING integration.*`,
      [
        userId,
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedEndpointFingerprint.toLowerCase(),
        input.expectedCurrentSourceRef,
        pendingSourceRef,
        pendingBindingRef,
        projection.headerName,
        projection.valueTemplate,
      ],
    );
    const row = result.rows[0];
    if (!row) throw integrationChanged();
    return integrationFromRow(row);
  }

  async promoteStaticCredentialPending(
    userId: string,
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedEndpointFingerprint: string;
      expectedPendingSourceRef: string;
      bindingEnabled: boolean;
    },
  ) {
    await this.assertEnvironmentAccess(userId, environmentId);
    assertVersion(input.expectedVersion);
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET retiring_credential_source_ref = credential_source_ref,
           credential_source_ref = pending_credential_source_ref,
           credential_binding_ref = pending_credential_binding_ref,
           credential_header_name = pending_credential_header_name,
           credential_value_template = pending_credential_value_template,
           pending_credential_source_ref = NULL,
           pending_credential_binding_ref = NULL,
           pending_credential_header_name = NULL,
           pending_credential_value_template = NULL,
           binding_enabled = $7,
           lifecycle_status = 'updating',
           credential_status = 'configured',
           last_error = NULL,
           version = integration.version + 1
       FROM environments environment
       JOIN environment_runtime runtime
         ON runtime.environment_id = environment.id
       WHERE integration.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND runtime.desired_state <> 'terminated'
         AND integration.server_name = $3
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status = 'updating'
         AND integration.version = $4
         AND integration.endpoint_fingerprint = $5
         AND integration.pending_credential_source_ref = $6
         AND integration.pending_credential_binding_ref IS NOT NULL
         AND integration.pending_credential_header_name IS NOT NULL
         AND integration.pending_credential_value_template IS NOT NULL
         AND integration.retiring_credential_source_ref IS NULL
       RETURNING integration.*`,
      [
        userId,
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedEndpointFingerprint.toLowerCase(),
        input.expectedPendingSourceRef,
        input.bindingEnabled,
      ],
    );
    const row = result.rows[0];
    if (!row) throw integrationChanged();
    return integrationFromRow(row);
  }

  async abortStaticCredentialPending(
    userId: string,
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedPendingSourceRef: string;
    },
  ) {
    await this.assertEnvironmentAccess(userId, environmentId);
    assertVersion(input.expectedVersion);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET pending_credential_source_ref = NULL,
           pending_credential_binding_ref = NULL,
           pending_credential_header_name = NULL,
           pending_credential_value_template = NULL,
           lifecycle_status = 'active',
           credential_status = CASE
             WHEN credential_source_ref IS NULL THEN 'missing'
             ELSE credential_status
           END,
           last_error = NULL,
           version = integration.version + 1
       FROM environments environment
       WHERE integration.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND integration.server_name = $3
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status IN ('updating', 'error')
         AND integration.version = $4
         AND integration.pending_credential_source_ref = $5
       RETURNING integration.*`,
      [
        userId,
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedPendingSourceRef,
      ],
    );
    const row = result.rows[0];
    if (!row) throw integrationChanged();
    return integrationFromRow(row);
  }

  async abortStaticCredentialPendingForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedPendingSourceRef: string;
    },
  ) {
    assertVersion(input.expectedVersion);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET pending_credential_source_ref = NULL,
           pending_credential_binding_ref = NULL,
           pending_credential_header_name = NULL,
           pending_credential_value_template = NULL,
           lifecycle_status = 'active',
           credential_status = CASE
             WHEN credential_source_ref IS NULL THEN 'missing'
             ELSE credential_status
           END,
           last_error = NULL,
           version = integration.version + 1
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status IN ('updating', 'error')
         AND integration.version = $3
         AND integration.pending_credential_source_ref = $4
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedPendingSourceRef,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async finishStaticCredentialRetirement(
    userId: string,
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedRetiringSourceRef: string;
    },
  ) {
    await this.assertEnvironmentAccess(userId, environmentId);
    assertVersion(input.expectedVersion);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET retiring_credential_source_ref = NULL,
           lifecycle_status = 'active',
           last_error = NULL,
           version = integration.version + 1
       FROM environments environment
       WHERE integration.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND integration.server_name = $3
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status IN ('updating', 'error')
         AND integration.version = $4
         AND integration.retiring_credential_source_ref = $5
         AND integration.pending_credential_source_ref IS NULL
       RETURNING integration.*`,
      [
        userId,
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedRetiringSourceRef,
      ],
    );
    const row = result.rows[0];
    if (!row) throw integrationChanged();
    return integrationFromRow(row);
  }

  async finishStaticCredentialRetirementForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedRetiringSourceRef: string;
    },
  ) {
    assertVersion(input.expectedVersion);
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET retiring_credential_source_ref = NULL,
           lifecycle_status = 'active',
           last_error = NULL,
           version = integration.version + 1
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status IN ('updating', 'error')
         AND integration.version = $3
         AND integration.retiring_credential_source_ref = $4
         AND integration.pending_credential_source_ref IS NULL
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedRetiringSourceRef,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async markStaticCredentialActiveForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedEndpointFingerprint: string;
      expectedSourceRef: string | null;
      expectedBindingEnabled: boolean;
    },
  ) {
    assertVersion(input.expectedVersion);
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET lifecycle_status = 'active',
           last_error = NULL,
           version = integration.version + 1
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status IN ('updating', 'error')
         AND integration.version = $3
         AND integration.endpoint_fingerprint = $4
         AND integration.credential_source_ref IS NOT DISTINCT FROM $5
         AND integration.binding_enabled = $6
         AND integration.pending_credential_source_ref IS NULL
         AND integration.retiring_credential_source_ref IS NULL
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedEndpointFingerprint.toLowerCase(),
        input.expectedSourceRef,
        input.expectedBindingEnabled,
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async setBindingEnabled(
    userId: string,
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedEndpointFingerprint: string;
      expectedSourceRef: string | null;
      enabled: boolean;
    },
  ) {
    await this.assertEnvironmentAccess(userId, environmentId);
    assertVersion(input.expectedVersion);
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<IntegrationRow>(
      `UPDATE environment_mcp_integrations integration
       SET binding_enabled = $7,
           lifecycle_status = 'updating',
           last_error = NULL,
           version = integration.version + 1
       FROM environments environment
       JOIN environment_runtime runtime
         ON runtime.environment_id = environment.id
       WHERE integration.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND integration.server_name = $3
         AND integration.auth_mode IN ('bearer', 'header')
         AND integration.lifecycle_status = 'active'
         AND integration.version = $4
         AND integration.endpoint_fingerprint = $5
         AND integration.credential_source_ref IS NOT DISTINCT FROM $6
         AND (
           NOT $7
           OR (
             runtime.desired_state <> 'terminated'
             AND integration.credential_source_ref IS NOT NULL
             AND integration.credential_binding_ref IS NOT NULL
             AND integration.credential_status IN ('configured', 'authorized')
           )
         )
       RETURNING integration.*`,
      [
        userId,
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedEndpointFingerprint.toLowerCase(),
        input.expectedSourceRef,
        input.enabled,
      ],
    );
    const row = result.rows[0];
    if (!row) throw integrationChanged();
    return integrationFromRow(row);
  }

  async deleteIntegration(
    userId: string,
    environmentId: string,
    serverName: string,
  ) {
    const result = await this.pool.query<IntegrationRow>(
      `DELETE FROM environment_mcp_integrations integration
       USING environments environment
       WHERE integration.environment_id = environment.id
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND integration.environment_id = $2
         AND integration.server_name = $3
         AND integration.credential_source_ref IS NULL
         AND integration.pending_credential_source_ref IS NULL
         AND integration.retiring_credential_source_ref IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM environment_mcp_oauth_flows flow
           WHERE flow.environment_id = integration.environment_id
             AND flow.server_name = integration.server_name
             AND (
               flow.status IN ('starting', 'awaiting_user', 'cancelled')
               OR (
                 flow.status = 'expired'
                 AND flow.cleanup_completed_at IS NULL
               )
               OR (
                 flow.native_thread_id IS NOT NULL
                 AND flow.native_thread_cleanup_completed_at IS NULL
               )
             )
         )
       RETURNING integration.*`,
      [userId, environmentId, serverName],
    );
    const row = result.rows[0];
    if (!row) {
      await this.assertEnvironmentAccess(userId, environmentId);
      const existing = await this.pool.query<{
        credential_cleanup_required: boolean;
        blocking_oauth_flow: boolean;
      }>(
        `SELECT
           (
             integration.credential_source_ref IS NOT NULL
             OR integration.pending_credential_source_ref IS NOT NULL
             OR integration.retiring_credential_source_ref IS NOT NULL
           ) AS credential_cleanup_required,
           EXISTS (
             SELECT 1
             FROM environment_mcp_oauth_flows flow
             WHERE flow.environment_id = integration.environment_id
               AND flow.server_name = integration.server_name
               AND (
                 flow.status IN ('starting', 'awaiting_user', 'cancelled')
                 OR (
                   flow.status = 'expired'
                   AND flow.cleanup_completed_at IS NULL
                 )
                 OR (
                   flow.native_thread_id IS NOT NULL
                   AND flow.native_thread_cleanup_completed_at IS NULL
                 )
               )
           ) AS blocking_oauth_flow
         FROM environment_mcp_integrations integration
         WHERE integration.environment_id = $1
           AND integration.server_name = $2`,
        [environmentId, serverName],
      );
      const existingRow = existing.rows[0];
      if (existingRow?.blocking_oauth_flow) {
        throw conflict(
          "mcp_oauth_flow_blocking",
          "The MCP integration cannot be deleted until OAuth cleanup and quarantine complete.",
        );
      }
      if (existingRow?.credential_cleanup_required) {
        throw conflict(
          "mcp_integration_cleanup_required",
          "MCP credentials must be cleaned up before deleting the integration.",
        );
      }
      throw notFound("mcp_integration_not_found", "MCP integration not found.");
    }
    return integrationFromRow(row);
  }

  async deleteIntegrationForRuntimeIfUnreferenced(
    environmentId: string,
    serverName: string,
    input: {
      expectedVersion: number;
      expectedEndpointFingerprint: string;
    },
  ) {
    assertVersion(input.expectedVersion);
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<IntegrationRow>(
      `DELETE FROM environment_mcp_integrations integration
       WHERE integration.environment_id = $1
         AND integration.server_name = $2
         AND integration.lifecycle_status = 'deleting'
         AND integration.version = $3
         AND integration.endpoint_fingerprint = $4
         AND integration.credential_source_ref IS NULL
         AND integration.pending_credential_source_ref IS NULL
         AND integration.retiring_credential_source_ref IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM environment_mcp_oauth_flows flow
           WHERE flow.environment_id = integration.environment_id
             AND flow.server_name = integration.server_name
             AND (
               flow.status IN ('starting', 'awaiting_user', 'cancelled')
               OR (
                 flow.status = 'expired'
                 AND flow.cleanup_completed_at IS NULL
               )
               OR (
                 flow.native_thread_id IS NOT NULL
                 AND flow.native_thread_cleanup_completed_at IS NULL
               )
             )
         )
       RETURNING integration.*`,
      [
        environmentId,
        serverName,
        input.expectedVersion,
        input.expectedEndpointFingerprint.toLowerCase(),
      ],
    );
    return result.rows[0] ? integrationFromRow(result.rows[0]) : undefined;
  }

  async createOAuthFlow(
    userId: string,
    input: {
      environmentId: string;
      serverName: string;
      configFingerprint: string;
      expiresAt: Date;
      expectedEndpointFingerprint: string;
    },
  ) {
    assertSha256Fingerprint(input.configFingerprint, "MCP config");
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    if (input.expiresAt.getTime() <= Date.now()) {
      throw new Error("MCP OAuth flow expiry must be in the future.");
    }
    await this.assertEnvironmentAccess(userId, input.environmentId);
    await this.expireOAuthFlows(input.environmentId);
    const existing = await this.findBlockingOAuthFlowForRuntime(
      input.environmentId,
    );
    if (existing) return { flow: existing, created: false } as const;

    const id = `mcp_oauth_${randomUUID()}`;
    try {
      const result = await this.pool.query<OAuthFlowRow>(
        `WITH target AS (
           UPDATE environment_mcp_integrations integration
           SET oauth_config_fingerprint = $5,
               lifecycle_status = 'updating',
               credential_status = 'authorizing',
               last_error = NULL,
               version = integration.version + 1
           FROM environments environment
           JOIN environment_runtime runtime
             ON runtime.environment_id = environment.id
           WHERE integration.environment_id = environment.id
             AND environment.id = $2
             AND environment.created_by_user_id = $1
             AND environment.status <> 'archived'
             AND runtime.desired_state <> 'terminated'
             AND integration.server_name = $4
             AND integration.auth_mode = 'oauth'
             AND integration.endpoint_fingerprint = $7
           RETURNING
             integration.environment_id,
             integration.server_name,
             integration.endpoint_fingerprint
         )
         INSERT INTO environment_mcp_oauth_flows (
           id, environment_id, server_name, config_fingerprint,
           endpoint_fingerprint, status, expires_at
         )
         SELECT $3, target.environment_id, target.server_name, $5,
                target.endpoint_fingerprint, 'starting', $6
         FROM target
         RETURNING *`,
        [
          userId,
          input.environmentId,
          id,
          input.serverName,
          input.configFingerprint.toLowerCase(),
          input.expiresAt,
          input.expectedEndpointFingerprint.toLowerCase(),
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw conflict(
          "mcp_oauth_definition_changed",
          "The MCP OAuth definition or Environment lifecycle changed.",
        );
      }
      return { flow: oauthFlowFromRow(row), created: true } as const;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.findBlockingOAuthFlowForRuntime(
          input.environmentId,
        );
        if (concurrent) {
          return { flow: concurrent, created: false } as const;
        }
      }
      throw error;
    }
  }

  async findActiveOAuthFlow(userId: string, environmentId: string) {
    await this.assertEnvironmentAccess(userId, environmentId);
    return this.findActiveOAuthFlowForRuntime(environmentId);
  }

  async findBlockingOAuthFlow(userId: string, environmentId: string) {
    await this.assertEnvironmentAccess(userId, environmentId);
    return this.findBlockingOAuthFlowForRuntime(environmentId);
  }

  async findActiveOAuthFlowForRuntime(environmentId: string) {
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE environment_id = $1
         AND status = ANY($2::TEXT[])
         AND expires_at > NOW()
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [environmentId, ACTIVE_OAUTH_FLOW_STATUSES],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async findBlockingOAuthFlowForRuntime(environmentId: string) {
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE environment_id = $1
         AND (
           status = ANY($2::TEXT[])
           OR (
             status = 'expired'
             AND cleanup_completed_at IS NULL
           )
         )
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [environmentId, BLOCKING_OAUTH_FLOW_STATUSES],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async findLatestOAuthFlowForRuntime(
    environmentId: string,
    serverName: string,
  ) {
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE environment_id = $1
         AND server_name = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [environmentId, serverName],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async findOAuthFlowByNativeThreadForRuntime(
    environmentId: string,
    serverName: string,
    nativeThreadId: string,
  ) {
    const normalizedNativeThreadId = requiredNonEmpty(
      nativeThreadId,
      "MCP OAuth native thread id",
    );
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE environment_id = $1
         AND server_name = $2
         AND native_thread_id = $3
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [environmentId, serverName, normalizedNativeThreadId],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async listOAuthThreadCleanupForRuntime(environmentId?: string) {
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE native_thread_id IS NOT NULL
         AND native_thread_cleanup_completed_at IS NULL
         AND status = ANY($1::TEXT[])
         AND ($2::TEXT IS NULL OR environment_id = $2)
       ORDER BY created_at, id`,
      [TERMINAL_OAUTH_FLOW_STATUSES, environmentId ?? null],
    );
    return result.rows.map(oauthFlowFromRow);
  }

  async markOAuthThreadCleanupCompletedForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      flowId: string;
      nativeThreadId: string;
      expectedConfigFingerprint: string;
      expectedEndpointFingerprint: string;
    },
  ) {
    const nativeThreadId = requiredNonEmpty(
      input.nativeThreadId,
      "MCP OAuth native thread id",
    );
    assertSha256Fingerprint(input.expectedConfigFingerprint, "MCP config");
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<OAuthFlowRow>(
      `UPDATE environment_mcp_oauth_flows flow
       SET native_thread_cleanup_completed_at = NOW()
       WHERE flow.environment_id = $1
         AND flow.server_name = $2
         AND flow.id = $3
         AND flow.native_thread_id = $4
         AND flow.native_runtime_generation IS NOT NULL
         AND flow.native_attempt_id IS NOT NULL
         AND flow.config_fingerprint = $5
         AND flow.endpoint_fingerprint = $6
         AND flow.status = ANY($7::TEXT[])
         AND flow.native_thread_cleanup_completed_at IS NULL
       RETURNING flow.*`,
      [
        environmentId,
        serverName,
        input.flowId,
        nativeThreadId,
        input.expectedConfigFingerprint.toLowerCase(),
        input.expectedEndpointFingerprint.toLowerCase(),
        TERMINAL_OAUTH_FLOW_STATUSES,
      ],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  /** Includes expired tombstones whose strict native discard is still pending. */
  async listCancelledOAuthFlowsForRuntime(environmentId?: string) {
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE status IN ('cancelled', 'expired')
         AND cleanup_completed_at IS NULL
         AND ($1::TEXT IS NULL OR environment_id = $1)
       ORDER BY created_at, id`,
      [environmentId ?? null],
    );
    return result.rows.map(oauthFlowFromRow);
  }

  async markOAuthFlowCleanupCompletedForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      flowId: string;
      expectedConfigFingerprint: string;
      expectedEndpointFingerprint: string;
    },
  ) {
    assertSha256Fingerprint(input.expectedConfigFingerprint, "MCP config");
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<OAuthFlowRow>(
      `WITH target AS MATERIALIZED (
         SELECT
           flow.id,
           flow.environment_id,
           flow.server_name,
           flow.config_fingerprint,
           flow.endpoint_fingerprint,
           flow.expires_at
         FROM environment_mcp_oauth_flows flow
         WHERE flow.id = $3
           AND flow.environment_id = $1
           AND flow.server_name = $2
           AND flow.status IN ('cancelled', 'expired')
           AND flow.cleanup_completed_at IS NULL
           AND flow.config_fingerprint = $4
           AND flow.endpoint_fingerprint = $5
         FOR UPDATE OF flow
       ),
       updated_flow AS (
         UPDATE environment_mcp_oauth_flows flow
         SET cleanup_completed_at = NOW(),
             status = CASE
               WHEN target.expires_at <= NOW() THEN 'expired'
               ELSE 'cancelled'
             END
         FROM target
         WHERE flow.id = target.id
         RETURNING flow.*
       ),
       restored AS (
         UPDATE environment_mcp_integrations integration
         SET oauth_config_fingerprint = NULL,
             lifecycle_status = CASE
               WHEN integration.lifecycle_status = 'deleting'
                 THEN 'deleting'
               ELSE 'active'
             END,
             credential_status = 'missing',
             last_error = NULL,
             version = integration.version + 1
         FROM updated_flow flow
         WHERE integration.environment_id = flow.environment_id
           AND integration.server_name = flow.server_name
           AND integration.auth_mode = 'oauth'
           AND integration.oauth_config_fingerprint =
               flow.config_fingerprint
           AND integration.endpoint_fingerprint =
               flow.endpoint_fingerprint
         RETURNING integration.environment_id
       )
       SELECT flow.*
       FROM updated_flow flow
       LEFT JOIN restored
         ON restored.environment_id = flow.environment_id`,
      [
        environmentId,
        serverName,
        input.flowId,
        input.expectedConfigFingerprint.toLowerCase(),
        input.expectedEndpointFingerprint.toLowerCase(),
      ],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async getOAuthFlow(
    userId: string,
    environmentId: string,
    flowId: string,
  ) {
    await this.assertEnvironmentAccess(userId, environmentId);
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE environment_id = $1 AND id = $2`,
      [environmentId, flowId],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound("mcp_oauth_flow_not_found", "MCP OAuth flow not found.");
    }
    return oauthFlowFromRow(row);
  }

  async hasOAuthNativeEventForRuntime(
    environmentId: string,
    event: CodexMcpNativeEventIdentity,
  ) {
    const identity = normalizeNativeEventIdentity(event);
    const result = await this.pool.query(
      `SELECT 1
       FROM environment_mcp_oauth_events
       WHERE environment_id = $1
         AND runtime_generation = $2
         AND supervisor_sequence = $3
         AND record_index = $4
         AND attempt_id = $5`,
      [
        environmentId,
        identity.runtimeGeneration,
        identity.supervisorSequence,
        identity.recordIndex,
        identity.attemptId,
      ],
    );
    return Boolean(result.rowCount);
  }

  /**
   * Records an event only after the caller has completed any required native
   * cleanup. The terminal CAS below deliberately does not journal stale events.
   */
  async recordOAuthNativeEventForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      event: CodexMcpNativeEventIdentity;
      occurredAt: Date;
      success: boolean;
      disposition: string;
    },
  ): Promise<"recorded" | "duplicate"> {
    const identity = normalizeNativeEventIdentity(input.event);
    assertValidDate(input.occurredAt, "MCP OAuth event occurrence");
    const normalizedServerName = requiredNonEmpty(
      serverName,
      "MCP server name",
    );
    const disposition = requiredNonEmpty(
      input.disposition,
      "MCP OAuth event disposition",
    );
    const result = await this.pool.query(
      `INSERT INTO environment_mcp_oauth_events (
         environment_id, runtime_generation, supervisor_sequence,
         record_index, attempt_id, server_name, success, disposition,
         occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (
         environment_id, runtime_generation, supervisor_sequence,
         record_index, attempt_id
       ) DO NOTHING
       RETURNING environment_id`,
      [
        environmentId,
        identity.runtimeGeneration,
        identity.supervisorSequence,
        identity.recordIndex,
        identity.attemptId,
        normalizedServerName,
        input.success,
        disposition,
        input.occurredAt,
      ],
    );
    return result.rowCount ? "recorded" : "duplicate";
  }

  /**
   * Applies one terminal native OAuth notification and journals its identity in
   * the same PostgreSQL statement. An event can complete only a live flow whose
   * dedicated native thread exactly matches the notification correlation.
   */
  async applyOAuthNativeTerminalEventForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      event: CodexMcpNativeEventIdentity;
      occurredAt: Date;
      nativeThreadId: string;
      success: boolean;
      error?: string | null;
      expectedConfigFingerprint: string;
      expectedEndpointFingerprint: string;
    },
  ): Promise<
    | { disposition: "applied"; flow: EnvironmentMcpOAuthFlow }
    | { disposition: "duplicate" | "stale" }
  > {
    const identity = normalizeNativeEventIdentity(input.event);
    assertValidDate(input.occurredAt, "MCP OAuth event occurrence");
    requiredNonEmpty(serverName, "MCP server name");
    const nativeThreadId = requiredNonEmpty(
      input.nativeThreadId,
      "MCP OAuth native thread id",
    );
    assertSha256Fingerprint(input.expectedConfigFingerprint, "MCP config");
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const status: Extract<McpOAuthFlowStatus, "completed" | "failed"> =
      input.success ? "completed" : "failed";
    const result = await this.pool.query<OAuthTerminalEventOutcomeRow>(
      `WITH existing_event AS MATERIALIZED (
         SELECT 1
         FROM environment_mcp_oauth_events event
         WHERE event.environment_id = $1
           AND event.runtime_generation = $3
           AND event.supervisor_sequence = $4
           AND event.record_index = $5
           AND event.attempt_id = $6
       ),
       target AS MATERIALIZED (
         SELECT
           flow.id,
           flow.environment_id,
           flow.server_name,
           flow.config_fingerprint,
           flow.endpoint_fingerprint
         FROM environment_mcp_oauth_flows flow
         JOIN environment_mcp_integrations integration
           ON integration.environment_id = flow.environment_id
          AND integration.server_name = flow.server_name
         WHERE flow.environment_id = $1
           AND flow.server_name = $2
           AND flow.status = ANY($14::TEXT[])
           AND $8 <= flow.expires_at
           AND flow.config_fingerprint = $12
           AND flow.endpoint_fingerprint = $13
           AND flow.native_thread_id = $7
           AND flow.native_runtime_generation = $3
           AND flow.native_attempt_id = $6
           AND integration.auth_mode = 'oauth'
           AND integration.oauth_config_fingerprint =
               flow.config_fingerprint
           AND integration.endpoint_fingerprint =
               flow.endpoint_fingerprint
           AND NOT EXISTS (SELECT 1 FROM existing_event)
         FOR UPDATE OF flow, integration
       ),
       inserted_event AS (
         INSERT INTO environment_mcp_oauth_events (
           environment_id, runtime_generation, supervisor_sequence,
           record_index, attempt_id, server_name, success, disposition,
           occurred_at
         )
         SELECT
           target.environment_id, $3, $4, $5, $6,
           target.server_name, $9 = 'completed', 'applied', $8
         FROM target
         ON CONFLICT (
           environment_id, runtime_generation, supervisor_sequence,
           record_index, attempt_id
         ) DO NOTHING
         RETURNING environment_id, server_name
       ),
       updated_integration AS (
         UPDATE environment_mcp_integrations integration
         SET lifecycle_status = CASE
               WHEN $9 = 'completed' THEN 'active'
               ELSE 'error'
             END,
             credential_status = CASE
               WHEN $9 = 'completed' THEN 'authorized'
               ELSE 'error'
             END,
             last_error = CASE WHEN $10 THEN $11 ELSE last_error END,
             version = integration.version + 1
         FROM target, inserted_event event
         WHERE integration.environment_id = target.environment_id
           AND integration.server_name = target.server_name
           AND event.environment_id = target.environment_id
           AND event.server_name = target.server_name
           AND integration.auth_mode = 'oauth'
           AND integration.oauth_config_fingerprint =
               target.config_fingerprint
           AND integration.endpoint_fingerprint =
               target.endpoint_fingerprint
         RETURNING integration.environment_id, integration.server_name
       ),
       updated_flow AS (
         UPDATE environment_mcp_oauth_flows flow
         SET status = $9,
             error = CASE WHEN $10 THEN $11 ELSE flow.error END
         FROM target, updated_integration integration
         WHERE flow.id = target.id
           AND integration.environment_id = target.environment_id
           AND integration.server_name = target.server_name
         RETURNING flow.*
       )
       SELECT
         CASE
           WHEN EXISTS (SELECT 1 FROM updated_flow) THEN 'applied'
           WHEN EXISTS (SELECT 1 FROM existing_event) THEN 'duplicate'
           ELSE 'stale'
         END AS disposition,
         (
           SELECT row_to_json(flow)
           FROM updated_flow flow
           LIMIT 1
         ) AS flow`,
      [
        environmentId,
        serverName,
        identity.runtimeGeneration,
        identity.supervisorSequence,
        identity.recordIndex,
        identity.attemptId,
        nativeThreadId,
        input.occurredAt,
        status,
        input.error !== undefined,
        input.error ?? null,
        input.expectedConfigFingerprint.toLowerCase(),
        input.expectedEndpointFingerprint.toLowerCase(),
        ACTIVE_OAUTH_FLOW_STATUSES,
      ],
    );
    const outcome = result.rows[0];
    if (!outcome || outcome.disposition === "stale") {
      return { disposition: "stale" };
    }
    if (outcome.disposition === "duplicate") {
      return { disposition: "duplicate" };
    }
    if (!outcome.flow) {
      throw new Error("Applied MCP OAuth event did not return its flow.");
    }
    return {
      disposition: "applied",
      flow: oauthFlowFromRow(outcome.flow),
    };
  }

  async markOAuthFlowForRuntime(
    environmentId: string,
    serverName: string,
    update: {
      status: Extract<McpOAuthFlowStatus, "completed" | "failed">;
      error?: string | null;
      expectedConfigFingerprint: string;
      expectedEndpointFingerprint: string;
    },
  ) {
    assertSha256Fingerprint(update.expectedConfigFingerprint, "MCP config");
    assertSha256Fingerprint(
      update.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<OAuthFlowRow>(
      `WITH target AS MATERIALIZED (
         SELECT
           flow.id,
           flow.environment_id,
           flow.server_name,
           flow.config_fingerprint,
           flow.endpoint_fingerprint
         FROM environment_mcp_oauth_flows flow
         JOIN environment_mcp_integrations integration
           ON integration.environment_id = flow.environment_id
          AND integration.server_name = flow.server_name
         WHERE flow.environment_id = $1
           AND flow.server_name = $2
           AND flow.status = ANY($6::TEXT[])
           AND flow.expires_at > NOW()
           AND flow.config_fingerprint = $7
           AND flow.endpoint_fingerprint = $8
           AND integration.auth_mode = 'oauth'
           AND integration.oauth_config_fingerprint =
               flow.config_fingerprint
           AND integration.endpoint_fingerprint =
               flow.endpoint_fingerprint
         FOR UPDATE OF flow, integration
       ),
       updated_integration AS (
         UPDATE environment_mcp_integrations integration
         SET lifecycle_status = CASE
               WHEN $3 = 'completed' THEN 'active'
               ELSE 'error'
             END,
             credential_status = CASE
               WHEN $3 = 'completed' THEN 'authorized'
               ELSE 'error'
             END,
             last_error = CASE WHEN $4 THEN $5 ELSE last_error END,
             version = integration.version + 1
         FROM target
         WHERE integration.environment_id = target.environment_id
           AND integration.server_name = target.server_name
           AND integration.auth_mode = 'oauth'
           AND integration.oauth_config_fingerprint =
               target.config_fingerprint
           AND integration.endpoint_fingerprint =
               target.endpoint_fingerprint
         RETURNING integration.environment_id, integration.server_name
       ),
       updated_flow AS (
         UPDATE environment_mcp_oauth_flows flow
         SET status = $3,
             error = CASE WHEN $4 THEN $5 ELSE flow.error END
         FROM target, updated_integration integration
         WHERE flow.id = target.id
           AND integration.environment_id = target.environment_id
           AND integration.server_name = target.server_name
         RETURNING flow.*
       )
       SELECT * FROM updated_flow`,
      [
        environmentId,
        serverName,
        update.status,
        update.error !== undefined,
        update.error ?? null,
        ACTIVE_OAUTH_FLOW_STATUSES,
        update.expectedConfigFingerprint.toLowerCase(),
        update.expectedEndpointFingerprint.toLowerCase(),
      ],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async markOAuthFlowCorrelationForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      flowId: string;
      nativeThreadId: string;
      runtime: CodexMcpNativeRuntimeIdentity;
      expiresAt: Date;
      expectedConfigFingerprint: string;
      expectedEndpointFingerprint: string;
    },
  ) {
    const nativeThreadId = requiredNonEmpty(
      input.nativeThreadId,
      "MCP OAuth native thread id",
    );
    const runtime = normalizeNativeRuntimeIdentity(input.runtime);
    assertSha256Fingerprint(input.expectedConfigFingerprint, "MCP config");
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    assertFutureDate(input.expiresAt, "MCP OAuth flow expiry");
    const result = await this.pool.query<OAuthFlowRow>(
      `UPDATE environment_mcp_oauth_flows flow
       SET native_thread_id = $4,
           expires_at = $7,
           native_runtime_generation = $8,
           native_attempt_id = $9
       FROM environment_mcp_integrations integration
       JOIN environment_runtime runtime
         ON runtime.environment_id = integration.environment_id
       WHERE flow.id = $3
         AND flow.environment_id = $1
         AND flow.server_name = $2
         AND flow.status = 'starting'
         AND flow.expires_at > NOW()
         AND flow.config_fingerprint = $5
         AND flow.endpoint_fingerprint = $6
         AND (
           (
             flow.native_thread_id IS NULL
             AND flow.native_runtime_generation IS NULL
             AND flow.native_attempt_id IS NULL
           )
           OR (
             flow.native_thread_id = $4
             AND flow.native_runtime_generation = $8
             AND flow.native_attempt_id = $9
           )
         )
         AND integration.environment_id = flow.environment_id
         AND integration.server_name = flow.server_name
         AND integration.auth_mode = 'oauth'
         AND integration.oauth_config_fingerprint =
             flow.config_fingerprint
         AND integration.endpoint_fingerprint =
             flow.endpoint_fingerprint
         AND runtime.desired_state <> 'terminated'
         AND runtime.runtime_generation = $8
         AND COALESCE(runtime.attempt_id, '') = $9
       RETURNING flow.*`,
      [
        environmentId,
        serverName,
        input.flowId,
        nativeThreadId,
        input.expectedConfigFingerprint.toLowerCase(),
        input.expectedEndpointFingerprint.toLowerCase(),
        input.expiresAt,
        runtime.runtimeGeneration,
        runtime.attemptId,
      ],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async markOAuthFlowCorrelation(
    userId: string,
    environmentId: string,
    flowId: string,
    input: {
      nativeThreadId: string;
      runtime: CodexMcpNativeRuntimeIdentity;
      expiresAt: Date;
      expectedConfigFingerprint: string;
      expectedEndpointFingerprint: string;
    },
  ) {
    const nativeThreadId = requiredNonEmpty(
      input.nativeThreadId,
      "MCP OAuth native thread id",
    );
    const runtime = normalizeNativeRuntimeIdentity(input.runtime);
    assertSha256Fingerprint(input.expectedConfigFingerprint, "MCP config");
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    assertFutureDate(input.expiresAt, "MCP OAuth flow expiry");
    const result = await this.pool.query<OAuthFlowRow>(
      `UPDATE environment_mcp_oauth_flows flow
       SET native_thread_id = $4,
           expires_at = $7,
           native_runtime_generation = $8,
           native_attempt_id = $9
       FROM environments environment
       JOIN environment_runtime runtime
         ON runtime.environment_id = environment.id
       JOIN environment_mcp_integrations integration
         ON integration.environment_id = environment.id
       WHERE flow.id = $3
         AND flow.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND runtime.desired_state <> 'terminated'
         AND flow.status = 'starting'
         AND flow.expires_at > NOW()
         AND flow.config_fingerprint = $5
         AND flow.endpoint_fingerprint = $6
         AND (
           (
             flow.native_thread_id IS NULL
             AND flow.native_runtime_generation IS NULL
             AND flow.native_attempt_id IS NULL
           )
           OR (
             flow.native_thread_id = $4
             AND flow.native_runtime_generation = $8
             AND flow.native_attempt_id = $9
           )
         )
         AND integration.server_name = flow.server_name
         AND integration.auth_mode = 'oauth'
         AND integration.oauth_config_fingerprint =
             flow.config_fingerprint
         AND integration.endpoint_fingerprint =
             flow.endpoint_fingerprint
         AND runtime.runtime_generation = $8
         AND COALESCE(runtime.attempt_id, '') = $9
       RETURNING flow.*`,
      [
        userId,
        environmentId,
        flowId,
        nativeThreadId,
        input.expectedConfigFingerprint.toLowerCase(),
        input.expectedEndpointFingerprint.toLowerCase(),
        input.expiresAt,
        runtime.runtimeGeneration,
        runtime.attemptId,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw conflict(
        "mcp_oauth_correlation_changed",
        "The MCP OAuth flow or native thread correlation changed.",
      );
    }
    return oauthFlowFromRow(row);
  }

  async markOAuthFlow(
    userId: string,
    environmentId: string,
    flowId: string,
    update: {
      status: Extract<
        McpOAuthFlowStatus,
        "awaiting_user" | "failed" | "cancelled"
      >;
      error?: string | null;
      expectedConfigFingerprint?: string;
    },
  ) {
    if (update.expectedConfigFingerprint) {
      assertSha256Fingerprint(update.expectedConfigFingerprint, "MCP config");
    }
    const result = await this.pool.query<OAuthFlowRow>(
      `UPDATE environment_mcp_oauth_flows flow
       SET status = $4,
           error = CASE WHEN $5 THEN $6 ELSE error END
       FROM environments environment
       JOIN environment_mcp_integrations integration
         ON integration.environment_id = environment.id
       WHERE flow.environment_id = environment.id
         AND environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND flow.id = $3
         AND flow.status = ANY($8::TEXT[])
         AND flow.expires_at > NOW()
         AND integration.server_name = flow.server_name
         AND integration.auth_mode = 'oauth'
         AND integration.oauth_config_fingerprint =
             flow.config_fingerprint
         AND integration.endpoint_fingerprint =
             flow.endpoint_fingerprint
         AND ($7::TEXT IS NULL OR flow.config_fingerprint = $7)
         AND ($4 <> 'awaiting_user' OR flow.native_thread_id IS NOT NULL)
       RETURNING flow.*`,
      [
        userId,
        environmentId,
        flowId,
        update.status,
        update.error !== undefined,
        update.error ?? null,
        update.expectedConfigFingerprint?.toLowerCase() ?? null,
        ACTIVE_OAUTH_FLOW_STATUSES,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound("mcp_oauth_flow_not_found", "MCP OAuth flow not found.");
    }
    return oauthFlowFromRow(row);
  }

  async deleteOAuthFlow(
    userId: string,
    environmentId: string,
    flowId: string,
  ) {
    const result = await this.pool.query<OAuthFlowRow>(
      `DELETE FROM environment_mcp_oauth_flows flow
       USING environments environment
       WHERE flow.environment_id = environment.id
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'
         AND flow.environment_id = $2
         AND flow.id = $3
         AND (
           flow.status IN ('completed', 'failed')
           OR (
             flow.status = 'expired'
             AND flow.cleanup_completed_at IS NOT NULL
           )
         )
         AND (
           flow.native_thread_id IS NULL
           OR flow.native_thread_cleanup_completed_at IS NOT NULL
         )
       RETURNING flow.*`,
      [userId, environmentId, flowId],
    );
    const row = result.rows[0];
    if (!row) {
      throw notFound("mcp_oauth_flow_not_found", "MCP OAuth flow not found.");
    }
    return oauthFlowFromRow(row);
  }

  async listResumableOAuthFlows() {
    const result = await this.pool.query<OAuthFlowRow>(
      `SELECT *
       FROM environment_mcp_oauth_flows
       WHERE status = ANY($1::TEXT[]) AND expires_at > NOW()
       ORDER BY created_at, id`,
      [ACTIVE_OAUTH_FLOW_STATUSES],
    );
    return result.rows.map(oauthFlowFromRow);
  }

  async expireOAuthFlowForRuntime(
    environmentId: string,
    serverName: string,
    input: {
      expectedConfigFingerprint: string;
      expectedEndpointFingerprint: string;
    },
  ) {
    assertSha256Fingerprint(input.expectedConfigFingerprint, "MCP config");
    assertSha256Fingerprint(
      input.expectedEndpointFingerprint,
      "MCP endpoint",
    );
    const result = await this.pool.query<OAuthFlowRow>(
      `WITH target AS MATERIALIZED (
         SELECT
           flow.id,
           flow.environment_id,
           flow.server_name,
           flow.config_fingerprint,
           flow.endpoint_fingerprint,
           flow.cleanup_completed_at
         FROM environment_mcp_oauth_flows flow
         WHERE flow.environment_id = $1
           AND flow.server_name = $2
           AND flow.expires_at <= NOW()
           AND flow.config_fingerprint = $4
           AND flow.endpoint_fingerprint = $5
           AND (
             flow.status = ANY($3::TEXT[])
             OR (
               flow.status = 'cancelled'
               AND flow.cleanup_completed_at IS NOT NULL
             )
           )
         FOR UPDATE OF flow
       ),
       updated_flow AS (
         UPDATE environment_mcp_oauth_flows flow
         SET status = CASE
               WHEN target.cleanup_completed_at IS NULL
                 THEN 'cancelled'
               ELSE 'expired'
             END
         FROM target
         WHERE flow.id = target.id
         RETURNING flow.*
       ),
       restored AS (
         UPDATE environment_mcp_integrations integration
         SET lifecycle_status = CASE
               WHEN integration.lifecycle_status = 'deleting'
                 THEN 'deleting'
               ELSE 'active'
             END,
             credential_status = 'missing',
             last_error = NULL,
             version = integration.version + 1
         FROM updated_flow flow
         WHERE integration.environment_id = flow.environment_id
           AND integration.server_name = flow.server_name
           AND flow.status = 'cancelled'
           AND flow.cleanup_completed_at IS NULL
           AND integration.auth_mode = 'oauth'
           AND integration.oauth_config_fingerprint =
               flow.config_fingerprint
           AND integration.endpoint_fingerprint =
               flow.endpoint_fingerprint
         RETURNING integration.environment_id
       )
       SELECT flow.*
       FROM updated_flow flow
       LEFT JOIN restored
         ON restored.environment_id = flow.environment_id`,
      [
        environmentId,
        serverName,
        ACTIVE_OAUTH_FLOW_STATUSES,
        input.expectedConfigFingerprint.toLowerCase(),
        input.expectedEndpointFingerprint.toLowerCase(),
      ],
    );
    return result.rows[0] ? oauthFlowFromRow(result.rows[0]) : undefined;
  }

  async expireOAuthFlows(environmentId?: string) {
    const result = await this.pool.query<OAuthFlowRow>(
      `WITH cleanup_required AS (
         UPDATE environment_mcp_oauth_flows
         SET status = 'cancelled'
         WHERE status = ANY($1::TEXT[])
           AND expires_at <= NOW()
           AND ($2::TEXT IS NULL OR environment_id = $2)
         RETURNING *
       ),
       restored AS (
         UPDATE environment_mcp_integrations integration
         SET lifecycle_status = CASE
               WHEN integration.lifecycle_status = 'deleting'
                 THEN 'deleting'
               ELSE 'active'
             END,
             credential_status = 'missing',
             last_error = NULL,
             version = integration.version + 1
         FROM cleanup_required flow
         WHERE integration.environment_id = flow.environment_id
           AND integration.server_name = flow.server_name
           AND integration.auth_mode = 'oauth'
           AND integration.oauth_config_fingerprint =
               flow.config_fingerprint
           AND integration.endpoint_fingerprint =
               flow.endpoint_fingerprint
         RETURNING integration.environment_id
       ),
       expired AS (
         UPDATE environment_mcp_oauth_flows
         SET status = 'expired'
         WHERE status = 'cancelled'
           AND cleanup_completed_at IS NOT NULL
           AND expires_at <= NOW()
           AND ($2::TEXT IS NULL OR environment_id = $2)
         RETURNING *
       )
       SELECT flow.*
       FROM cleanup_required flow
       LEFT JOIN restored
         ON restored.environment_id = flow.environment_id
       UNION ALL
       SELECT * FROM expired`,
      [ACTIVE_OAUTH_FLOW_STATUSES, environmentId ?? null],
    );
    return result.rows.map(oauthFlowFromRow);
  }

  private async assertEnvironmentAccess(userId: string, environmentId: string) {
    const result = await this.pool.query(
      `SELECT environment.id
       FROM environments environment
       WHERE environment.id = $2
         AND environment.created_by_user_id = $1
         AND environment.status <> 'archived'`,
      [userId, environmentId],
    );
    if (!result.rowCount) {
      throw notFound("environment_not_found", "Environment not found.");
    }
  }
}

function normalizeIntegrationInput(
  input: UpsertEnvironmentMcpIntegration,
): Required<
  Pick<
    UpsertEnvironmentMcpIntegration,
    | "environmentId"
    | "serverName"
    | "authMode"
    | "endpointFingerprint"
    | "destinationDomain"
    | "destinationPath"
    | "lifecycleStatus"
    | "credentialStatus"
    | "bindingEnabled"
  >
> &
  Pick<
    UpsertEnvironmentMcpIntegration,
    | "presetId"
    | "credentialSourceRef"
    | "credentialBindingRef"
    | "credentialHeaderName"
    | "credentialValueTemplate"
    | "lastError"
  > {
  const serverName = input.serverName.trim();
  if (!serverName) throw new Error("MCP server name is required.");

  assertSha256Fingerprint(input.endpointFingerprint, "MCP endpoint");
  const domain = normalizeNetworkDomain(input.destinationDomain);
  if (!domain || domain.startsWith("*.")) {
    throw new Error("MCP credential destination must be one exact domain.");
  }
  const destinationPath = normalizeDestinationPath(input.destinationPath);
  const sourceRef = optionalNonEmpty(input.credentialSourceRef);
  const bindingRef = optionalNonEmpty(input.credentialBindingRef);
  if (Boolean(sourceRef) !== Boolean(bindingRef)) {
    throw new Error(
      "MCP credential source and binding references must be set together.",
    );
  }
  if (
    input.authMode !== "bearer" &&
    input.authMode !== "header" &&
    (sourceRef || bindingRef)
  ) {
    throw new Error("Only static-key MCP integrations may bind credentials.");
  }

  const credentialProjection = normalizeCredentialProjection(input);
  const credentialStatus =
    input.credentialStatus ??
    (input.authMode === "none"
      ? "not-required"
      : sourceRef
        ? "configured"
        : "missing");
  if (input.authMode === "none" && credentialStatus !== "not-required") {
    throw new Error(
      "An unauthenticated MCP integration must use not-required credential status.",
    );
  }
  if (credentialStatus === "configured" && (!sourceRef || !bindingRef)) {
    throw new Error(
      "A configured MCP credential requires source and binding references.",
    );
  }
  const bindingEnabled =
    input.bindingEnabled ??
    Boolean(
      sourceRef &&
        bindingRef &&
        (credentialStatus === "configured" ||
          credentialStatus === "authorized"),
    );
  if (
    bindingEnabled &&
    (!sourceRef ||
      !bindingRef ||
      (input.authMode !== "bearer" && input.authMode !== "header"))
  ) {
    throw new Error(
      "An enabled MCP credential binding requires one complete static credential.",
    );
  }

  return {
    ...input,
    serverName,
    presetId: optionalNonEmpty(input.presetId),
    credentialSourceRef: sourceRef,
    credentialBindingRef: bindingRef,
    credentialHeaderName: credentialProjection.headerName,
    credentialValueTemplate: credentialProjection.valueTemplate,
    endpointFingerprint: input.endpointFingerprint.toLowerCase(),
    destinationDomain: domain,
    destinationPath,
    lifecycleStatus: input.lifecycleStatus ?? "provisioning",
    credentialStatus,
    bindingEnabled,
  };
}

function normalizeCredentialProjection(
  input: Pick<
    UpsertEnvironmentMcpIntegration,
    | "authMode"
    | "credentialHeaderName"
    | "credentialValueTemplate"
  >,
) {
  if (input.authMode === "bearer") {
    if (
      (input.credentialHeaderName &&
        input.credentialHeaderName.trim() !== "Authorization") ||
      (input.credentialValueTemplate &&
        input.credentialValueTemplate.trim() !== MCP_BEARER_VALUE_TEMPLATE)
    ) {
      throw new Error(
        "Bearer MCP credentials must use the managed Authorization projection.",
      );
    }
    return {
      headerName: "Authorization",
      valueTemplate: MCP_BEARER_VALUE_TEMPLATE,
    };
  }

  if (input.authMode === "header") {
    const headerName = optionalNonEmpty(input.credentialHeaderName);
    if (!headerName) {
      throw new Error("A custom-header MCP credential requires a header name.");
    }
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
      throw new Error(`Invalid MCP credential header name: ${headerName}`);
    }
    const valueTemplate =
      optionalNonEmpty(input.credentialValueTemplate) ??
      MCP_TOKEN_VALUE_TEMPLATE;
    if (
      !/^(?:[A-Za-z][A-Za-z0-9._~-]{0,31} )?\{\{ \.token \}\}$/.test(
        valueTemplate,
      )
    ) {
      throw new Error(
        "MCP credential value template must be a managed token template.",
      );
    }
    return { headerName, valueTemplate };
  }

  if (input.credentialHeaderName || input.credentialValueTemplate) {
    throw new Error(
      "Only static-key MCP integrations may configure a header projection.",
    );
  }
  return {};
}

export function buildMcpCredentialValueTemplate(prefix?: string) {
  const normalizedPrefix = prefix?.trim();
  if (!normalizedPrefix) return MCP_TOKEN_VALUE_TEMPLATE;
  if (!/^[A-Za-z][A-Za-z0-9._~-]{0,31}$/.test(normalizedPrefix)) {
    throw new Error("MCP credential header prefix is invalid.");
  }
  return `${normalizedPrefix} ${MCP_TOKEN_VALUE_TEMPLATE}`;
}

function normalizeDestinationPath(path: string) {
  const normalized = path.trim() || "/";
  if (
    !normalized.startsWith("/") ||
    normalized.includes("?") ||
    normalized.includes("#")
  ) {
    throw new Error(
      "MCP credential destination path must be an absolute path without query or fragment.",
    );
  }
  return normalized;
}

function optionalNonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function requiredNonEmpty(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function normalizeStaticProjectionMetadata(
  credentialHeaderName: string,
  credentialValueTemplate: string,
) {
  const headerName = requiredNonEmpty(
    credentialHeaderName,
    "MCP credential header name",
  );
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
    throw new Error(`Invalid MCP credential header name: ${headerName}`);
  }
  const valueTemplate = requiredNonEmpty(
    credentialValueTemplate,
    "MCP credential value template",
  );
  if (
    !/^(?:[A-Za-z][A-Za-z0-9._~-]{0,31} )?\{\{ \.token \}\}$/.test(
      valueTemplate,
    )
  ) {
    throw new Error(
      "MCP credential value template must be a managed token template.",
    );
  }
  return { headerName, valueTemplate };
}

function assertVersion(version: number) {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error("MCP integration version must be a positive safe integer.");
  }
}

function assertFutureDate(value: Date, label: string) {
  assertValidDate(value, label);
  if (value.getTime() <= Date.now()) {
    throw new Error(`${label} must be in the future.`);
  }
}

function assertValidDate(value: Date, label: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date.`);
  }
}

function normalizeNativeEventIdentity(
  identity: CodexMcpNativeEventIdentity,
): Required<CodexMcpNativeEventIdentity> {
  const runtime = normalizeNativeRuntimeIdentity(identity);
  assertNonNegativeSafeInteger(
    identity.supervisorSequence,
    "MCP OAuth event Supervisor sequence",
  );
  assertNonNegativeSafeInteger(
    identity.recordIndex,
    "MCP OAuth event record index",
  );
  return { ...identity, ...runtime };
}

function normalizeNativeRuntimeIdentity(
  identity: CodexMcpNativeRuntimeIdentity,
): Required<CodexMcpNativeRuntimeIdentity> {
  assertNonNegativeSafeInteger(
    identity.runtimeGeneration,
    "MCP OAuth runtime generation",
  );
  const attemptId = identity.attemptId ?? "";
  if (attemptId.includes("\0")) {
    throw new Error("MCP OAuth runtime attempt id is invalid.");
  }
  return { runtimeGeneration: identity.runtimeGeneration, attemptId };
}

function assertNonNegativeSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertSha256Fingerprint(value: string, label: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} fingerprint must be a SHA-256 hex digest.`);
  }
}

function integrationChanged() {
  return conflict(
    "mcp_integration_changed",
    "The MCP integration changed while this operation was in progress.",
  );
}

function integrationFromRow(row: IntegrationRow): EnvironmentMcpIntegration {
  const version = Number(row.version ?? 1);
  assertVersion(version);
  return {
    environmentId: row.environment_id,
    serverName: row.server_name,
    presetId: row.preset_id ?? undefined,
    authMode: row.auth_mode,
    credentialSourceRef: row.credential_source_ref ?? undefined,
    credentialBindingRef: row.credential_binding_ref ?? undefined,
    credentialHeaderName: row.credential_header_name ?? undefined,
    credentialValueTemplate: row.credential_value_template ?? undefined,
    bindingEnabled:
      row.binding_enabled ??
      Boolean(row.credential_source_ref && row.credential_binding_ref),
    pendingCredentialSourceRef:
      row.pending_credential_source_ref ?? undefined,
    pendingCredentialBindingRef:
      row.pending_credential_binding_ref ?? undefined,
    pendingCredentialHeaderName:
      row.pending_credential_header_name ?? undefined,
    pendingCredentialValueTemplate:
      row.pending_credential_value_template ?? undefined,
    retiringCredentialSourceRef:
      row.retiring_credential_source_ref ?? undefined,
    oauthConfigFingerprint: row.oauth_config_fingerprint ?? undefined,
    version,
    endpointFingerprint: row.endpoint_fingerprint,
    destinationDomain: row.destination_domain,
    destinationPath: row.destination_path,
    toolPolicyMode: row.tool_policy_mode ?? "all",
    allowedTools: [...(row.allowed_tools ?? [])],
    toolPolicyStatus: row.tool_policy_status ?? "active",
    toolPolicyError: row.tool_policy_error ?? undefined,
    lifecycleStatus: row.lifecycle_status,
    credentialStatus: row.credential_status,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeAllowedTools(
  mode: McpToolPolicyMode,
  values: readonly string[],
) {
  const allowedTools = [
    ...new Set(
      values.map((value) => {
        const name = value.trim();
        if (!name || name.length > 256 || name.includes("\0")) {
          throw new Error("MCP tool names must be 1 to 256 safe characters.");
        }
        return name;
      }),
    ),
  ].sort();
  if (allowedTools.length > 1024) {
    throw new Error("An MCP tool policy may contain at most 1024 tools.");
  }
  if (mode === "all") {
    if (allowedTools.length > 0) {
      throw new Error("An all-tools MCP policy cannot contain an allowlist.");
    }
    return allowedTools;
  }
  if (allowedTools.length === 0) {
    throw new Error(
      "Select at least one MCP tool, or disable the MCP server instead.",
    );
  }
  return allowedTools;
}

function oauthFlowFromRow(row: OAuthFlowRow): EnvironmentMcpOAuthFlow {
  const hasNativeRuntime =
    row.native_runtime_generation !== null &&
    row.native_runtime_generation !== undefined &&
    row.native_attempt_id !== null &&
    row.native_attempt_id !== undefined;
  const nativeRuntime = hasNativeRuntime
    ? normalizeNativeRuntimeIdentity({
        runtimeGeneration: Number(row.native_runtime_generation),
        attemptId: row.native_attempt_id!,
      })
    : undefined;
  return {
    id: row.id,
    environmentId: row.environment_id,
    serverName: row.server_name,
    configFingerprint: row.config_fingerprint,
    endpointFingerprint: row.endpoint_fingerprint,
    status: row.status,
    nativeThreadId: row.native_thread_id ?? undefined,
    nativeRuntime,
    nativeThreadCleanupCompletedAt: optionalDate(
      row.native_thread_cleanup_completed_at,
    ),
    error: row.error ?? undefined,
    cleanupCompletedAt: optionalDate(row.cleanup_completed_at),
    expiresAt: requiredDate(row.expires_at),
    createdAt: requiredDate(row.created_at),
    updatedAt: requiredDate(row.updated_at),
  };
}

function optionalDate(value: Date | string | null | undefined) {
  return value === null || value === undefined ? undefined : requiredDate(value);
}

function requiredDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

export function toManagedMcpCredentialBinding(
  integration: EnvironmentMcpIntegration,
): ManagedMcpCredentialBinding {
  if (
    (integration.authMode !== "bearer" &&
      integration.authMode !== "header") ||
    !integration.credentialSourceRef ||
    !integration.credentialBindingRef ||
    !integration.credentialHeaderName ||
    !integration.credentialValueTemplate ||
    integration.bindingEnabled === false
  ) {
    throw new Error(
      `MCP integration ${integration.serverName} has no complete static credential binding.`,
    );
  }
  return {
    bindingRef: integration.credentialBindingRef,
    sourceRef: integration.credentialSourceRef,
    destinationDomain: integration.destinationDomain,
    destinationPath: integration.destinationPath,
    credentialHeaderName: integration.credentialHeaderName,
    credentialValueTemplate: integration.credentialValueTemplate,
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
