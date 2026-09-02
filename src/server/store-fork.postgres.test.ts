import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { SandpiStore } from "./store";

test(
  "journals and publishes one paused Environment fork in PostgreSQL",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-store-fork-postgres-test",
      max: 1,
    });
    context.after(() => database.end());
    await database.query(`
      CREATE TEMP TABLE environments (
        id TEXT PRIMARY KEY,
        created_by_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        template_id TEXT,
        rootfs_snapshot_id TEXT,
        credential_revision INTEGER NOT NULL,
        harness TEXT NOT NULL,
        harness_metadata JSONB NOT NULL,
        network_policy JSONB NOT NULL,
        sandbox_memory_mib INTEGER NOT NULL,
        idle_pause_timeout_seconds INTEGER NOT NULL,
        workspace_backup_interval_seconds INTEGER NOT NULL,
        workspace_backup_retention_count INTEGER NOT NULL,
        display_order INTEGER NOT NULL,
        provisioning_error TEXT
      );
      CREATE TEMP TABLE environment_runtime (
        environment_id TEXT PRIMARY KEY,
        sandbox_id TEXT UNIQUE,
        desired_state TEXT NOT NULL,
        runtime_generation BIGINT NOT NULL DEFAULT 0,
        paused_at TIMESTAMPTZ,
        provisioning_error TEXT,
        lifecycle_policy_version INTEGER NOT NULL DEFAULT 0,
        agent_session_id TEXT,
        agent_attempt_id TEXT
      );
      CREATE TEMP TABLE environment_fork_operations (
        target_environment_id TEXT PRIMARY KEY,
        source_environment_id TEXT,
        source_snapshot_id TEXT,
        operation_id TEXT NOT NULL UNIQUE,
        sandbox_id TEXT UNIQUE,
        phase TEXT NOT NULL DEFAULT 'prepared',
        last_error TEXT
      );
      CREATE TEMP TABLE environment_workspace_backups (
        snapshot_id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL
      );
      INSERT INTO environments (
        id, created_by_user_id, name, description, color, status, revision,
        template_id, rootfs_snapshot_id, credential_revision, harness,
        harness_metadata, network_policy, sandbox_memory_mib,
        idle_pause_timeout_seconds, workspace_backup_interval_seconds,
        workspace_backup_retention_count, display_order
      ) VALUES (
        'env-source', 'user-one', 'Source', 'description', '#151515', 'ready', 3,
        'coding-agent', NULL, 2, 'claude-code',
        '{"label":"Claude Code","status":"connected","account":"secret@example.test"}',
        '{"mode":"allow-all","domainExceptions":[]}', 4096,
        900, 3600, 7, 0
      );
      INSERT INTO environment_runtime (
        environment_id, sandbox_id, desired_state, runtime_generation
      ) VALUES ('env-source', 'sandbox-source', 'running', 7);
      INSERT INTO environment_workspace_backups (snapshot_id, environment_id)
      VALUES ('snapshot-source', 'env-source');
    `);
    const store = new SandpiStore(database);

    assert.deepEqual(
      await store.createEnvironmentForkTarget({
        userId: "user-one",
        sourceEnvironmentId: "env-source",
        targetEnvironmentId: "env-target",
        name: "Target",
        operationId: "sandpi-environment-fork-env-target",
        sourceSnapshotId: "snapshot-source",
        environmentLimit: 5,
      }),
      {
        targetEnvironmentId: "env-target",
        sourceEnvironmentId: "env-source",
        sourceSnapshotId: "snapshot-source",
        operationId: "sandpi-environment-fork-env-target",
        phase: "prepared",
      },
    );
    await store.markEnvironmentForkStarted("env-target");
    await store.recordEnvironmentForkSandbox("env-target", "sandbox-target", 0);
    await store.completeEnvironmentFork("env-target");

    assert.deepEqual(await store.getEnvironmentForkOperation("env-target"), {
      targetEnvironmentId: "env-target",
      sourceEnvironmentId: "env-source",
      sourceSnapshotId: "snapshot-source",
      operationId: "sandpi-environment-fork-env-target",
      sandboxId: "sandbox-target",
      phase: "completed",
    });
    const target = await database.query<{
      status: string;
      harness: string;
      harness_metadata: Record<string, unknown>;
      desired_state: string;
    }>(
      `SELECT environment.status, environment.harness,
              environment.harness_metadata, runtime.desired_state
       FROM environments environment
       JOIN environment_runtime runtime ON runtime.environment_id = environment.id
       WHERE environment.id = 'env-target'`,
    );
    assert.deepEqual(target.rows[0], {
      status: "ready",
      harness: "claude-code",
      harness_metadata: { label: "Claude Code", status: "not-connected" },
      desired_state: "paused",
    });
  },
);
