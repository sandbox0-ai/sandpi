import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { SandpiStore, type CodexControlTransition } from "./store";

interface QueryCall {
  sql: string;
  values?: unknown[];
}

function transactionalStore(
  responder: (sql: string, values?: unknown[]) => {
    rows?: unknown[];
    rowCount?: number;
  } = () => ({ rows: [], rowCount: 1 }),
) {
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0, ...responder(sql, values) };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0, ...responder(sql, values) };
    },
  } as unknown as Pool;
  return { store: new SandpiStore(pool), calls };
}

test("commits one shared decoder cursor and routes scalar turn state by native thread", async () => {
  const fixture = transactionalStore((sql) => ({
    rows: sql.includes("RETURNING environment_id")
      ? [{ environment_id: "environment-one" }]
      : [],
    rowCount: 1,
  }));
  const transitions: CodexControlTransition[] = [
    {
      type: "turnStarted",
      nativeSessionId: "thread-one",
      nativeTurnId: "turn-one",
      startedAt: new Date("2026-07-16T00:00:00.000Z"),
    },
    {
      type: "turnCompleted",
      nativeSessionId: "thread-two",
      nativeTurnId: "turn-two",
      status: "completed",
      completedAt: new Date("2026-07-16T00:01:00.000Z"),
    },
  ];

  assert.equal(
    await fixture.store.commitEnvironmentTransport(
      "environment-one",
      "supervisor-one",
      {
        supervisorCursor: 4,
        tailBase64: "before",
        attemptId: "attempt-one",
        runtimeGeneration: 1,
      },
      {
        supervisorCursor: 8,
        tailBase64: "after",
        attemptId: "attempt-one",
        runtimeGeneration: 1,
      },
      transitions,
    ),
    true,
  );

  const decoderUpdate = fixture.calls.find((call) =>
    call.sql.includes("UPDATE environment_runtime"),
  );
  assert.ok(decoderUpdate);
  assert.deepEqual(decoderUpdate.values?.slice(0, 3), [
    "environment-one",
    "supervisor-one",
    4,
  ]);
  const routedUpdates = fixture.calls.filter((call) =>
    call.sql.includes("UPDATE session_runtime runtime"),
  );
  assert.equal(routedUpdates.length, 2);
  for (const call of routedUpdates) {
    assert.match(call.sql, /session\.environment_id = \$1/);
    assert.match(call.sql, /runtime\.native_session_id = \$2/);
    assert.doesNotMatch(call.sql, /workspace|volume|snapshot/i);
  }
  assert.equal(
    fixture.calls.some((call) => call.sql.includes("session_turn_checkpoints")),
    false,
  );
  const idleDeadline = fixture.calls.find((call) =>
    call.sql.includes("last_turn_completed_at"),
  );
  assert.ok(idleDeadline);
  assert.deepEqual(idleDeadline.values, [
    "environment-one",
    new Date("2026-07-16T00:01:00.000Z"),
    180_000,
  ]);
});

test("switches edit/delete history with a native-thread CAS only", async () => {
  const fixture = transactionalStore((sql) => ({
    rows: sql.includes("RETURNING session_id") ? [{ session_id: "session-one" }] : [],
    rowCount: 1,
  }));

  assert.equal(
    await fixture.store.commitNativeBranch({
      sessionId: "session-one",
      expectedNativeSessionId: "thread-old",
      expectedHistoryRevision: 2,
      candidateNativeSessionId: "thread-new",
      candidateNativeTurnId: "turn-replacement",
      modelId: "gpt-test",
    }),
    true,
  );

  const switchQuery = fixture.calls.find((call) =>
    call.sql.includes("SET native_session_id = $4"),
  );
  assert.ok(switchQuery);
  assert.match(switchQuery.sql, /native_session_id = \$2/);
  assert.match(switchQuery.sql, /history_revision = \$3/);
  assert.doesNotMatch(switchQuery.sql, /sandbox|workspace|volume|snapshot/i);
  assert.deepEqual(switchQuery.values, [
    "session-one",
    "thread-old",
    2,
    "thread-new",
    "turn-replacement",
    "gpt-test",
  ]);
});

test("projects Sandbox and Supervisor coordinates from Environment runtime", async () => {
  const fixture = transactionalStore((sql) => {
    if (!sql.includes("FROM environment_runtime runtime")) {
      return { rows: [], rowCount: 0 };
    }
    return {
      rowCount: 1,
      rows: [
        {
          environment_id: "environment-one",
          workspace_volume_id: "volume-one",
          sandbox_id: "sandbox-one",
          supervisor_session_id: "supervisor-one",
          terminal_session_id: "terminal-one",
          supervisor_cursor: "12",
          stdout_tail: "tail",
          attempt_id: "attempt-one",
          runtime_generation: "3",
          desired_state: "running",
          observed_state: "running",
          provisioning_error: null,
          lifecycle_policy_version: "1",
          sandbox_hard_expires_at: new Date("2026-08-15T00:00:00.000Z"),
          last_turn_completed_at: new Date("2026-07-16T00:01:00.000Z"),
          idle_pause_due_at: new Date("2026-07-16T00:04:00.000Z"),
          lifecycle_error: null,
          paused_at: null,
          version: "5",
        },
      ],
    };
  });

  const runtime = await fixture.store.environmentRuntime("environment-one");
  assert.deepEqual(runtime, {
    id: "environment-one",
    sandboxId: "sandbox-one",
    workspaceVolumeId: "volume-one",
    supervisorSessionId: "supervisor-one",
    terminalSessionId: "terminal-one",
    attemptId: "attempt-one",
    runtimeGeneration: 3,
    decoder: {
      supervisorCursor: 12,
      tailBase64: "tail",
      attemptId: "attempt-one",
      runtimeGeneration: 3,
    },
    version: 5,
    desiredState: "running",
    observedState: "running",
    provisioningError: undefined,
    lifecyclePolicyVersion: 1,
    hardExpiresAt: new Date("2026-08-15T00:00:00.000Z"),
    lastTurnCompletedAt: new Date("2026-07-16T00:01:00.000Z"),
    idlePauseDueAt: new Date("2026-07-16T00:04:00.000Z"),
    lifecycleError: undefined,
    pausedAt: undefined,
  });
});

