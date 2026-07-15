import assert from "node:assert/strict";
import test from "node:test";

import type { Pool, QueryResult } from "pg";

import { SandpiStore } from "./store";

test("keeps an established failed Session until its hard TTL", async () => {
  let cleanupQuery = "";
  const store = new SandpiStore({
    async query<Row>(sql: string) {
      cleanupQuery = sql.replace(/\s+/g, " ").trim();
      return { rows: [], rowCount: 0 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
  } as unknown as Pool);

  await store.failedRuntimeSessions();

  assert.match(
    cleanupQuery,
    /s\.status = 'failed' AND r\.runtime_error_code = 'session_failed'/,
  );
  assert.match(
    cleanupQuery,
    /s\.status = 'provisioning' AND s\.updated_at < NOW\(\) - INTERVAL '10 minutes'/,
  );
  assert.doesNotMatch(
    cleanupQuery,
    /sandbox_id IS NOT NULL OR r\.workspace_volume_id IS NOT NULL/,
  );
});

test("claims failed provisioning before exposing its latest cleanup coordinates", async () => {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query<Row>(sql: string, params?: unknown[]) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push({ sql: normalized, params });
      if (normalized.includes("UPDATE session_runtime runtime") &&
          normalized.includes("RETURNING runtime.session_id")) {
        return {
          rows: [{
            session_id: "session-test",
            sandbox_id: "sandbox-late",
            workspace_volume_id: "volume-late",
            supervisor_session_id: "supervisor-late",
          }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  assert.deepEqual(await store.claimFailedRuntimeSession("session-test"), {
    id: "session-test",
    sandboxId: "sandbox-late",
    workspaceVolumeId: "volume-late",
    supervisorSessionId: "supervisor-late",
  });
  const claim = statements.find(({ sql }) =>
    sql.includes("UPDATE session_runtime runtime"),
  );
  assert.ok(claim);
  assert.match(claim.sql, /SET desired_state = 'terminated'/);
  assert.match(claim.sql, /runtime\.resources_deleted_at IS NULL/);
  assert.match(claim.sql, /FOR UPDATE OF session, runtime/);
  assert.deepEqual(claim.params, ["session-test"]);
});

test("releases only the expected Turn mutation phase", async () => {
  let releaseSql = "";
  let releaseParams: unknown[] | undefined;
  const client = {
    async query<Row>(sql: string, params?: unknown[]) {
      if (sql.includes("DELETE FROM session_turn_mutations")) {
        releaseSql = sql.replace(/\s+/g, " ").trim();
        releaseParams = params;
        return {
          rows: [{ id: "mutation-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  await store.releasePreparedTurnMutation("session-test", "mutation-test", {
    clearPendingInput: true,
    expectedPhase: "compensating",
  });

  assert.match(releaseSql, /id = \$2 AND phase = \$3/);
  assert.deepEqual(releaseParams, [
    "session-test",
    "mutation-test",
    "compensating",
  ]);
});

test("delays cross-replica mutation takeover beyond the Volume restore window", async () => {
  let recoveryQuery = "";
  const store = new SandpiStore({
    async query<Row>(sql: string) {
      recoveryQuery = sql.replace(/\s+/g, " ").trim();
      return { rows: [], rowCount: 0 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
  } as unknown as Pool);

  await store.interruptedTurnMutations();

  assert.match(
    recoveryQuery,
    /mutation\.updated_at < NOW\(\) - INTERVAL '10 minutes'/,
  );
  assert.match(recoveryQuery, /mutation\.phase = 'prepared' OR/);
});

test("drops a stale Supervisor page after the journal epoch was replaced", async () => {
  const statements: string[] = [];
  const client = {
    async query<Row>(sql: string): Promise<QueryResult<Row & Record<string, unknown>>> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT supervisor_session_id, supervisor_cursor")) {
        return {
          rows: [
            {
              supervisor_session_id: "supervisor-new",
              supervisor_cursor: 6,
              stdout_tail: "",
              attempt_id: "attempt-old",
              runtime_generation: 1,
              active_native_turn_id: null,
            },
          ],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: null } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  const committed = await store.commitCodexTransport(
    "session-test",
    "supervisor-old",
    {
      supervisorCursor: 6,
      tailBase64: "",
      attemptId: "attempt-old",
      runtimeGeneration: 1,
    },
    {
      supervisorCursor: 7,
      tailBase64: "stale",
      attemptId: "attempt-old",
      runtimeGeneration: 1,
    },
    [],
  );

  assert.equal(committed, false);
  assert.equal(
    statements.some((statement) => statement.includes("SET supervisor_cursor")),
    false,
  );
  assert.equal(statements.at(-1), "COMMIT");
});

test("drops an old attempt page after same-Supervisor recovery", async () => {
  const statements: string[] = [];
  const client = {
    async query<Row>(sql: string): Promise<QueryResult<Row & Record<string, unknown>>> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT supervisor_session_id, supervisor_cursor")) {
        return {
          rows: [{
            supervisor_session_id: "supervisor-same",
            supervisor_cursor: 0,
            stdout_tail: "",
            attempt_id: "attempt-new",
            runtime_generation: 2,
            active_native_turn_id: null,
          }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: null } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  const persisted = await store.commitCodexTransport(
    "session-test",
    "supervisor-same",
    {
      supervisorCursor: 19,
      tailBase64: "partial-old-json",
      attemptId: "attempt-old",
      runtimeGeneration: 1,
    },
    {
      supervisorCursor: 20,
      tailBase64: "",
      attemptId: "attempt-old",
      runtimeGeneration: 1,
    },
    [],
  );

  assert.equal(persisted, false);
  assert.equal(
    statements.some((statement) => statement.includes("UPDATE session_runtime")),
    false,
  );
  assert.equal(statements.at(-1), "COMMIT");
});

test("commits a completed native Turn as a checkpoint obligation without history", async () => {
  const statements: string[] = [];
  const client = {
    async query<Row>(sql: string): Promise<QueryResult<Row & Record<string, unknown>>> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT supervisor_session_id, supervisor_cursor")) {
        return {
          rows: [
            {
              supervisor_session_id: "supervisor-one",
              supervisor_cursor: 4,
              stdout_tail: "",
              attempt_id: "attempt-one",
              runtime_generation: 1,
              native_session_id: "thread-one",
              active_native_turn_id: "turn-one",
            },
          ],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  const committed = await store.commitCodexTransport(
    "session-test",
    "supervisor-one",
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
        type: "turnCompleted",
        nativeSessionId: "thread-one",
        nativeTurnId: "turn-one",
        status: "completed",
        supervisorSequence: 5,
      },
    ],
  );

  assert.equal(committed, true);
  assert.equal(
    statements.some((statement) =>
      statement.includes("INSERT INTO session_turn_checkpoints"),
    ),
    true,
  );
  assert.equal(
    statements.some((statement) => statement.includes("harness_events")),
    false,
  );
});

test("advances transport but journals same-Session candidate control until commit", async () => {
  let runtimeUpdateParams: unknown[] | undefined;
  let mutationUpdateParams: unknown[] | undefined;
  const statements: string[] = [];
  const client = {
    async query<Row>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Row & Record<string, unknown>>> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT supervisor_session_id, supervisor_cursor")) {
        return {
          rows: [{
            supervisor_session_id: "supervisor-one",
            supervisor_cursor: 8,
            stdout_tail: "",
            attempt_id: "attempt-one",
            runtime_generation: 1,
            native_session_id: "thread-original",
            active_native_turn_id: null,
          }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("SELECT id, kind, phase, result_native_session_id")) {
        return {
          rows: [{
            id: "mutation-one",
            kind: "edit",
            phase: "replacement_started",
            result_native_session_id: "thread-original",
            replacement_native_turn_id: "turn-candidate",
          }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("UPDATE session_turn_mutations")) {
        mutationUpdateParams = params;
        return { rows: [{ id: "mutation-one" }], rowCount: 1 } as unknown as
          QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("UPDATE session_runtime")) runtimeUpdateParams = params;
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  assert.equal(
    await store.commitCodexTransport(
      "session-test",
      "supervisor-one",
      {
        supervisorCursor: 8,
        tailBase64: "",
        attemptId: "attempt-one",
        runtimeGeneration: 1,
      },
      {
        supervisorCursor: 9,
        tailBase64: "",
        attemptId: "attempt-one",
        runtimeGeneration: 1,
      },
      [
        {
          type: "turnStarted",
          nativeSessionId: "thread-original",
          nativeTurnId: "turn-candidate",
          startedAt: new Date("2026-07-15T00:00:00Z"),
          supervisorSequence: 9,
        },
        {
          type: "turnCompleted",
          nativeSessionId: "thread-original",
          nativeTurnId: "turn-candidate",
          status: "completed",
          supervisorSequence: 10,
        },
      ],
    ),
    true,
  );

  assert.ok(runtimeUpdateParams);
  assert.deepEqual(mutationUpdateParams, [
    "mutation-one",
    "session-test",
    "turn-candidate",
    "completed",
    "supervisor-one",
    10,
  ]);
  assert.equal(runtimeUpdateParams[5], null);
  assert.equal(runtimeUpdateParams[6], null);
  assert.equal(
    statements.some((statement) =>
      statement.startsWith("UPDATE sessions SET status = 'running'"),
    ),
    false,
  );
});

test("prepares mutation only from an exact same-Volume native input snapshot", async () => {
  const statements: string[] = [];
  let mutationParams: unknown[] | undefined;
  const client = {
    async query<Row>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Row & Record<string, unknown>>> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT checkpoint.ordinal")) {
        return {
          rows: [{
            ordinal: 2,
            native_turn_id: "turn-two",
            input_native_head_turn_id: "turn-one",
            input_workspace_snapshot_id: "snapshot-input-two",
            native_session_id: "thread-one",
            workspace_volume_id: "volume-one",
            history_revision: 9,
            head_volume_snapshot_id: "snapshot-head",
          }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("UPDATE sessions") && sql.includes("RETURNING id")) {
        return {
          rows: [{ id: "session-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("INSERT INTO session_turn_mutations")) {
        mutationParams = params;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);
  Object.assign(store as object, {
    async getSession() {
      return { status: "waiting" };
    },
  });

  const prepared = await store.prepareTurnMutation(
    "user-test",
    "session-test",
    "turn-two",
    "edit",
  );
  assert.match(prepared.mutationId, /^mutation_/);
  assert.deepEqual(
    { ...prepared, mutationId: "mutation-test" },
    {
      mutationId: "mutation-test",
      selectedTurnId: "turn-two",
      selectedOrdinal: 2,
      inputNativeHeadTurnId: "turn-one",
      nativeSessionId: "thread-one",
      workspaceVolumeId: "volume-one",
      expectedHistoryRevision: 9,
      restoreSnapshotId: "snapshot-input-two",
      headSnapshotId: "snapshot-head",
    },
  );
  assert.equal(
    statements.some((statement) =>
      statement.includes("checkpoint.includes_native_state") &&
      statement.includes("input_workspace_snapshot_id IS NOT NULL") &&
      statement.includes("previous.native_head_turn_id"),
    ),
    true,
  );
  assert.match(String(mutationParams?.[0]), /^mutation_/);
  assert.deepEqual(mutationParams?.slice(1), [
    "session-test",
    "edit",
    "turn-two",
    2,
    "thread-one",
    "snapshot-input-two",
    "snapshot-head",
    "volume-one",
    9,
  ]);
});

test("atomically commits a same-Session history restore and terminal obligation", async () => {
  let runtimeUpdate = "";
  let runtimeUpdateParams: unknown[] | undefined;
  let insertedCheckpoint = false;
  const client = {
    async query<Row>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Row & Record<string, unknown>>> {
      if (sql.includes("SELECT kind, phase, original_native_session_id")) {
        return {
          rows: [{
            kind: "edit",
            phase: "replacement_started",
            original_native_session_id: "thread-original",
            result_native_session_id: "thread-original",
            workspace_volume_id: "volume-one",
            expected_history_revision: 7,
            restore_workspace_snapshot_id: "snapshot-input",
            head_workspace_snapshot_id: "snapshot-head",
            replacement_native_turn_id: "turn-replacement",
            candidate_terminal_status: "completed",
            candidate_supervisor_session_id: "supervisor-one",
            candidate_supervisor_sequence: 44,
          }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("UPDATE session_turn_checkpoints")) {
        return {
          rows: [{
            workspace_snapshot_id: "snapshot-head",
            input_workspace_snapshot_id: "snapshot-input",
          }],
          rowCount: 1,
        } as unknown as QueryResult<
          Row & Record<string, unknown>
        >;
      }
      if (sql.includes("INSERT INTO session_turn_checkpoints")) {
        insertedCheckpoint = true;
      }
      if (sql.includes("UPDATE session_runtime")) {
        runtimeUpdate = sql.replace(/\s+/g, " ").trim();
        runtimeUpdateParams = params;
        return {
          rows: [{ pending_turn_input_snapshot_id: "snapshot-input" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  assert.deepEqual(
    await store.finalizeTurnMutation(
      "session-test",
      {
        mutationId: "mutation-test",
        selectedTurnId: "turn-old",
        selectedOrdinal: 2,
        nativeSessionId: "thread-original",
        workspaceVolumeId: "volume-one",
        expectedHistoryRevision: 7,
        restoreSnapshotId: "snapshot-input",
        headSnapshotId: "snapshot-head",
      },
      "running",
      "gpt-test",
      {
        nativeTurnId: "turn-replacement",
      },
    ),
    ["snapshot-head"],
  );
  assert.equal(insertedCheckpoint, true);
  assert.match(runtimeUpdate, /native_session_id = \$3/);
  assert.match(
    runtimeUpdate,
    /history_revision = history_revision \+ 1/,
  );
  assert.match(runtimeUpdate, /head_volume_snapshot_id = \$8/);
  assert.deepEqual(runtimeUpdateParams, [
    "session-test",
    "gpt-test",
    "thread-original",
    "turn-replacement",
    "thread-original",
    "volume-one",
    7,
    "snapshot-input",
    true,
    null,
  ]);
});

test("advances the runtime head when a Volume checkpoint becomes ready", async () => {
  let headUpdate = "";
  let headUpdateParams: unknown[] | undefined;
  const client = {
    async query<Row>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Row & Record<string, unknown>>> {
      if (sql.includes("SELECT session_id FROM session_turn_checkpoints")) {
        return {
          rows: [{ session_id: "session-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("UPDATE session_turn_checkpoints checkpoint")) {
        return {
          rows: [{ pending_turn_input_snapshot_id: null }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("SET head_volume_snapshot_id")) {
        headUpdate = sql.replace(/\s+/g, " ").trim();
        headUpdateParams = params;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  await store.completeTurnCheckpoint("checkpoint-one", "snapshot-new-head");

  assert.match(headUpdate, /head_volume_snapshot_id = \$2/);
  assert.deepEqual(headUpdateParams, [
    "session-test",
    "snapshot-new-head",
    "checkpoint-one",
  ]);
});

test("serializes a Volume checkpoint COMMIT read-back with its original transaction", async () => {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  let releaseCommitLock: (() => void) | undefined;
  const commitLock = new Promise<void>((resolve) => {
    releaseCommitLock = resolve;
  });
  let checkpointRead = false;
  const client = {
    async query<Row>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Row & Record<string, unknown>>> {
      const normalized = sql.replace(/\s+/g, " ").trim();
      statements.push({ sql: normalized, params });
      if (normalized.includes("SELECT session_id FROM session_turn_checkpoints")) {
        return {
          rows: [{ session_id: "session-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (normalized.includes("pg_advisory_xact_lock")) {
        await commitLock;
      }
      if (normalized.includes("SELECT status, workspace_snapshot_id")) {
        checkpointRead = true;
        return {
          rows: [{ status: "ready", workspace_snapshot_id: "snapshot-new-head" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  const reconciliation = store.reconcileTurnCheckpointCommit(
    "checkpoint-one",
    "snapshot-new-head",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checkpointRead, false);
  releaseCommitLock?.();
  assert.equal(
    await reconciliation,
    true,
  );
  assert.equal(checkpointRead, true);
  const lockIndex = statements.findIndex(({ sql }) =>
    sql.includes("pg_advisory_xact_lock"),
  );
  const readIndex = statements.findIndex(({ sql }) =>
    sql.includes("SELECT status, workspace_snapshot_id"),
  );
  assert.ok(lockIndex >= 0);
  assert.ok(readIndex > lockIndex);
});

test("rejects an old native Session checkpoint after runtime canonicalization", async () => {
  let completionSql = "";
  let runtimeHeadUpdated = false;
  const client = {
    async query<Row>(
      sql: string,
    ): Promise<QueryResult<Row & Record<string, unknown>>> {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("SELECT session_id FROM session_turn_checkpoints")) {
        return {
          rows: [{ session_id: "session-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (normalized.includes("SELECT status, workspace_snapshot_id")) {
        return {
          rows: [{ status: "creating", workspace_snapshot_id: null }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (normalized.includes("UPDATE session_turn_checkpoints checkpoint")) {
        completionSql = normalized;
        // PostgreSQL returns no row when runtime.native_session_id no longer
        // matches the checkpoint's native Session.
        return {
          rows: [],
          rowCount: 0,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (normalized.includes("SET head_volume_snapshot_id")) {
        runtimeHeadUpdated = true;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  assert.equal(
    await store.reconcileTurnCheckpointCommit(
      "checkpoint-old-thread",
      "snapshot-old-thread",
    ),
    false,
  );
  assert.match(
    completionSql,
    /runtime\.native_session_id = checkpoint\.native_session_id/,
  );
  assert.equal(runtimeHeadUpdated, false);
});

test("commits a v2 native-state baseline and retires legacy checkpoints", async () => {
  let baselineInsert = "";
  let runtimeUpdate = "";
  const client = {
    async query<Row>(sql: string): Promise<QueryResult<Row & Record<string, unknown>>> {
      if (sql.includes("SELECT session_id FROM session_runtime")) {
        return {
          rows: [{ session_id: "session-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("UPDATE session_turn_checkpoints")) {
        return {
          rows: [
            {
              workspace_snapshot_id: "snapshot-old-output",
              input_workspace_snapshot_id: "snapshot-old-input",
            },
          ],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      if (sql.includes("INSERT INTO session_turn_checkpoints")) {
        baselineInsert = sql.replace(/\s+/g, " ").trim();
      }
      if (sql.includes("SET harness_state_layout = 'workspace_v2'")) {
        runtimeUpdate = sql.replace(/\s+/g, " ").trim();
        return {
          rows: [{ session_id: "session-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  assert.deepEqual(
    await store.completeNativeStateMigration("session-test", "operation-one", {
      nativeSessionId: "thread-one",
      workspaceVolumeId: "volume-one",
      expectedHistoryRevision: 3,
      headSnapshotId: "snapshot-v2-head",
      nativeHeadTurnId: "turn-last",
    }),
    ["snapshot-old-output", "snapshot-old-input"],
  );
  assert.match(baselineInsert, /includes_native_state, status/);
  assert.match(baselineInsert, /TRUE, 'ready'/);
  assert.match(runtimeUpdate, /head_volume_snapshot_id = \$5/);
  assert.match(runtimeUpdate, /history_revision = history_revision \+ 1/);
});

test("drops a partial JSONL tail when recovery starts a new process attempt", async () => {
  let recoveryUpdate = "";
  let recoveryParams: unknown[] | undefined;
  const client = {
    async query<Row>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<Row & Record<string, unknown>>> {
      if (sql.includes("UPDATE session_runtime")) {
        recoveryUpdate = sql.replace(/\s+/g, " ").trim();
        recoveryParams = params;
        return {
          rows: [{ session_id: "session-test" }],
          rowCount: 1,
        } as unknown as QueryResult<Row & Record<string, unknown>>;
      }
      return { rows: [], rowCount: null } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  const replaced = await store.replaceRecoveredCodexRuntime(
    "session-test",
    "operation-one",
    "supervisor-same",
    {
      supervisorSessionId: "supervisor-same",
      attemptId: "attempt-new",
      runtimeGeneration: 2,
      sandboxRestarted: true,
    },
  );

  assert.equal(replaced, true);
  assert.deepEqual(recoveryParams?.slice(0, 5), [
    "session-test",
    "supervisor-same",
    "supervisor-same",
    "attempt-new",
    2,
  ]);
  assert.match(
    recoveryUpdate,
    /stdout_tail = CASE WHEN \$2 <> \$3 OR attempt_id IS DISTINCT FROM \$4 OR runtime_generation <> \$5 THEN '' ELSE stdout_tail END/,
  );
  assert.match(
    recoveryUpdate,
    /supervisor_cursor = CASE WHEN \$2 <> \$3 THEN 0 ELSE supervisor_cursor END/,
  );
});

test("releases every in-progress checkpoint claim after a single-server restart", async () => {
  let statement = "";
  const store = new SandpiStore({
    async query(sql: string) {
      statement = sql.replace(/\s+/g, " ").trim();
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool);

  await store.recoverStaleTurnCheckpointClaims();

  assert.match(statement, /WHERE status = 'creating'$/);
  assert.doesNotMatch(statement, /INTERVAL|updated_at/);
});

test("recovers only fully checkpointed idle runtimes to waiting after restart", async () => {
  let recoveryQuery = "";
  const store = new SandpiStore({
    async query<Row>(sql: string) {
      recoveryQuery = sql.replace(/\s+/g, " ").trim();
      return {
        rows: [{ id: "session-recovered" }],
        rowCount: 1,
      } as unknown as QueryResult<Row & Record<string, unknown>>;
    },
  } as unknown as Pool);

  assert.deepEqual(await store.recoverWaitingSessionsAfterRestart(), [
    "session-recovered",
  ]);
  assert.match(recoveryQuery, /session\.status = 'running'/);
  assert.match(recoveryQuery, /runtime\.active_native_turn_id IS NULL/);
  assert.match(
    recoveryQuery,
    /runtime\.pending_turn_input_snapshot_id IS NULL/,
  );
  assert.match(recoveryQuery, /checkpoint\.status IN \('creating', 'failed'\)/);
  assert.match(recoveryQuery, /NOT EXISTS \( SELECT 1 FROM session_turn_mutations/);
});

test("does not abandon Turn input while its output checkpoint is recoverable", async () => {
  let abandonmentQuery = "";
  const client = {
    async query<Row>(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("pending_turn_input_snapshot_id AS snapshot_id")) {
        abandonmentQuery = normalized;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  assert.equal(
    await store.abandonTurnSubmission("session-test", "request-test"),
    undefined,
  );
  assert.match(abandonmentQuery, /checkpoint\.status IN \('creating', 'failed'\)/);
});

test("discovers interrupted native-state migrations for startup recovery", async () => {
  let recoveryQuery = "";
  const store = new SandpiStore({
    async query<Row>(sql: string) {
      recoveryQuery = sql.replace(/\s+/g, " ").trim();
      return { rows: [], rowCount: 0 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
  } as unknown as Pool);

  assert.deepEqual(await store.migratingNativeStateRuntimes(), []);
  assert.match(recoveryQuery, /runtime\.harness_state_layout = 'migrating'/);
  assert.match(recoveryQuery, /session\.status = 'paused'/);
  assert.match(recoveryQuery, /session\.hard_expires_at > NOW\(\)/);
});

test("delays stale external Session operations by their heartbeat", async () => {
  let recoveryQuery = "";
  const store = new SandpiStore({
    async query<Row>(sql: string) {
      recoveryQuery = sql.replace(/\s+/g, " ").trim();
      return { rows: [], rowCount: 0 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
  } as unknown as Pool);

  assert.deepEqual(await store.recoverStaleSessionOperations(), []);
  assert.match(recoveryQuery, /exclusive_operation_kind = 'turn_fork'/);
  assert.match(
    recoveryQuery,
    /exclusive_operation_heartbeat_at < NOW\(\) - INTERVAL '10 minutes'/,
  );
  assert.doesNotMatch(
    recoveryQuery,
    /exclusive_operation_started_at < NOW\(\) - INTERVAL/,
  );
});

test("clears pending replacement input when compensation releases a mutation", async () => {
  let runtimeUpdateParams: unknown[] | undefined;
  let runtimeUpdate = "";
  const client = {
    async query<Row>(sql: string, params?: unknown[]) {
      if (sql.includes("UPDATE session_runtime")) {
        runtimeUpdate = sql.replace(/\s+/g, " ").trim();
        runtimeUpdateParams = params;
      }
      return { rows: [], rowCount: 1 } as unknown as QueryResult<
        Row & Record<string, unknown>
      >;
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  await store.releasePreparedTurnMutation(
    "session-test",
    "mutation-test",
    { clearPendingInput: true },
  );

  assert.match(
    runtimeUpdate,
    /pending_turn_input_snapshot_id = CASE WHEN \$2 THEN NULL/,
  );
  assert.deepEqual(runtimeUpdateParams, ["session-test", true]);
});
