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
