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
});
