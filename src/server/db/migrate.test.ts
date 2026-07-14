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
});
