import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { migrateDatabase } from "@/server/db/migrate";
import { seedCommunityDefaults } from "@/server/db/seed";
import { SandpiStore } from "@/server/store";

test(
  "runtime config converges by generation without billing desired memory",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `sandpi_runtime_config_test_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-runtime-config-test-administration",
      max: 1,
    });
    await administration.query(`CREATE SCHEMA "${schema}"`);
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-runtime-config-postgres-test",
      options: `-c search_path=${schema}`,
      max: 4,
    });
    context.after(async () => {
      await database.end();
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.end();
    });
    await migrateDatabase(database);
    const seed = await seedCommunityDefaults(database, {
      admin: {
        id: "user-runtime-config-test",
        email: "runtime-config-test@sandpi.local",
        identitySubject: "runtime-config-test",
      },
      environment: {
        id: "environment-runtime-config-test",
        name: "Runtime config test",
      },
    });
    await database.query(
      `UPDATE environments
       SET status = 'ready', workspace_volume_id = 'volume-runtime-config',
           sandbox_memory_mib = 1024
       WHERE id = $1`,
      [seed.environment.id],
    );
    await database.query(
      `INSERT INTO environment_runtime (
         environment_id, sandbox_id, desired_state, observed_state,
         applied_runtime_config_generation, applied_sandbox_memory_mib
       ) VALUES ($1, 'sandbox-runtime-config', 'running', 'running', 1, 1024)`,
      [seed.environment.id],
    );
    const store = new SandpiStore(database, database);
    const input = {
      name: seed.environment.name,
      description: "",
      color: "#151515",
      idlePauseTimeoutSeconds: 900,
      sandboxMemoryMiB: 2_048,
      workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
      networkPolicy: {
        mode: "block-all" as const,
        domainExceptions: ["github.com"],
      },
    };

    const pending = await store.updateEnvironment(
      seed.admin.id,
      seed.environment.id,
      input,
    );
    assert.deepEqual(pending.runtimeConfig, {
      status: "applying",
      desiredGeneration: 2,
      appliedGeneration: 1,
      appliedSandboxMemoryMiB: 1_024,
    });
    assert.deepEqual(
      await store.environmentRuntimeConfigCandidateIds(),
      [seed.environment.id],
    );
    const prepared = await store.prepareEnvironmentRuntimeConfig(
      seed.environment.id,
    );
    assert.equal(prepared?.generation, 2);
    assert.equal(prepared?.sandboxMemoryMiB, 2_048);
    assert.deepEqual(prepared?.networkPolicy, input.networkPolicy);
    assert.equal(await openSegmentMemory(database), 1_024);

    assert.equal(
      await store.recordEnvironmentRuntimeConfigApplied(
        seed.environment.id,
        "sandbox-runtime-config",
        2,
        2_048,
      ),
      true,
    );
    assert.equal(
      (await store.getEnvironment(seed.admin.id, seed.environment.id))
        .runtimeConfig.status,
      "applied",
    );
    assert.equal(await openSegmentMemory(database), 2_048);

    await store.updateEnvironment(seed.admin.id, seed.environment.id, {
      ...input,
      sandboxMemoryMiB: 4_096,
    });
    await store.updateEnvironment(seed.admin.id, seed.environment.id, {
      ...input,
      sandboxMemoryMiB: 8_192,
    });
    assert.equal(
      await store.recordEnvironmentRuntimeConfigApplied(
        seed.environment.id,
        "sandbox-runtime-config",
        3,
        4_096,
      ),
      false,
    );
    const superseded = await store.getEnvironment(
      seed.admin.id,
      seed.environment.id,
    );
    assert.deepEqual(superseded.runtimeConfig, {
      status: "applying",
      desiredGeneration: 4,
      appliedGeneration: 2,
      appliedSandboxMemoryMiB: 4_096,
    });
    assert.equal(await openSegmentMemory(database), 4_096);

    assert.equal(
      await store.recordEnvironmentRuntimeConfigApplied(
        seed.environment.id,
        "sandbox-runtime-config",
        4,
        8_192,
      ),
      true,
    );
    assert.equal(await openSegmentMemory(database), 8_192);

    await store.updateEnvironment(seed.admin.id, seed.environment.id, {
      ...input,
      sandboxMemoryMiB: 8_192,
      networkPolicy: { mode: "allow-all", domainExceptions: [] },
    });
    assert.equal(
      await store.recordEnvironmentRuntimeConfigFailure(
        seed.environment.id,
        "sandbox-runtime-config",
        5,
        "Sandbox0 update timed out",
        new Date(Date.now() + 60_000),
      ),
      true,
    );
    const failed = await store.getEnvironment(
      seed.admin.id,
      seed.environment.id,
    );
    assert.equal(failed.runtimeConfig.status, "failed");
    assert.equal(
      failed.runtimeConfig.lastError,
      "Sandbox0 update timed out",
    );
    assert.deepEqual(await store.environmentRuntimeConfigCandidateIds(), []);
    assert.equal(await openSegmentMemory(database), 8_192);
  },
);

async function openSegmentMemory(database: Pool) {
  const result = await database.query<{ memory_mib: number }>(
    `SELECT memory_mib
     FROM sandbox_runtime_segments
     WHERE sandbox_id = 'sandbox-runtime-config'
       AND ended_at IS NULL`,
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0]?.memory_mib;
}
