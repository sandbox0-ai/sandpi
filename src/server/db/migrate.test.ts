import assert from "node:assert/strict";
import test from "node:test";
import {
  loadMigrations,
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
});
