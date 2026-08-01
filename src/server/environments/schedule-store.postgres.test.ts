import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { migrateDatabase } from "@/server/db/migrate";
import { seedCommunityDefaults } from "@/server/db/seed";
import { SandpiStore } from "@/server/store";
import { EnvironmentScheduleStore } from "./schedule-store";

test(
  "claims each occurrence once, skips overlap, and fences stale workers",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const store = new EnvironmentScheduleStore(database);
    const due = new Date(Date.now() - 60_000);
    const next = new Date(Date.now() + 60_000);
    const schedule = await store.create({
      id: "schedule-concurrency",
      userId: "user-schedule-test",
      environmentId: "environment-schedule-test",
      name: "Concurrent schedule",
      prompt: "Original immutable prompt",
      timing: {
        kind: "cron",
        expression: "* * * * *",
        timeZone: "UTC",
      },
      target: { kind: "newSession" },
      enabled: true,
      nextRunAt: due,
    });
    const claims = await Promise.all([
      store.claimOccurrence({
        schedule,
        scheduledFor: due,
        nextRunAt: next,
        runId: "run-first",
        sessionId: "session-first",
        submission: {
          requestId: "request-first",
          clientMessageId: "message-first",
          stableInputId: "input-first",
        },
        leaseToken: "lease-initial",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
      store.claimOccurrence({
        schedule,
        scheduledFor: due,
        nextRunAt: next,
        runId: "run-racing",
        sessionId: "session-racing",
        submission: {
          requestId: "request-racing",
          clientMessageId: "message-racing",
          stableInputId: "input-racing",
        },
        leaseToken: "lease-racing",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ]);
    assert.deepEqual(
      claims.map((claim) => claim.kind).sort(),
      ["claimed", "stale"],
    );

    assert.equal(
      await store.markRunRunning({
        runId: "run-first",
        leaseToken: "lease-initial",
        nativeTurnId: "turn-first",
        retryAt: new Date(Date.now() - 1),
      }),
      true,
    );
    const [leaseOne, leaseTwo] = await Promise.all([
      store.claimRunLease(
        "run-first",
        "lease-worker-one",
        new Date(Date.now() + 60_000),
        new Date(),
      ),
      store.claimRunLease(
        "run-first",
        "lease-worker-two",
        new Date(Date.now() + 60_000),
        new Date(),
      ),
    ]);
    const winner = leaseOne ?? leaseTwo;
    assert.ok(winner);
    assert.equal(Number(Boolean(leaseOne)) + Number(Boolean(leaseTwo)), 1);

    const current = await store.get(
      "user-schedule-test",
      "environment-schedule-test",
      "schedule-concurrency",
    );
    const skippedAt = current.nextRunAt;
    assert.ok(skippedAt);
    const skipped = await store.claimOccurrence({
      schedule: current,
      scheduledFor: skippedAt,
      nextRunAt: new Date(skippedAt.getTime() + 60_000),
      runId: "run-skipped",
      sessionId: "session-must-not-be-used",
      submission: {
        requestId: "request-skipped",
        clientMessageId: "message-skipped",
        stableInputId: "input-skipped",
      },
      leaseToken: "lease-skipped",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(skipped.kind, "skipped");
    if (skipped.kind === "skipped") {
      assert.equal(skipped.run.sessionId, undefined);
      assert.equal(
        skipped.run.error,
        "The previous Schedule run is still active.",
      );
    }

    assert.equal(
      await store.finishRun({
        runId: "run-first",
        leaseToken: "lease-initial",
        status: "succeeded",
      }),
      false,
      "a stale lease must not finish a run",
    );
    assert.equal(
      await store.finishRun({
        runId: "run-first",
        leaseToken: winner.run.leaseToken!,
        status: "succeeded",
        nativeTurnId: "turn-first",
      }),
      true,
    );

    const latest = await store.get(
      "user-schedule-test",
      "environment-schedule-test",
      "schedule-concurrency",
    );
    assert.equal(
      latest.lastRunStatus,
      "skipped",
      "finishing an older run must not overwrite a newer occurrence",
    );
    const runs = await store.listRuns(
      "user-schedule-test",
      "environment-schedule-test",
      "schedule-concurrency",
    );
    assert.deepEqual(
      runs.map((run) => run.status).sort(),
      ["skipped", "succeeded"],
    );
    const snapshot = await database.query<{ prompt: string }>(
      "SELECT prompt FROM environment_schedule_runs WHERE id = $1",
      ["run-first"],
    );
    assert.equal(
      snapshot.rows[0]?.prompt,
      "Original immutable prompt",
    );
  },
);

test(
  "disables Schedules when their fixed target Sessions are archived or deleted",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = await isolatedDatabase(context);
    const sandpi = new SandpiStore(database);
    const schedules = new EnvironmentScheduleStore(database);
    const environment = await sandpi.getEnvironment(
      "user-schedule-test",
      "environment-schedule-test",
    );
    await sandpi.ensureAutomationSessionMetadata({
      sessionId: "session-fixed-target",
      automationRunId: "run-reserved",
      automationKind: "schedule",
      userId: "user-schedule-test",
      environment,
      title: "Fixed target",
    });
    const schedule = await schedules.create({
      id: "schedule-fixed-target",
      userId: "user-schedule-test",
      environmentId: environment.id,
      name: "Fixed Session",
      prompt: "Continue this Session",
      timing: {
        kind: "once",
        runAt: new Date(Date.now() + 60_000),
      },
      target: {
        kind: "session",
        sessionId: "session-fixed-target",
      },
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000),
    });

    await database.query("DELETE FROM sessions WHERE id = $1", [
      "session-fixed-target",
    ]);
    const disabled = await schedules.get(
      "user-schedule-test",
      environment.id,
      schedule.id,
    );
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, undefined);
    assert.equal(disabled.lastError, "The target Session was deleted.");
    assert.equal(disabled.revision, schedule.revision + 1);

    await sandpi.ensureAutomationSessionMetadata({
      sessionId: "session-archived-target",
      automationRunId: "run-reserved-archive",
      automationKind: "schedule",
      userId: "user-schedule-test",
      environment,
      title: "Archived target",
    });
    const archiveSchedule = await schedules.create({
      id: "schedule-archived-target",
      userId: "user-schedule-test",
      environmentId: environment.id,
      name: "Archived Session",
      prompt: "Continue this Session",
      timing: {
        kind: "once",
        runAt: new Date(Date.now() + 60_000),
      },
      target: {
        kind: "session",
        sessionId: "session-archived-target",
      },
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000),
    });
    await database.query(
      "UPDATE sessions SET archived = TRUE WHERE id = $1",
      ["session-archived-target"],
    );
    const archiveDisabled = await schedules.get(
      "user-schedule-test",
      environment.id,
      archiveSchedule.id,
    );
    assert.equal(archiveDisabled.enabled, false);
    assert.equal(archiveDisabled.nextRunAt, undefined);
    assert.equal(
      archiveDisabled.lastError,
      "The target Session was archived.",
    );
    assert.equal(archiveDisabled.revision, archiveSchedule.revision + 1);
  },
);

async function isolatedDatabase(
  context: test.TestContext,
): Promise<Pool> {
  const schema = `sandpi_schedule_test_${randomUUID().replaceAll("-", "")}`;
  const administration = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "sandpi-schedule-test-administration",
    max: 1,
  });
  await administration.query(`CREATE SCHEMA "${schema}"`);
  const database = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "sandpi-schedule-postgres-test",
    options: `-c search_path=${schema}`,
    max: 4,
  });
  context.after(async () => {
    await database.end();
    await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
    await administration.end();
  });
  await migrateDatabase(database);
  await seedCommunityDefaults(database, {
    admin: {
      id: "user-schedule-test",
      email: "schedule-test@sandpi.local",
      identitySubject: "schedule-test",
    },
    environment: {
      id: "environment-schedule-test",
      name: "Schedule test",
    },
  });
  return database;
}