test("native thread lookup is namespaced by Environment", async () => {
  const fixture = transactionalStore((sql, values) => {
    assert.match(sql, /session\.environment_id = \$1/);
    assert.match(sql, /runtime\.native_session_id = \$2/);
    assert.deepEqual(values, ["environment-one", "thread-shared-name"]);
    return { rows: [{ session_id: "session-one" }], rowCount: 1 };
  });

  assert.equal(
    await fixture.store.sessionIdForNativeThread(
      "environment-one",
      "thread-shared-name",
    ),
    "session-one",
  );
});

test("idle pause is guarded by every pending or active Turn projection", async () => {
  const fixture = transactionalStore(() => ({ rows: [], rowCount: 0 }));

  assert.equal(
    await fixture.store.prepareEnvironmentIdlePause("environment-one"),
    undefined,
  );

  const update = fixture.calls.find((call) =>
    call.sql.includes("SET desired_state = 'paused'"),
  );
  assert.ok(update);
  assert.match(update.sql, /idle_pause_due_at <= NOW\(\)/);
  assert.match(update.sql, /session\.status IN \('provisioning', 'running'\)/);
  assert.match(update.sql, /active_native_turn_id IS NOT NULL/);
  assert.match(update.sql, /pending_turn_phase IS NOT NULL/);
});

test("Turn admission takes the Environment lifecycle lock before becoming pending", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id FROM sessions")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: true }], rowCount: 1 };
    }
    if (sql.includes("UPDATE session_runtime runtime")) {
      return { rows: [{ session_id: "session-one" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  Object.defineProperty(fixture.store, "getSession", {
    value: async () => ({ id: "session-one" }),
  });

  await fixture.store.beginSessionTurn(
    "user-one",
    "session-one",
    undefined,
    {
      requestId: "request-one",
      clientMessageId: "message-one",
      stableInputId: "input-one",
    },
  );

  const lockIndex = fixture.calls.findIndex((call) =>
    call.sql.includes("pg_try_advisory_xact_lock"),
  );
  const pendingIndex = fixture.calls.findIndex((call) =>
    call.sql.includes("pending_turn_phase = 'prepared'"),
  );
  assert.ok(lockIndex >= 0);
  assert.ok(pendingIndex > lockIndex);
  assert.equal(
    fixture.calls.some(
      (call) =>
        call.sql.includes("UPDATE environment_runtime") &&
        call.sql.includes("desired_state = 'running'"),
    ),
    true,
  );
});

test("Environment deletion marks the runtime terminated and retains cleanup coordinates", async () => {
  const fixture = transactionalStore(() => ({ rows: [], rowCount: 1 }));
  Object.defineProperty(fixture.store, "getEnvironment", {
    value: async () => ({
      id: "environment-one",
      status: "ready",
      sandboxId: "sandbox-one",
      workspaceVolumeId: "volume-one",
      rootfsSnapshotId: "snapshot-one",
    }),
  });

  assert.deepEqual(
    await fixture.store.prepareEnvironmentDeletion(
      "user-one",
      "environment-one",
    ),
    {
      sandboxId: "sandbox-one",
      workspaceVolumeId: "volume-one",
      rootfsSnapshotId: "snapshot-one",
    },
  );
  const transition = fixture.calls.find((call) =>
    call.sql.includes("desired_state = 'terminated'"),
  );
  assert.ok(transition);
  assert.match(transition.sql, /idle_pause_due_at = NULL/);
});

test("Environment metadata deletion removes Sessions and credential binding first", async () => {
  const fixture = transactionalStore((sql) => ({
    rows: sql.includes("SELECT environment.id")
      ? [{ id: "environment-one" }]
      : [],
    rowCount: 1,
  }));

  await fixture.store.deleteEnvironmentMetadata("user-one", "environment-one");

  const sessionDelete = fixture.calls.findIndex((call) =>
    call.sql.includes("DELETE FROM sessions"),
  );
  const bindingDelete = fixture.calls.findIndex((call) =>
    call.sql.includes("DELETE FROM environment_credential_bindings"),
  );
  const environmentDelete = fixture.calls.findIndex((call) =>
    call.sql.includes("DELETE FROM environments"),
  );
  assert.ok(sessionDelete >= 0);
  assert.ok(bindingDelete > sessionDelete);
  assert.ok(environmentDelete > bindingDelete);
  assert.equal(fixture.calls.at(-1)?.sql, "COMMIT");
});
