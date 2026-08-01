import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { seedCommunityDefaults } from "./seed";
import {
  loadMigrations,
  migrateDatabase,
  migrationChecksum,
  migrationVersion,
} from "./migrate";

test("migrationVersion accepts ordered SQL migration names only", () => {
  assert.equal(migrationVersion("0001_initial.sql"), "0001_initial");
  assert.equal(migrationVersion("1_initial.sql"), undefined);
  assert.equal(migrationVersion("0002-unsafe.sql"), undefined);
  assert.equal(migrationVersion("README.md"), undefined);
});

test("migrationChecksum is stable SHA-256", () => {
  assert.equal(
    migrationChecksum("SELECT 1;"),
    "17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a",
  );
});

test("migration history contains every durable Sandpi boundary", async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    [
      "0001_initial",
      "0002_harness_event_replay",
      "0003_default_environment_network",
      "0004_codex_device_auth_flows",
      "0005_sandbox_credential_bindings",
      "0006_coding_agent_environment_invariants",
      "0007_turn_checkpoints",
      "0008_turn_checkpoint_branches",
      "0009_retryable_turn_checkpoints",
      "0010_session_history_revision",
      "0011_default_browser_timezone",
      "0012_turn_input_checkpoints",
      "0013_supervisor_journal_epochs",
      "0014_native_session_authority",
      "0015_native_session_recovery",
      "0016_workspace_native_state",
      "0017_turn_submission_recovery",
      "0018_codex_delivery_outbox",
      "0019_session_exclusive_operations",
      "0020_native_history_materialization",
      "0021_session_operation_recovery",
      "0022_environment_runtime",
      "0023_environment_lifecycle",
      "0024_environment_idle_pause_30_minutes",
      "0025_environment_runtime_authority",
      "0026_environment_runtime_authority_comments",
      "0027_environment_network_policy",
      "0028_environment_mcp_integrations",
      "0029_codex_native_credential_slots",
      "0030_environment_mcp_credential_projection",
      "0031_environment_mcp_mutation_sagas",
      "0032_environment_mcp_oauth_event_journal",
      "0033_drop_environment_functions",
      "0034_session_reasoning_effort",
      "0035_environment_pause_intervals",
      "0036_drop_notification_preferences",
      "0037_team_centric_ownership",
      "0038_personal_session_pins_and_idle_pause",
      "0039_initialize_configurable_idle_pause_deadlines",
      "0040_environment_sandbox_memory",
      "0041_remove_environment_hard_ttl",
      "0042_environment_mcp_tool_policies",
      "0043_environment_workspace_backups",
      "0044_user_owned_resources",
      "0045_codex_native_mcp",
      "0046_codex_runtime_turn_recovery",
      "0047_environment_egress_credentials",
      "0048_user_billing_and_usage",
      "0049_environment_resource_defaults",
      "0050_retire_codex_automatic_turn_recovery",
      "0051_restore_codex_fault_recovery",
      "0052_environment_schedules",
      "0053_disable_schedules_for_archived_sessions",
      "0054_use_sandbox0_lifecycle_truth",
      "0055_native_auth_attempts",
      "0056_manual_environment_lifecycle",
      "0057_environment_display_order",
      "0058_session_completion",
      "0059_add_ultra_subscription_plan",
      "0060_environment_webhooks",
      "0061_retire_webhook_provider_adapters",
      "0062_github_webhook_sources",
      "0063_simplify_environment_webhooks",
    ],
  );

  const sql = migrations[0]?.sql ?? "";
  const requiredTables = [
    "schema_migrations",
    "users",
    "teams",
    "team_memberships",
    "user_preferences",
    "environments",
    "harness_credentials",
    "sessions",
    "session_runtime",
    "harness_events",
    "auth_sessions",
    "oidc_states",
    "idempotency_keys",
    "outbox",
  ];

  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}\\b`));
  }
  assert.match(sql, /harness_credentials[\s\S]+ciphertext BYTEA NOT NULL/);
  assert.doesNotMatch(sql, /credential_plaintext/i);

  const githubWebhookSql = migrations[61]?.sql ?? "";
  assert.match(githubWebhookSql, /CREATE TABLE webhook_github_connections\b/);
  assert.match(githubWebhookSql, /CREATE TABLE webhook_github_receipts\b/);
  assert.match(
    githubWebhookSql,
    /CREATE TABLE environment_webhook_session_bindings\b/,
  );
  assert.match(githubWebhookSql, /'source_thread'/);
  assert.doesNotMatch(
    githubWebhookSql,
    /access_token|refresh_token|installation_token/i,
  );

  const simplifiedWebhookSql = migrations[62]?.sql ?? "";
  assert.match(simplifiedWebhookSql, /DELETE FROM environment_webhooks/);
  assert.match(
    simplifiedWebhookSql,
    /DROP TABLE environment_webhook_trigger_states/,
  );
  assert.match(
    simplifiedWebhookSql,
    /DROP TABLE environment_webhook_cooldown_buckets/,
  );
  assert.match(
    simplifiedWebhookSql,
    /CREATE TABLE environment_webhook_batch_buckets\b/,
  );
  assert.match(simplifiedWebhookSql, /ADD COLUMN event_types JSONB NOT NULL/);

  const deviceAuthSql = migrations[3]?.sql ?? "";
  assert.match(deviceAuthSql, /CREATE TABLE codex_device_auth_flows\b/);
  assert.doesNotMatch(deviceAuthSql, /ciphertext|authentication_tag|refresh_token/);

  const bindingsSql = migrations[4]?.sql ?? "";
  assert.match(bindingsSql, /CREATE TABLE sandbox_credential_bindings\b/);
  assert.match(bindingsSql, /credential_source_id TEXT NOT NULL/);
  assert.doesNotMatch(bindingsSql, /credential_plaintext|auth_json/i);

  const checkpointsSql = migrations[6]?.sql ?? "";
  assert.match(checkpointsSql, /CREATE TABLE session_turn_checkpoints\b/);
  assert.match(checkpointsSql, /workspace_snapshot_id TEXT/);
  assert.match(checkpointsSql, /ADD COLUMN visible BOOLEAN NOT NULL DEFAULT TRUE/);

  const turnInputsSql = migrations[11]?.sql ?? "";
  assert.match(turnInputsSql, /pending_turn_input_snapshot_id TEXT/);
  assert.match(turnInputsSql, /input_workspace_snapshot_id TEXT/);

  const supervisorEpochSql = migrations[12]?.sql ?? "";
  assert.match(supervisorEpochSql, /ADD COLUMN supervisor_session_id TEXT/);
  assert.match(
    supervisorEpochSql,
    /UNIQUE \(\s*session_id,\s*supervisor_session_id,\s*supervisor_sequence,\s*record_index\s*\)/,
  );

  const reasoningEffortSql = migrations[33]?.sql ?? "";
  assert.match(reasoningEffortSql, /ADD COLUMN reasoning_effort TEXT/);
  assert.match(reasoningEffortSql, /reasoning_effort_nonempty/);

  const environmentPauseIntervalsSql = migrations[34]?.sql ?? "";
  assert.match(
    environmentPauseIntervalsSql,
    /CREATE TABLE environment_pause_intervals\b/,
  );
  assert.match(
    environmentPauseIntervalsSql,
    /AFTER UPDATE OF paused_at ON environment_runtime/,
  );
  assert.match(
    environmentPauseIntervalsSql,
    /OLD\.paused_at IS DISTINCT FROM NEW\.paused_at/,
  );

  const nativeAuthoritySql = migrations[13]?.sql ?? "";
  assert.match(
    nativeAuthoritySql,
    /RENAME COLUMN thread_id TO native_session_id/,
  );
  assert.match(nativeAuthoritySql, /DROP COLUMN history_revision/);
  assert.match(nativeAuthoritySql, /CREATE TABLE session_turn_mutations\b/);
  assert.match(nativeAuthoritySql, /DROP TABLE harness_events/);
  assert.doesNotMatch(
    nativeAuthoritySql,
    /INSERT INTO harness_events|CREATE TABLE harness_events/,
  );

  const nativeRecoverySql = migrations[14]?.sql ?? "";
  assert.match(nativeRecoverySql, /pending_interrupted_native_turn_id TEXT/);
  assert.match(nativeRecoverySql, /workspace_volume_id TEXT/);
  assert.match(nativeRecoverySql, /ALTER COLUMN workspace_volume_id SET NOT NULL/);
  assert.doesNotMatch(nativeRecoverySql, /message|notification|payload JSONB/);

  const workspaceNativeStateSql = migrations[15]?.sql ?? "";
  assert.match(
    workspaceNativeStateSql,
    /RENAME COLUMN native_branch_revision TO history_revision/,
  );
  assert.match(workspaceNativeStateSql, /harness_state_layout TEXT NOT NULL/);
  assert.match(workspaceNativeStateSql, /head_volume_snapshot_id TEXT/);
  assert.match(workspaceNativeStateSql, /includes_native_state BOOLEAN/);
  assert.match(workspaceNativeStateSql, /workspace_volume_id TEXT/);
  assert.match(workspaceNativeStateSql, /expected_history_revision BIGINT/);
  assert.match(workspaceNativeStateSql, /result_native_session_id TEXT/);
  assert.match(workspaceNativeStateSql, /replacement_started/);
  assert.match(workspaceNativeStateSql, /DROP COLUMN replacement_native_session_id/);
  assert.match(workspaceNativeStateSql, /DROP COLUMN branch_through_native_turn_id/);
  assert.doesNotMatch(workspaceNativeStateSql, /payload JSONB|notification JSONB/);

  const billingUsageSql = migrations[47]?.sql ?? "";
  assert.match(billingUsageSql, /CREATE TABLE user_subscriptions\b/);
  assert.match(billingUsageSql, /CREATE TABLE stripe_webhook_events\b/);
  assert.match(billingUsageSql, /processing_started_at TIMESTAMPTZ/);
  assert.match(billingUsageSql, /CREATE TABLE sandbox_usage_attributions\b/);
  assert.match(billingUsageSql, /CREATE TABLE sandbox_usage_windows\b/);
  assert.match(billingUsageSql, /CREATE TABLE sandbox_runtime_segments\b/);
  assert.match(
    billingUsageSql,
    /public Sandbox0 SDK; Sandbox0 remains usage truth/,
  );

  const ultraSubscriptionPlanSql = migrations[58]?.sql ?? "";
  assert.match(
    ultraSubscriptionPlanSql,
    /plan_id IN \('plus', 'pro', 'ultra'\)/,
  );
  assert.match(
    ultraSubscriptionPlanSql,
    /pending_plan_id IN \('plus', 'pro', 'ultra'\)/,
  );

  const environmentWebhooksSql = migrations[59]?.sql ?? "";
  assert.match(environmentWebhooksSql, /CREATE TABLE environment_webhooks\b/);
  assert.match(
    environmentWebhooksSql,
    /CREATE TABLE environment_webhook_deliveries\b/,
  );
  assert.match(
    environmentWebhooksSql,
    /CREATE TABLE environment_webhook_cooldown_buckets\b/,
  );
  assert.match(
    environmentWebhooksSql,
    /CREATE TABLE environment_webhook_runs\b/,
  );
  assert.match(environmentWebhooksSql, /secret_ciphertext BYTEA NOT NULL/);
  assert.doesNotMatch(environmentWebhooksSql, /secret_plaintext/i);

  const retireWebhookProviderAdaptersSql = migrations[60]?.sql ?? "";
  assert.match(
    retireWebhookProviderAdaptersSql,
    /SET enabled = FALSE[\s\S]+WHERE provider <> 'custom'/,
  );
  assert.match(
    retireWebhookProviderAdaptersSql,
    /ALTER TABLE environment_webhooks[\s\S]+DROP COLUMN provider/,
  );
  assert.match(
    retireWebhookProviderAdaptersSql,
    /ALTER TABLE environment_webhook_deliveries[\s\S]+RENAME COLUMN provider_delivery_id TO source_delivery_id/,
  );

  const sandbox0LifecycleTruthSql = migrations[53]?.sql ?? "";
  assert.match(
    sandbox0LifecycleTruthSql,
    /ALTER TABLE environment_runtime DROP COLUMN observed_state/,
  );
  assert.match(
    sandbox0LifecycleTruthSql,
    /DROP FUNCTION IF EXISTS project_sandbox_runtime_usage/,
  );
  assert.match(
    sandbox0LifecycleTruthSql,
    /UPDATE sandbox_runtime_segments[\s\S]+WHERE ended_at IS NULL/,
  );
  assert.match(
    sandbox0LifecycleTruthSql,
    /AFTER INSERT OR UPDATE OF sandbox_id[\s\S]+sync_sandbox_usage_attribution/,
  );
  assert.doesNotMatch(
    sandbox0LifecycleTruthSql,
    /UPDATE OF sandbox_id,\s*observed_state/,
  );

  const manualEnvironmentLifecycleSql = migrations[55]?.sql ?? "";
  assert.match(
    manualEnvironmentLifecycleSql,
    /reason IN \('idle', 'quota', 'manual'\)/,
  );
  assert.match(
    manualEnvironmentLifecycleSql,
    /pause_reason IN \('idle', 'quota', 'manual'\)/,
  );

  const environmentResourceDefaultsSql = migrations[48]?.sql ?? "";
  assert.match(
    environmentResourceDefaultsSql,
    /ALTER COLUMN idle_pause_timeout_seconds SET DEFAULT 900/,
  );
  assert.match(
    environmentResourceDefaultsSql,
    /ALTER COLUMN sandbox_memory_mib SET DEFAULT 1024/,
  );
  assert.doesNotMatch(environmentResourceDefaultsSql, /UPDATE environments/i);

  const turnSubmissionSql = migrations[16]?.sql ?? "";
  assert.match(turnSubmissionSql, /pending_turn_request_id TEXT/);
  assert.match(turnSubmissionSql, /pending_turn_client_message_id TEXT/);
  assert.match(turnSubmissionSql, /pending_turn_stable_input_id TEXT/);
  assert.match(turnSubmissionSql, /pending_turn_phase TEXT/);
  assert.doesNotMatch(
    turnSubmissionSql,
    /prompt\s+(TEXT|JSONB)|input\s+JSONB|payload\s+JSONB/i,
  );

  const deliveryOutboxSql = migrations[17]?.sql ?? "";
  assert.match(deliveryOutboxSql, /'staged'/);
  assert.doesNotMatch(
    deliveryOutboxSql,
    /prompt\s+(TEXT|JSONB)|input\s+JSONB|payload\s+JSONB/i,
  );

  const exclusiveOperationsSql = migrations[18]?.sql ?? "";
  assert.match(exclusiveOperationsSql, /exclusive_operation_id TEXT/);
  assert.match(exclusiveOperationsSql, /'session_fork', 'turn_fork'/);

  const nativeHistorySql = migrations[19]?.sql ?? "";
  assert.match(nativeHistorySql, /native_history_materialized BOOLEAN/);
  assert.doesNotMatch(nativeHistorySql, /message|prompt|payload JSONB/i);

  const operationRecoverySql = migrations[20]?.sql ?? "";
  assert.match(operationRecoverySql, /exclusive_operation_heartbeat_at/);
  assert.match(operationRecoverySql, /native_state_migration_snapshot_id/);
  assert.match(operationRecoverySql, /'runtime_recovery'/);
  assert.match(operationRecoverySql, /'native_state_migration'/);
  assert.doesNotMatch(operationRecoverySql, /message|prompt|payload JSONB/i);

  const environmentRuntimeSql = migrations[21]?.sql ?? "";
  assert.match(environmentRuntimeSql, /CREATE TABLE environment_runtime\b/);
  assert.match(
    environmentRuntimeSql,
    /environment_id TEXT PRIMARY KEY REFERENCES environments\(id\)/,
  );
  assert.match(environmentRuntimeSql, /DROP TABLE IF EXISTS session_turn_checkpoints/);
  assert.match(environmentRuntimeSql, /CREATE TABLE session_runtime\b/);
  assert.match(environmentRuntimeSql, /native_session_id TEXT/);
  assert.match(
    environmentRuntimeSql,
    /CREATE TABLE environment_credential_bindings\b/,
  );
  assert.doesNotMatch(
    environmentRuntimeSql,
    /prompt\s+(TEXT|JSONB)|message\s+(TEXT|JSONB)|payload\s+JSONB/i,
  );

  const environmentLifecycleSql = migrations[22]?.sql ?? "";
  assert.match(environmentLifecycleSql, /lifecycle_policy_version INTEGER/);
  assert.match(environmentLifecycleSql, /sandbox_hard_expires_at TIMESTAMPTZ/);
  assert.match(environmentLifecycleSql, /last_turn_completed_at TIMESTAMPTZ/);
  assert.match(environmentLifecycleSql, /idle_pause_due_at TIMESTAMPTZ/);
  assert.doesNotMatch(
    environmentLifecycleSql,
    /prompt\s+(TEXT|JSONB)|message\s+(TEXT|JSONB)|payload\s+JSONB/i,
  );

  const idlePausePolicySql = migrations[23]?.sql ?? "";
  assert.match(idlePausePolicySql, /INTERVAL '27 minutes'/);
  assert.match(idlePausePolicySql, /desired_state IN \('running', 'paused'\)/);
  assert.match(idlePausePolicySql, /observed_state = 'running'/);

  const personalPinsSql = migrations[37]?.sql ?? "";
  assert.match(personalPinsSql, /CREATE TABLE session_pins\b/);
  assert.match(
    personalPinsSql,
    /PRIMARY KEY \(session_id, user_id\)/,
  );
  assert.match(personalPinsSql, /DROP COLUMN pinned/);
  assert.match(
    personalPinsSql,
    /idle_pause_timeout_seconds INTEGER NOT NULL DEFAULT 1800/,
  );
  assert.match(
    personalPinsSql,
    /idle_pause_timeout_seconds >= 0/,
  );

  const initializedIdleDeadlinesSql = migrations[38]?.sql ?? "";
  assert.match(
    initializedIdleDeadlinesSql,
    /environment\.idle_pause_timeout_seconds::BIGINT \* INTERVAL '1 second'/,
  );
  assert.match(initializedIdleDeadlinesSql, /runtime\.observed_state = 'running'/);
  assert.match(initializedIdleDeadlinesSql, /runtime\.idle_pause_due_at IS NULL/);

  const sandboxMemorySql = migrations[39]?.sql ?? "";
  assert.match(
    sandboxMemorySql,
    /sandbox_memory_mib INTEGER NOT NULL DEFAULT 2048/,
  );
  assert.match(sandboxMemorySql, /sandbox_memory_mib >= 128/);
  assert.match(sandboxMemorySql, /sandbox_memory_mib <= 8192/);

  const removedEnvironmentHardTtlSql = migrations[40]?.sql ?? "";
  assert.match(
    removedEnvironmentHardTtlSql,
    /DROP INDEX IF EXISTS environment_runtime_hard_expiry_idx/,
  );
  assert.match(
    removedEnvironmentHardTtlSql,
    /DROP COLUMN sandbox_hard_expires_at/,
  );
  assert.match(
    removedEnvironmentHardTtlSql,
    /zero disables automatic pause; maximum 30 days/,
  );

  const environmentMcpToolPoliciesSql = migrations[41]?.sql ?? "";
  assert.match(
    environmentMcpToolPoliciesSql,
    /ADD COLUMN tool_policy_mode TEXT NOT NULL DEFAULT 'all'/,
  );
  assert.match(
    environmentMcpToolPoliciesSql,
    /ADD COLUMN allowed_tools TEXT\[\] NOT NULL DEFAULT '\{\}'/,
  );
  assert.match(
    environmentMcpToolPoliciesSql,
    /tool_policy_status IN \('active', 'updating', 'error'\)/,
  );
  assert.match(
    environmentMcpToolPoliciesSql,
    /tool_policy_mode = 'selected'[\s\S]+cardinality\(allowed_tools\) > 0/,
  );

  const userOwnedResourcesSql = migrations[43]?.sql ?? "";
  assert.match(
    userOwnedResourcesSql,
    /ALTER COLUMN created_by_user_id SET NOT NULL/,
  );
  assert.match(userOwnedResourcesSql, /DROP COLUMN visibility/);
  assert.match(userOwnedResourcesSql, /DROP COLUMN team_id/);
  assert.match(userOwnedResourcesSql, /DROP TABLE team_memberships/);
  assert.match(userOwnedResourcesSql, /DROP TABLE teams/);

  const runtimeAuthoritySql = migrations[24]?.sql ?? "";
  assert.match(runtimeAuthoritySql, /decoder_attempt_id TEXT/);
  assert.match(runtimeAuthoritySql, /decoder_runtime_generation BIGINT/);
  assert.match(runtimeAuthoritySql, /SET decoder_attempt_id = attempt_id/);
  assert.match(runtimeAuthoritySql, /Sandbox0 remains authoritative/);

  const runtimeAuthorityCommentsSql = migrations[25]?.sql ?? "";
  assert.match(
    runtimeAuthorityCommentsSql,
    /attempt whose ephemeral credential was materialized/,
  );
  assert.match(
    runtimeAuthorityCommentsSql,
    /generation whose ephemeral credential was materialized/,
  );

  const runtimeTurnRecoverySql = migrations[45]?.sql ?? "";
  assert.match(runtimeTurnRecoverySql, /active_turn_attempt_id TEXT/);
  assert.match(
    runtimeTurnRecoverySql,
    /active_turn_runtime_generation BIGINT/,
  );
  assert.match(runtimeTurnRecoverySql, /pending_turn_attempt_id TEXT/);
  assert.match(
    runtimeTurnRecoverySql,
    /pending_turn_runtime_generation BIGINT/,
  );
  assert.match(
    runtimeTurnRecoverySql,
    /interrupt_requested_native_turn_id TEXT/,
  );
  assert.match(
    runtimeTurnRecoverySql,
    /recovery_source_native_turn_id TEXT/,
  );
  assert.match(runtimeTurnRecoverySql, /recovery_prompt_version INTEGER/);
  assert.match(
    runtimeTurnRecoverySql,
    /recovery_attempt_count INTEGER NOT NULL DEFAULT 0/,
  );
  assert.doesNotMatch(
    runtimeTurnRecoverySql,
    /prompt\s+(TEXT|JSONB)|message\s+(TEXT|JSONB)|input\s+JSONB|payload\s+JSONB/i,
  );

  const retiredRuntimeTurnRecoverySql = migrations[49]?.sql ?? "";
  assert.match(
    retiredRuntimeTurnRecoverySql,
    /runtime_error_code LIKE 'automatic_turn_recovery_%'/,
  );
  assert.match(
    retiredRuntimeTurnRecoverySql,
    /DROP COLUMN recovery_source_native_turn_id/,
  );
  assert.match(
    retiredRuntimeTurnRecoverySql,
    /DROP COLUMN recovery_prompt_version/,
  );
  assert.match(
    retiredRuntimeTurnRecoverySql,
    /DROP COLUMN recovery_attempt_count/,
  );

  const restoredRuntimeTurnRecoverySql = migrations[50]?.sql ?? "";
  assert.match(
    restoredRuntimeTurnRecoverySql,
    /ADD COLUMN recovery_source_native_turn_id TEXT/,
  );
  assert.match(
    restoredRuntimeTurnRecoverySql,
    /ADD COLUMN recovery_prompt_version INTEGER/,
  );
  assert.match(
    restoredRuntimeTurnRecoverySql,
    /ADD COLUMN recovery_attempt_count INTEGER NOT NULL DEFAULT 0/,
  );
  assert.doesNotMatch(
    restoredRuntimeTurnRecoverySql,
    /prompt\s+(TEXT|JSONB)|message\s+(TEXT|JSONB)|input\s+JSONB|payload\s+JSONB/i,
  );

  const environmentNetworkPolicySql = migrations[26]?.sql ?? "";
  assert.match(environmentNetworkPolicySql, /'domainExceptions'/);
  assert.match(
    environmentNetworkPolicySql,
    /network_policy->>'mode' = 'allow-all'/,
  );
  assert.match(environmentNetworkPolicySql, /ELSE 'block-all'/);
  assert.doesNotMatch(environmentNetworkPolicySql, /restricted'\s+THEN/);

  const environmentMcpIntegrationsSql = migrations[27]?.sql ?? "";
  assert.match(
    environmentMcpIntegrationsSql,
    /CREATE TABLE environment_mcp_integrations\b/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /credential_source_ref TEXT/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /credential_binding_ref TEXT/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /endpoint_fingerprint TEXT NOT NULL/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /destination_domain TEXT NOT NULL/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /destination_path TEXT NOT NULL/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /lifecycle_status TEXT NOT NULL/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /credential_status TEXT NOT NULL/,
  );
  assert.match(environmentMcpIntegrationsSql, /last_error TEXT/);
  assert.match(
    environmentMcpIntegrationsSql,
    /CREATE TABLE environment_mcp_oauth_flows\b/,
  );
  assert.match(
    environmentMcpIntegrationsSql,
    /environment_mcp_oauth_flows_one_active_idx[\s\S]+WHERE status IN \('starting', 'awaiting_user'\)/,
  );
  assert.doesNotMatch(
    environmentMcpIntegrationsSql,
    /\b(?:plaintext|ciphertext|api_key|access_token|refresh_token|authorization_code)\s+(?:TEXT|BYTEA|JSONB)\b/i,
  );

  const codexNativeCredentialSlotsSql = migrations[28]?.sql ?? "";
  assert.match(
    codexNativeCredentialSlotsSql,
    /UNIQUE \(environment_id, harness, credential_slot, revision\)/,
  );
  assert.match(
    codexNativeCredentialSlotsSql,
    /ON harness_credentials \(environment_id, harness, credential_slot\)[\s\S]+WHERE revoked_at IS NULL/,
  );
  assert.match(
    codexNativeCredentialSlotsSql,
    /credential_slot = 'account'[\s\S]+credential_type = 'codex-native-auth-json'/,
  );
  assert.match(
    codexNativeCredentialSlotsSql,
    /credential_slot = 'mcp-oauth'[\s\S]+credential_type = 'codex-mcp-oauth-json'/,
  );
  assert.match(
    codexNativeCredentialSlotsSql,
    /credential_slot = 'account'[\s\S]+native_target_path = '\/dev\/shm\/sandpi-codex-auth\.json'/,
  );
  assert.match(
    codexNativeCredentialSlotsSql,
    /credential_slot = 'mcp-oauth'[\s\S]+native_target_path = '\/dev\/shm\/sandpi-codex-mcp-oauth\.json'/,
  );
  assert.doesNotMatch(
    codexNativeCredentialSlotsSql,
    /\b(?:plaintext|api_key|access_token|refresh_token|authorization_code)\s+(?:TEXT|BYTEA|JSONB)\b/i,
  );

  const environmentMcpProjectionSql = migrations[29]?.sql ?? "";
  assert.match(
    environmentMcpProjectionSql,
    /ADD COLUMN credential_header_name TEXT/,
  );
  assert.match(
    environmentMcpProjectionSql,
    /ADD COLUMN credential_value_template TEXT/,
  );
  assert.match(
    environmentMcpProjectionSql,
    /credential_value_template[\s\S]+\\\.token/,
  );
  assert.doesNotMatch(
    environmentMcpProjectionSql,
    /\b(?:plaintext|ciphertext|api_key|access_token|refresh_token|authorization_code)\s+(?:TEXT|BYTEA|JSONB)\b/i,
  );

  const environmentMcpMutationSagasSql = migrations[30]?.sql ?? "";
  assert.match(environmentMcpMutationSagasSql, /ADD COLUMN version BIGINT/);
  assert.match(
    environmentMcpMutationSagasSql,
    /ADD COLUMN binding_enabled BOOLEAN NOT NULL DEFAULT FALSE/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /ADD COLUMN pending_credential_source_ref TEXT/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /ADD COLUMN retiring_credential_source_ref TEXT/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /ADD COLUMN oauth_config_fingerprint TEXT/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /ADD COLUMN endpoint_fingerprint TEXT/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /environment_mcp_oauth_flows_one_blocking_idx[\s\S]+WHERE status IN \('starting', 'awaiting_user', 'cancelled'\)/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /environment_mcp_integrations_saga_lifecycle_check[\s\S]+lifecycle_status IN \('updating', 'deleting', 'error'\)/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /ADD COLUMN cleanup_completed_at TIMESTAMPTZ/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /environment_mcp_oauth_flows_cleanup_pending_idx[\s\S]+cleanup_completed_at IS NULL/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /SET status = 'cancelled'[\s\S]+WHERE status IN \('starting', 'awaiting_user'\)[\s\S]+expires_at <= NOW\(\)/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /ranked_blocking_flows[\s\S]+WHERE status IN \('starting', 'awaiting_user', 'cancelled'\)[\s\S]+ranked\.rank > 1/,
  );
  assert.doesNotMatch(
    environmentMcpMutationSagasSql.match(
      /WITH ranked_blocking_flows[\s\S]+?ranked\.rank > 1;/,
    )?.[0] ?? "",
    /expires_at > NOW\(\)/,
  );
  assert.match(
    environmentMcpMutationSagasSql,
    /oauth_config_fingerprint = \([\s\S]+flow\.status IN \([\s\S]+'starting', 'awaiting_user', 'completed', 'cancelled'/,
  );
  assert.doesNotMatch(
    environmentMcpMutationSagasSql,
    /\b(?:plaintext|ciphertext|api_key|access_token|refresh_token|authorization_code)\s+(?:TEXT|BYTEA|JSONB)\b/i,
  );

  const environmentMcpOAuthEventJournalSql = migrations[31]?.sql ?? "";
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /ALTER TABLE environment_mcp_oauth_flows[\s\S]+ADD COLUMN native_thread_id TEXT/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /ADD COLUMN native_runtime_generation BIGINT[\s\S]+ADD COLUMN native_attempt_id TEXT[\s\S]+ADD COLUMN native_thread_cleanup_completed_at TIMESTAMPTZ/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /environment_mcp_oauth_flows_native_correlation_group_check[\s\S]+num_nonnulls\([\s\S]+native_thread_id,[\s\S]+native_runtime_generation,[\s\S]+native_attempt_id[\s\S]+\) IN \(0, 3\)/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /environment_mcp_oauth_flows_native_correlation_check[\s\S]+length\(btrim\(native_thread_id\)\) > 0[\s\S]+native_runtime_generation >= 0/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /environment_mcp_oauth_flows_thread_cleanup_status_check[\s\S]+native_thread_cleanup_completed_at IS NULL[\s\S]+status IN \('completed', 'failed', 'cancelled', 'expired'\)/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /SET status = 'cancelled'[\s\S]+WHERE status IN \('starting', 'awaiting_user'\)[\s\S]+native_thread_id IS NULL/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /CREATE UNIQUE INDEX environment_mcp_oauth_flows_native_thread_idx[\s\S]+environment_id,[\s\S]+native_thread_id[\s\S]+WHERE native_thread_id IS NOT NULL/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /environment_mcp_oauth_flows_thread_cleanup_pending_idx[\s\S]+native_thread_id IS NOT NULL[\s\S]+native_thread_cleanup_completed_at IS NULL[\s\S]+status IN \('completed', 'failed', 'cancelled', 'expired'\)/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /CREATE TABLE environment_mcp_oauth_events\b/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /environment_id TEXT NOT NULL[\s\S]+REFERENCES environments\(id\) ON DELETE CASCADE/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /attempt_id TEXT NOT NULL/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /PRIMARY KEY \(\s*environment_id,\s*runtime_generation,\s*supervisor_sequence,\s*record_index,\s*attempt_id\s*\)/,
  );
  assert.match(
    environmentMcpOAuthEventJournalSql,
    /server_name TEXT NOT NULL[\s\S]+success BOOLEAN NOT NULL[\s\S]+disposition TEXT NOT NULL[\s\S]+occurred_at TIMESTAMPTZ NOT NULL[\s\S]+processed_at TIMESTAMPTZ NOT NULL/,
  );
  assert.doesNotMatch(
    environmentMcpOAuthEventJournalSql,
    /\b(?:plaintext|ciphertext|api_key|access_token|refresh_token|authorization_code)\s+(?:TEXT|BYTEA|JSONB)\b/i,
  );

  const dropEnvironmentFunctionsSql = migrations[32]?.sql ?? "";
  assert.match(
    dropEnvironmentFunctionsSql,
    /ALTER TABLE environments[\s\S]+DROP COLUMN IF EXISTS functions/,
  );

  const teamOwnershipSql = migrations[36]?.sql ?? "";
  assert.match(
    teamOwnershipSql,
    /ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'/,
  );
  assert.match(
    teamOwnershipSql,
    /ALTER COLUMN visibility SET DEFAULT 'team'/,
  );
  assert.match(
    teamOwnershipSql,
    /FOREIGN KEY \(environment_id, team_id\)[\s\S]+REFERENCES environments \(id, team_id\)/,
  );
  assert.match(teamOwnershipSql, /ADD COLUMN plan_id TEXT/);
  assert.match(teamOwnershipSql, /ADD COLUMN plan_quotas JSONB/);
  assert.match(
    teamOwnershipSql,
    /ALTER TABLE team_memberships[\s\S]+DROP COLUMN plan_assignment_id[\s\S]+DROP COLUMN plan_quotas/,
  );

  const workspaceBackupsSql = migrations[42]?.sql ?? "";
  assert.match(
    workspaceBackupsSql,
    /workspace_backup_interval_seconds INTEGER NOT NULL DEFAULT 0/,
  );
  assert.match(
    workspaceBackupsSql,
    /workspace_backup_retention_count INTEGER NOT NULL DEFAULT 7/,
  );
  assert.match(
    workspaceBackupsSql,
    /CREATE TABLE environment_workspace_backups\b/,
  );
  assert.match(
    workspaceBackupsSql,
    /snapshot_id TEXT PRIMARY KEY[\s\S]+environment_id TEXT NOT NULL REFERENCES environments\(id\) ON DELETE CASCADE/,
  );
  assert.match(workspaceBackupsSql, /workspace_backup_retry_at TIMESTAMPTZ/);
  assert.doesNotMatch(workspaceBackupsSql, /snapshot_(?:content|bytes) BYTEA/i);

  const codexNativeMcpSql = migrations[44]?.sql ?? "";
  assert.match(
    codexNativeMcpSql,
    /Cannot remove legacy MCP integration state[\s\S]+ERRCODE = 'check_violation'/,
  );
  assert.match(
    codexNativeMcpSql,
    /DELETE FROM environment_credential_bindings[\s\S]+credential_slot = 'mcp-oauth'/,
  );
  assert.match(
    codexNativeMcpSql,
    /DELETE FROM harness_credentials[\s\S]+credential_slot = 'mcp-oauth'/,
  );
  assert.match(codexNativeMcpSql, /DROP TABLE environment_mcp_oauth_events/);
  assert.match(codexNativeMcpSql, /DROP TABLE environment_mcp_oauth_flows/);
  assert.match(codexNativeMcpSql, /DROP TABLE environment_mcp_integrations/);
  assert.match(
    codexNativeMcpSql,
    /harness_credentials_codex_slot_check[\s\S]+credential_slot = 'account'[\s\S]+credential_type = 'codex-native-auth-json'/,
  );
  assert.match(
    codexNativeMcpSql,
    /environment_credential_bindings_codex_slot_check[\s\S]+credential_slot = 'account'[\s\S]+native_target_path = '\/dev\/shm\/sandpi-codex-auth\.json'/,
  );

  const environmentEgressCredentialsSql = migrations[46]?.sql ?? "";
  assert.match(
    environmentEgressCredentialsSql,
    /CREATE TABLE environment_egress_credentials\b/,
  );
  assert.match(
    environmentEgressCredentialsSql,
    /environment_id TEXT NOT NULL REFERENCES environments\(id\) ON DELETE CASCADE/,
  );
  assert.match(environmentEgressCredentialsSql, /source_ref TEXT NOT NULL UNIQUE/);
  assert.match(
    environmentEgressCredentialsSql,
    /status IN \('provisioning', 'active', 'error', 'deleting'\)/,
  );
  assert.doesNotMatch(
    environmentEgressCredentialsSql,
    /\b(?:secret|password|private_key|certificate|ciphertext)\s+(?:TEXT|BYTEA|JSONB)\b/i,
  );

  const environmentSchedulesSql = migrations[51]?.sql ?? "";
  assert.match(
    environmentSchedulesSql,
    /CREATE TABLE environment_schedules\b/,
  );
  assert.match(
    environmentSchedulesSql,
    /CREATE TABLE environment_schedule_runs\b/,
  );
  assert.match(
    environmentSchedulesSql,
    /UNIQUE \(schedule_id, scheduled_for\)/,
  );
  assert.match(
    environmentSchedulesSql,
    /client_message_id TEXT NOT NULL[\s\S]+UNIQUE \(client_message_id\)/,
  );
  assert.match(
    environmentSchedulesSql,
    /lease_expires_at TIMESTAMPTZ/,
  );
  assert.match(
    environmentSchedulesSql,
    /prompt TEXT NOT NULL CHECK \(char_length\(prompt\) BETWEEN 1 AND 100000\)/,
  );

  const archivedScheduleTargetSql = migrations[52]?.sql ?? "";
  assert.match(
    archivedScheduleTargetSql,
    /BEFORE UPDATE OF archived ON sessions/,
  );
  assert.match(
    archivedScheduleTargetSql,
    /SET enabled = FALSE,[\s\S]+next_run_at = NULL/,
  );

  const nativeAuthSql = migrations[54]?.sql ?? "";
  assert.match(nativeAuthSql, /CREATE TABLE native_auth_attempts\b/);
  assert.match(nativeAuthSql, /code_challenge TEXT NOT NULL/);
  assert.match(nativeAuthSql, /code_hash BYTEA UNIQUE/);
  assert.match(nativeAuthSql, /consumed_at TIMESTAMPTZ/);
  assert.doesNotMatch(
    nativeAuthSql,
    /\b(?:code|verifier|session_token)\s+(?:TEXT|BYTEA)\b/i,
  );
});

test(
  "retiring Webhook provider adapters disables legacy definitions before dropping the discriminator",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_webhook_migration_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-webhook-migration-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-webhook-migration-test",
      options: `-c search_path=${schema}`,
      max: 2,
    });
    context.after(async () => {
      await database.end();
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.end();
    });
    await database.query(`
      CREATE TABLE environment_webhooks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        enabled BOOLEAN NOT NULL,
        last_error TEXT,
        revision BIGINT NOT NULL,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE environment_webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        provider_delivery_id TEXT NOT NULL,
        UNIQUE (webhook_id, provider_delivery_id)
      );
      INSERT INTO environment_webhooks
        (id, provider, enabled, revision)
      VALUES
        ('legacy-github', 'github', TRUE, 1),
        ('generic', 'custom', TRUE, 1);
      INSERT INTO environment_webhook_deliveries
        (id, webhook_id, provider_delivery_id)
      VALUES ('delivery', 'webhook', 'source-id');
    `);

    const migration = (await loadMigrations()).find(
      (candidate) =>
        candidate.version === "0061_retire_webhook_provider_adapters",
    );
    assert.ok(migration);
    await migrateDatabase(database, [migration]);

    const definitions = await database.query<{
      id: string;
      enabled: boolean;
      last_error: string | null;
      revision: string;
    }>(
      `SELECT id, enabled, last_error, revision::TEXT
       FROM environment_webhooks ORDER BY id`,
    );
    assert.deepEqual(definitions.rows, [
      {
        id: "generic",
        enabled: true,
        last_error: null,
        revision: "1",
      },
      {
        id: "legacy-github",
        enabled: false,
        last_error:
          "The built-in github adapter was removed. Rotate the secret and configure this definition as a generic Webhook before enabling it.",
        revision: "2",
      },
    ]);
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name IN (
           'environment_webhooks',
           'environment_webhook_deliveries'
         )`,
      [schema],
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    assert.equal(names.has("provider"), false);
    assert.equal(names.has("provider_delivery_id"), false);
    assert.equal(names.has("source_delivery_id"), true);
    const constraints = await database.query<{ conname: string }>(
      `SELECT constraint_row.conname
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1
         AND relation.relname = 'environment_webhook_deliveries'`,
      [schema],
    );
    assert.equal(
      constraints.rows.some((row) => row.conname.includes("provider")),
      false,
    );
    assert.equal(
      constraints.rows.some(
        (row) =>
          row.conname ===
          "environment_webhook_deliveries_source_delivery_key",
      ),
      true,
    );
  },
);

