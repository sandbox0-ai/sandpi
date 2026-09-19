import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { migrateDatabase } from "@/server/db/migrate";
import { seedCommunityDefaults } from "@/server/db/seed";
import { SandpiStore } from "@/server/store";

test(
  "native history authorization, launch CAS and old terminal fencing bind against PostgreSQL",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const schema = `native_sessions_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 5,
    });
    context.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    await migrateDatabase(pool);
    await seedCommunityDefaults(pool);
    await pool.query(
      "UPDATE environments SET status='ready' WHERE id='env-default'",
    );
    await pool.query(
      "INSERT INTO environment_runtime(environment_id,sandbox_id,runtime_generation,desired_state) VALUES ('env-default','test-sandbox',1,'running') ON CONFLICT(environment_id) DO UPDATE SET sandbox_id='test-sandbox',runtime_generation=1",
    );
    const store = new SandpiStore(pool);
    const session = {
      id: randomUUID(),
      title: "Native task",
      updatedAt: 1,
      resumePath: "/workspace/.sandpi/harnesses/codex/sessions/task.jsonl",
    };
    await store.saveNativeSessionIndex(
      "env-default",
      "codex",
      [session],
      false,
    );
    assert.deepEqual(
      (await store.getNativeSessionIndex("user-admin", "env-default")).sessions,
      [session],
    );
    await assert.rejects(
      store.getNativeSessionIndex("other-user", "env-default"),
    );
    const launch = randomUUID();
    await store.selectNativeSession("env-default", "", launch, session);
    assert.equal(
      (await store.environmentRuntime("env-default")).agentNativeSessionId,
      session.id,
    );
    await assert.rejects(
      store.selectNativeSession("env-default", "", randomUUID()),
      /selection changed/,
    );
    await assert.rejects(
      store.recordEnvironmentAgentSession(
        "env-default",
        "test-sandbox",
        {
          runtimeGeneration: 1,
          agentSessionId: "old-pty",
          agentAttemptId: "old-attempt",
        },
        "",
      ),
      /runtime changed/,
    );
    await store.recordEnvironmentAgentSession(
      "env-default",
      "test-sandbox",
      {
        runtimeGeneration: 1,
        agentSessionId: "pty",
        agentAttemptId: "attempt",
      },
      launch,
    );
    const coordinates = {
      runtimeGeneration: 1,
      agentSessionId: "pty",
      agentAttemptId: "attempt",
    };
    const lease = await store.acquireEnvironmentTerminalControl({
      userId: "user-admin",
      environmentId: "env-default",
      clientId: "device",
      coordinates,
    });
    assert.equal(lease.role, "controller");
    await store.selectNativeSession("env-default", launch, randomUUID());
    await assert.rejects(
      store.renewEnvironmentTerminalControl({
        userId: "user-admin",
        environmentId: "env-default",
        clientId: "device",
        coordinates,
      }),
    );
  },
);
