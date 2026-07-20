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
      "attempt-one",
      1,
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
  assert.match(decoderUpdate.sql, /decoder_attempt_id = \$8/);
  assert.match(decoderUpdate.sql, /decoder_runtime_generation = \$9/);
  assert.match(decoderUpdate.sql, /attempt_id IS NOT DISTINCT FROM \$3/);
  assert.match(decoderUpdate.sql, /runtime_generation = \$4/);
  assert.match(decoderUpdate.sql, /desired_state = 'running'/);
  assert.match(decoderUpdate.sql, /observed_state = 'running'/);
  assert.doesNotMatch(decoderUpdate.sql, /\bSET attempt_id =/);
  assert.doesNotMatch(decoderUpdate.sql, /\bSET runtime_generation =/);
  assert.deepEqual(decoderUpdate.values?.slice(0, 5), [
    "environment-one",
    "supervisor-one",
    "attempt-one",
    1,
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
    1_800_000,
  ]);
});

test("does not apply Session transitions after the Environment epoch CAS loses", async () => {
  const fixture = transactionalStore((sql) => ({
    rows: [],
    rowCount: sql.includes("UPDATE environment_runtime") ? 0 : 1,
  }));

  assert.equal(
    await fixture.store.commitEnvironmentTransport(
      "environment-one",
      "supervisor-one",
      "attempt-one",
      1,
      {
        supervisorCursor: 4,
        tailBase64: "",
        attemptId: "attempt-one",
        runtimeGeneration: 1,
      },
      {
        supervisorCursor: 5,
        tailBase64: "",
        attemptId: "attempt-one",
        runtimeGeneration: 1,
      },
      [
        {
          type: "turnStarted",
          nativeSessionId: "thread-one",
          nativeTurnId: "turn-one",
          startedAt: new Date("2026-07-16T00:00:00.000Z"),
        },
      ],
    ),
    false,
  );

  assert.equal(
    fixture.calls.some((call) => call.sql.includes("UPDATE session_runtime")),
    false,
  );
  assert.equal(
    fixture.calls.some((call) => call.sql === "ROLLBACK"),
    true,
  );
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
          decoder_attempt_id: "attempt-decoder",
          decoder_runtime_generation: "4",
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
      attemptId: "attempt-decoder",
      runtimeGeneration: 4,
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

test("records successful runtime access without promoting the Codex epoch", async () => {
  const fixture = transactionalStore((sql) => {
    if (!sql.includes("FROM environment_runtime runtime")) {
      return { rows: [], rowCount: 1 };
    }
    return {
      rowCount: 1,
      rows: [
        {
          environment_id: "environment-one",
          workspace_volume_id: "volume-one",
          sandbox_id: "sandbox-one",
          supervisor_session_id: "supervisor-one",
          terminal_session_id: null,
          supervisor_cursor: "0",
          stdout_tail: "",
          attempt_id: "attempt-one",
          runtime_generation: "3",
          decoder_attempt_id: "attempt-one",
          decoder_runtime_generation: "3",
          desired_state: "running",
          observed_state: "running",
          provisioning_error: null,
          lifecycle_policy_version: "1",
          lifecycle_error: null,
          version: "2",
        },
      ],
    };
  });

  await fixture.store.recordEnvironmentRuntimeAccess("environment-one");

  const update = fixture.calls.find((call) =>
    call.sql.includes("NOW() + ($2::BIGINT"),
  );
  assert.ok(update);
  assert.match(update.sql, /desired_state = 'running'/);
  assert.match(update.sql, /observed_state = 'running'/);
  assert.match(update.sql, /desired_state <> 'terminated'/);
  assert.doesNotMatch(update.sql, /attempt_id|runtime_generation/);
  assert.deepEqual(update.values, ["environment-one", 1_800_000]);
});

test("a live connection heartbeat extends only an already-running Environment", async () => {
  const fixture = transactionalStore(() => ({ rows: [], rowCount: 1 }));

  assert.equal(
    await fixture.store.touchRunningEnvironmentRuntime("environment-one"),
    true,
  );

  const update = fixture.calls.find((call) =>
    call.sql.includes("RETURNING environment_id"),
  );
  assert.ok(update);
  assert.match(update.sql, /desired_state = 'running'/);
  assert.match(update.sql, /observed_state = 'running'/);
  const setClause = update.sql.split("WHERE", 1)[0] ?? "";
  assert.doesNotMatch(
    setClause,
    /desired_state|observed_state|attempt_id|runtime_generation/,
  );
  assert.deepEqual(update.values, ["environment-one", 1_800_000]);
});

test("MCP mutations use a distinct Environment advisory-lock namespace", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("pg_try_advisory_lock")) {
      return { rows: [{ acquired: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  assert.deepEqual(
    await fixture.store.withEnvironmentMcpMutationLock(
      "environment-one",
      async () => "ready",
    ),
    { acquired: true, value: "ready" },
  );

  const lock = fixture.calls.find((call) =>
    call.sql.includes("pg_try_advisory_lock"),
  );
  const unlock = fixture.calls.find((call) =>
    call.sql.includes("pg_advisory_unlock"),
  );
  assert.deepEqual(lock?.values, [1_907_424_102, "environment-one"]);
  assert.deepEqual(unlock?.values, [1_907_424_102, "environment-one"]);
});

test("MCP OAuth credential sync uses one Environment advisory lock", async () => {
  const fixture = transactionalStore(() => ({ rows: [], rowCount: 1 }));

  assert.equal(
    await fixture.store.withEnvironmentMcpOAuthCredentialLock(
      "environment-one",
      async () => "ready",
    ),
    "ready",
  );

  const lock = fixture.calls.find(
    (call) =>
      call.sql.includes("pg_advisory_lock") &&
      !call.sql.includes("pg_try_advisory_lock"),
  );
  const unlock = fixture.calls.find((call) =>
    call.sql.includes("pg_advisory_unlock"),
  );
  assert.deepEqual(lock?.values, [1_907_424_103, "environment-one"]);
  assert.deepEqual(unlock?.values, [1_907_424_103, "environment-one"]);
});

test("runtime access uses the Environment lifecycle advisory key in shared mode", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("pg_try_advisory_lock_shared")) {
      return { rows: [{ acquired: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  assert.deepEqual(
    await fixture.store.withEnvironmentRuntimeAccessLock(
      "environment-one",
      async () => "ready",
    ),
    { acquired: true, value: "ready" },
  );

  const lock = fixture.calls.find((call) =>
    call.sql.includes("pg_try_advisory_lock_shared"),
  );
  const unlock = fixture.calls.find((call) =>
    call.sql.includes("pg_advisory_unlock_shared"),
  );
  assert.deepEqual(lock?.values, [1_907_424_101, "environment-one"]);
  assert.deepEqual(unlock?.values, [1_907_424_101, "environment-one"]);
});

test("a lock-scoped Store reuses the advisory-lock connection", async () => {
  let connectCalls = 0;
  let poolQueryCalls = 0;
  const client = {
    async query(sql: string) {
      if (sql.includes("pg_try_advisory_lock_shared")) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    async connect() {
      connectCalls += 1;
      return client;
    },
    async query() {
      poolQueryCalls += 1;
      throw new Error("lock callback requested another pool connection");
    },
  } as unknown as Pool;
  const store = new SandpiStore(pool);

  const result = await store.withEnvironmentRuntimeAccessLock(
    "environment-one",
    (lockedStore) =>
      lockedStore.touchRunningEnvironmentRuntime("environment-one"),
  );

  assert.deepEqual(result, { acquired: true, value: true });
  assert.equal(connectCalls, 1);
  assert.equal(poolQueryCalls, 0);
});

test("startup runtime recovery is limited to visible active Session control state", async () => {
  const fixture = transactionalStore(() => ({
    rows: [{ environment_id: "environment-one" }],
    rowCount: 1,
  }));

  assert.deepEqual(
    await fixture.store.environmentRuntimeRecoveryCandidateIds(),
    ["environment-one"],
  );
  const query = fixture.calls[0];
  assert.ok(query);
  assert.match(query.sql, /EXISTS \(/);
  assert.match(query.sql, /session\.archived = FALSE/);
  assert.match(query.sql, /pending_turn_phase IS NOT NULL/);
  assert.match(query.sql, /active_native_turn_id IS NOT NULL/);
});

test("grants a fresh idle window after Sandbox0 auto-resumes an Environment", async () => {
  const fixture = transactionalStore((sql) => {
    if (!sql.includes("UPDATE environment_runtime runtime")) {
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
          terminal_session_id: null,
          supervisor_cursor: "0",
          stdout_tail: "",
          attempt_id: "attempt-two",
          runtime_generation: "2",
          desired_state: "running",
          observed_state: "running",
          provisioning_error: null,
          lifecycle_policy_version: "2",
          sandbox_hard_expires_at: new Date("2026-08-15T00:00:00.000Z"),
          last_turn_completed_at: new Date("2026-07-16T00:01:00.000Z"),
          idle_pause_due_at: new Date("2026-07-16T00:07:00.000Z"),
          lifecycle_error: null,
          paused_at: null,
          version: "6",
        },
      ],
    };
  });

  await fixture.store.recordCodexEnvironmentRuntime("environment-one", {
    supervisorSessionId: "supervisor-one",
    attemptId: "attempt-two",
    runtimeGeneration: 2,
    sandboxRestarted: true,
  });

  const update = fixture.calls.find((call) =>
    call.sql.includes("idle_pause_due_at = CASE"),
  );
  assert.ok(update);
  assert.match(update.sql, /runtime\.observed_state <> 'running' OR \$5::BOOLEAN/);
  assert.match(update.sql, /GREATEST\(/);
  assert.deepEqual(update.values, [
    "environment-one",
    "supervisor-one",
    "attempt-two",
    2,
    true,
    1_800_000,
  ]);
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

test("native snapshot reconciliation uses a runtime-version compare-and-swap", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    return {
      rows: sql.includes("SELECT runtime.active_native_turn_id")
        ? [{ active_native_turn_id: "turn-old", pending_turn_phase: null }]
        : [],
      rowCount: 1,
    };
  });

  assert.equal(
    await fixture.store.reconcileNativeSessionState({
      sessionId: "session-one",
      nativeSessionId: "thread-one",
      historyRevision: 7,
      runtimeVersion: 11,
      environmentId: "environment-one",
      environmentSupervisorSessionId: "supervisor-one",
      environmentAttemptId: "attempt-one",
      environmentRuntimeGeneration: 3,
      activeNativeTurnId: undefined,
    }),
    true,
  );

  const runtimeRead = fixture.calls.find((call) =>
    call.sql.includes("SELECT runtime.active_native_turn_id"),
  );
  assert.ok(runtimeRead);
  assert.match(
    runtimeRead.sql,
    /runtime\.history_revision = \$3 AND runtime\.version = \$4/,
  );
  assert.match(runtimeRead.sql, /session\.environment_id = \$5/);
  assert.match(runtimeRead.sql, /FOR UPDATE OF runtime/);
  assert.deepEqual(runtimeRead.values, [
    "session-one",
    "thread-one",
    7,
    11,
    "environment-one",
  ]);
  const environmentRead = fixture.calls.find((call) =>
    call.sql.includes("FROM environment_runtime"),
  );
  assert.ok(environmentRead);
  assert.match(environmentRead.sql, /supervisor_session_id/);
  assert.match(environmentRead.sql, /attempt_id/);
  assert.match(environmentRead.sql, /runtime_generation = \$4/);
  assert.match(environmentRead.sql, /desired_state = 'running'/);
  assert.match(environmentRead.sql, /observed_state = 'running'/);
  assert.match(environmentRead.sql, /FOR SHARE/);
  assert.deepEqual(environmentRead.values, [
    "environment-one",
    "supervisor-one",
    "attempt-one",
    3,
  ]);

  const runtimeUpdate = fixture.calls.find((call) =>
    call.sql.includes("SET active_native_turn_id"),
  );
  assert.ok(runtimeUpdate);
  assert.deepEqual(runtimeUpdate.values, ["session-one", null]);
  const statusUpdate = fixture.calls.find((call) =>
    call.sql.includes("status IS DISTINCT FROM"),
  );
  assert.ok(statusUpdate);
  assert.deepEqual(statusUpdate.values, ["session-one", "waiting"]);
});

test("stale native snapshot reconciliation leaves Session state untouched", async () => {
  const fixture = transactionalStore(() => ({ rows: [], rowCount: 0 }));

  assert.equal(
    await fixture.store.reconcileNativeSessionState({
      sessionId: "session-one",
      nativeSessionId: "thread-one",
      historyRevision: 7,
      runtimeVersion: 10,
      environmentId: "environment-one",
      environmentSupervisorSessionId: "supervisor-one",
      environmentAttemptId: "attempt-one",
      environmentRuntimeGeneration: 3,
      activeNativeTurnId: "turn-stale",
    }),
    false,
  );
  assert.equal(
    fixture.calls.some((call) => call.sql.includes("UPDATE sessions")),
    false,
  );
  assert.equal(
    fixture.calls.some((call) => call.sql.includes("SET active_native_turn_id")),
    false,
  );
  assert.equal(
    fixture.calls.some((call) => call.sql === "ROLLBACK"),
    true,
  );
});

test("background native reconciliation clears an idle stale Turn admission", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("SELECT runtime.active_native_turn_id")) {
      return {
        rows: [
          {
            active_native_turn_id: null,
            pending_turn_request_id: "request-one",
            pending_turn_phase: "submitted",
            pending_turn_started_at: new Date("2026-07-15T00:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });

  assert.equal(
    await fixture.store.reconcileNativeSessionState({
      sessionId: "session-one",
      nativeSessionId: "thread-one",
      historyRevision: 7,
      runtimeVersion: 11,
      environmentId: "environment-one",
      environmentSupervisorSessionId: "supervisor-one",
      environmentAttemptId: "attempt-one",
      environmentRuntimeGeneration: 3,
      clearPendingWhenNativeIdle: true,
      clearPendingRequestId: "request-one",
      requireUnarchived: true,
    }),
    true,
  );

  const runtimeUpdate = fixture.calls.find(
    (call) =>
      call.sql.includes("UPDATE session_runtime") &&
      call.sql.includes("pending_turn_request_id = NULL"),
  );
  assert.ok(runtimeUpdate);
  assert.match(runtimeUpdate.sql, /pending_turn_client_message_id = NULL/);
  assert.match(runtimeUpdate.sql, /pending_turn_stable_input_id = NULL/);
  assert.match(runtimeUpdate.sql, /pending_turn_phase = NULL/);
  assert.match(runtimeUpdate.sql, /pending_turn_native_turn_id = NULL/);
  assert.match(runtimeUpdate.sql, /pending_turn_started_at = NULL/);
  assert.deepEqual(runtimeUpdate.values, ["session-one"]);
  const sessionLock = fixture.calls.find((call) =>
    call.sql.includes("SELECT id FROM sessions"),
  );
  assert.match(sessionLock?.sql ?? "", /archived = FALSE/);
  assert.equal(sessionLock?.values?.at(-1), true);
  const statusUpdate = fixture.calls.find((call) =>
    call.sql.includes("status IS DISTINCT FROM"),
  );
  assert.deepEqual(statusUpdate?.values, ["session-one", "waiting"]);
});

test("background native reconciliation preserves pending state for an active Turn", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("SELECT runtime.active_native_turn_id")) {
      return {
        rows: [
          {
            active_native_turn_id: null,
            pending_turn_request_id: "request-one",
            pending_turn_phase: "submitted",
            pending_turn_started_at: new Date("2026-07-15T00:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });

  assert.equal(
    await fixture.store.reconcileNativeSessionState({
      sessionId: "session-one",
      nativeSessionId: "thread-one",
      historyRevision: 7,
      runtimeVersion: 11,
      environmentId: "environment-one",
      environmentSupervisorSessionId: "supervisor-one",
      environmentAttemptId: "attempt-one",
      environmentRuntimeGeneration: 3,
      activeNativeTurnId: "turn-active",
      clearPendingWhenNativeIdle: true,
      clearPendingRequestId: "request-one",
    }),
    true,
  );

  assert.equal(
    fixture.calls.some(
      (call) =>
        call.sql.includes("UPDATE session_runtime") &&
        call.sql.includes("pending_turn_request_id = NULL"),
    ),
    false,
  );
  const activeUpdate = fixture.calls.find((call) =>
    call.sql.includes("SET active_native_turn_id = $2"),
  );
  assert.deepEqual(activeUpdate?.values, ["session-one", "turn-active"]);
  const statusUpdate = fixture.calls.find((call) =>
    call.sql.includes("status IS DISTINCT FROM"),
  );
  assert.deepEqual(statusUpdate?.values, ["session-one", "running"]);
});

test("background native reconciliation cannot clear a fresh pending Turn", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("SELECT runtime.active_native_turn_id")) {
      return {
        rows: [
          {
            active_native_turn_id: null,
            pending_turn_request_id: "request-fresh",
            pending_turn_phase: "prepared",
            pending_turn_started_at: new Date("2026-07-19T12:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });

  assert.equal(
    await fixture.store.reconcileNativeSessionState({
      sessionId: "session-one",
      nativeSessionId: "thread-one",
      historyRevision: 7,
      runtimeVersion: 11,
      environmentId: "environment-one",
      environmentSupervisorSessionId: "supervisor-one",
      environmentAttemptId: "attempt-one",
      environmentRuntimeGeneration: 3,
      clearPendingWhenNativeIdle: true,
      clearPendingStartedBefore: new Date("2026-07-19T11:50:00.000Z"),
      requireUnarchived: true,
    }),
    true,
  );

  assert.equal(
    fixture.calls.some(
      (call) =>
        call.sql.includes("UPDATE session_runtime") &&
        call.sql.includes("pending_turn_request_id = NULL"),
    ),
    false,
  );
  const statusUpdate = fixture.calls.find((call) =>
    call.sql.includes("status IS DISTINCT FROM"),
  );
  assert.deepEqual(statusUpdate?.values, ["session-one", "running"]);
});

test("background native reconciliation loses its CAS when the Session is archived", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("SELECT runtime.active_native_turn_id")) {
      return {
        rows: [
          {
            active_native_turn_id: null,
            pending_turn_request_id: "request-one",
            pending_turn_phase: "submitted",
            pending_turn_started_at: new Date("2026-07-15T00:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT id FROM sessions")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });

  assert.equal(
    await fixture.store.reconcileNativeSessionState({
      sessionId: "session-one",
      nativeSessionId: "thread-one",
      historyRevision: 7,
      runtimeVersion: 11,
      environmentId: "environment-one",
      environmentSupervisorSessionId: "supervisor-one",
      environmentAttemptId: "attempt-one",
      environmentRuntimeGeneration: 3,
      clearPendingWhenNativeIdle: true,
      clearPendingRequestId: "request-one",
      requireUnarchived: true,
    }),
    false,
  );

  const sessionLock = fixture.calls.find((call) =>
    call.sql.includes("SELECT id FROM sessions"),
  );
  assert.match(sessionLock?.sql ?? "", /archived = FALSE/);
  assert.equal(sessionLock?.values?.at(-1), true);
  assert.equal(
    fixture.calls.some((call) => call.sql.includes("UPDATE sessions")),
    false,
  );
});

test("exceptional native recovery candidates exclude archived and waiting Sessions", async () => {
  const fixture = transactionalStore(() => ({ rows: [], rowCount: 0 }));

  assert.deepEqual(
    await fixture.store.nativeSessionRecoveryCandidatesForEnvironment(
      "environment-one",
    ),
    [],
  );

  const query = fixture.calls.find((call) =>
    call.sql.includes("session.archived = FALSE"),
  );
  assert.ok(query);
  assert.match(query.sql, /session\.status <> 'failed'/);
  assert.match(query.sql, /runtime\.native_session_id IS NOT NULL/);
  assert.match(query.sql, /runtime\.active_native_turn_id IS NOT NULL/);
  assert.match(query.sql, /runtime\.pending_turn_phase IS NOT NULL/);
  assert.match(
    query.sql,
    /session\.status = 'running'[\s\S]*active_native_turn_id IS NULL[\s\S]*pending_turn_phase IS NULL/,
  );
  assert.deepEqual(query.values, ["environment-one"]);
});

test("idle pause is guarded only by visible pending or active Turn projections", async () => {
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
  assert.match(update.sql, /session\.archived = FALSE/);
  assert.match(update.sql, /session\.status IN \('provisioning', 'running'\)/);
  assert.match(update.sql, /active_native_turn_id IS NOT NULL/);
  assert.match(update.sql, /pending_turn_phase IS NOT NULL/);
});

test("archiving requires an idle Session projection", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id FROM sessions")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("FROM environment_runtime")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("FROM session_runtime")) {
      return {
        rows: [
          {
            active_native_turn_id: null,
            pending_turn_phase: "submitted",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT status FROM sessions")) {
      return { rows: [{ status: "running" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  Object.defineProperty(fixture.store, "getSession", {
    value: async () => ({ id: "session-one" }),
  });

  await assert.rejects(
    fixture.store.setSessionMetadata("user-one", "session-one", {
      archived: true,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "session_archive_in_progress",
  );

  const environmentLock = fixture.calls.findIndex((call) =>
    call.sql.includes("FROM environment_runtime"),
  );
  const runtimeLock = fixture.calls.findIndex((call) =>
    call.sql.includes("FROM session_runtime"),
  );
  const metadataLock = fixture.calls.findIndex((call) =>
    call.sql.includes("SELECT status FROM sessions"),
  );
  assert.ok(environmentLock >= 0);
  assert.ok(runtimeLock > environmentLock);
  assert.ok(metadataLock > runtimeLock);
  assert.match(fixture.calls[environmentLock]!.sql, /FOR SHARE/);
  assert.match(fixture.calls[runtimeLock]!.sql, /FOR UPDATE/);
  assert.match(fixture.calls[metadataLock]!.sql, /FOR UPDATE/);
  assert.equal(
    fixture.calls.some((call) => call.sql.includes("archived = TRUE")),
    false,
  );
});

test("archives an idle Session only after locking its control projection", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id FROM sessions")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("FROM environment_runtime")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("FROM session_runtime")) {
      return {
        rows: [
          {
            active_native_turn_id: null,
            pending_turn_phase: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT status FROM sessions")) {
      return { rows: [{ status: "waiting" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  Object.defineProperty(fixture.store, "getSession", {
    value: async () => ({ id: "session-one", archived: true }),
  });

  await fixture.store.setSessionMetadata("user-one", "session-one", {
    archived: true,
    unread: false,
  });

  const archive = fixture.calls.find((call) =>
    call.sql.includes("archived = TRUE"),
  );
  assert.ok(archive);
  assert.deepEqual(archive.values, [
    "session-one",
    null,
    null,
    false,
  ]);
  assert.equal(fixture.calls.at(-1)?.sql, "COMMIT");
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
    "high",
  );

  const lockIndex = fixture.calls.findIndex((call) =>
    call.sql.includes("pg_try_advisory_xact_lock"),
  );
  const environmentIndex = fixture.calls.findIndex(
    (call) =>
      call.sql.includes("UPDATE environment_runtime") &&
      call.sql.includes("desired_state = 'running'"),
  );
  const pendingIndex = fixture.calls.findIndex((call) =>
    call.sql.includes("pending_turn_phase = 'prepared'"),
  );
  const archivedCheckIndex = fixture.calls.findIndex((call) =>
    call.sql.includes("SELECT archived FROM sessions"),
  );
  assert.ok(lockIndex >= 0);
  assert.ok(environmentIndex > lockIndex);
  assert.ok(archivedCheckIndex > environmentIndex);
  assert.ok(pendingIndex > environmentIndex);
  assert.ok(pendingIndex > archivedCheckIndex);
  assert.match(fixture.calls[pendingIndex]!.sql, /session\.archived = FALSE/);
  assert.match(
    fixture.calls[pendingIndex]!.sql,
    /reasoning_effort = COALESCE\(\$3, reasoning_effort\)/,
  );
  assert.deepEqual(fixture.calls[pendingIndex]!.values, [
    "session-one",
    null,
    "high",
    "request-one",
    "message-one",
    "input-one",
  ]);
  assert.equal(
    fixture.calls.some(
      (call) =>
        call.sql.includes("UPDATE environment_runtime") &&
        call.sql.includes("desired_state = 'running'"),
    ),
    true,
  );
});

test("Turn admission rejects an archived Session before becoming pending", async () => {
  const fixture = transactionalStore((sql) => {
    if (sql.includes("SELECT environment_id FROM sessions")) {
      return { rows: [{ environment_id: "environment-one" }], rowCount: 1 };
    }
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: true }], rowCount: 1 };
    }
    if (sql.includes("SELECT archived FROM sessions")) {
      return { rows: [{ archived: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  Object.defineProperty(fixture.store, "getSession", {
    value: async () => ({ id: "session-one", archived: true }),
  });

  await assert.rejects(
    fixture.store.beginSessionTurn(
      "user-one",
      "session-one",
      undefined,
      {
        requestId: "request-one",
        clientMessageId: "message-one",
        stableInputId: "input-one",
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "session_archived",
  );
  assert.equal(
    fixture.calls.some((call) =>
      call.sql.includes("pending_turn_phase = 'prepared'"),
    ),
    false,
  );
  assert.equal(fixture.calls.at(-1)?.sql, "ROLLBACK");
});

test("abandoning an obsolete Turn request does not overwrite Session status", async () => {
  const fixture = transactionalStore((sql) => ({
    rows: [],
    rowCount: sql.includes("UPDATE session_runtime") ? 0 : 1,
  }));

  await fixture.store.abandonTurn("session-one", "request-obsolete");

  assert.equal(
    fixture.calls.some((call) => call.sql.includes("UPDATE sessions")),
    false,
  );
  const runtimeUpdate = fixture.calls.find((call) =>
    call.sql.includes("UPDATE session_runtime"),
  );
  assert.ok(runtimeUpdate);
  assert.match(runtimeUpdate.sql, /RETURNING session_id/);
  assert.deepEqual(runtimeUpdate.values, [
    "session-one",
    "request-obsolete",
  ]);
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