test(
  "simplifying Webhooks deliberately discards unreleased definitions and policy state",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_webhook_simplification_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-webhook-simplification-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-webhook-simplification-test",
      options: `-c search_path=${schema}`,
      max: 2,
    });
    context.after(async () => {
      await database.end();
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.end();
    });

    const migrations = await loadMigrations();
    await migrateDatabase(database, migrations.slice(0, 62));
    await seedCommunityDefaults(database, {
      admin: {
        id: "user-webhook-simplification",
        email: "webhook-simplification@sandpi.local",
        identitySubject: "webhook-simplification",
      },
      environment: {
        id: "environment-webhook-simplification",
        name: "Webhook simplification",
      },
    });
    await database.query(
      `INSERT INTO environment_webhooks (
         id, environment_id, created_by_user_id, endpoint_id, name,
         secret_ciphertext, secret_initialization_vector,
         secret_authentication_tag, secret_algorithm, secret_key_id,
         prompt, target_kind
       ) VALUES (
         'legacy-webhook', 'environment-webhook-simplification',
         'user-webhook-simplification', 'legacy-endpoint', 'Legacy policy',
         decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'),
         'aes-256-gcm', 'legacy-key', 'Legacy prompt', 'new_session'
       )`,
    );

    const migration = migrations[62];
    assert.equal(migration?.version, "0063_simplify_environment_webhooks");
    await migrateDatabase(database, [migration!]);

    const definitions = await database.query<{ count: string }>(
      "SELECT COUNT(*)::TEXT AS count FROM environment_webhooks",
    );
    assert.equal(definitions.rows[0]?.count, "0");
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'environment_webhooks'`,
      [schema],
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    assert.equal(names.has("trigger_mode"), false);
    assert.equal(names.has("conditions"), false);
    assert.equal(names.has("cooldown_mode"), false);
    assert.equal(names.has("max_pending_runs"), false);
    assert.equal(names.has("batch_window_seconds"), true);
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name LIKE 'environment_webhook_%'`,
      [schema],
    );
    const tableNames = new Set(tables.rows.map((row) => row.table_name));
    assert.equal(tableNames.has("environment_webhook_trigger_states"), false);
    assert.equal(tableNames.has("environment_webhook_cooldown_buckets"), false);
    assert.equal(tableNames.has("environment_webhook_batch_buckets"), true);
  },
);
