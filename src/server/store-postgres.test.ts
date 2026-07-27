import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import { SandpiStore } from "./store";

test(
  "runtime control SQL binds against PostgreSQL column types",
  { skip: !process.env.DATABASE_URL },
  async (context) => {
    const database = new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: "sandpi-store-postgres-test",
      max: 1,
    });
    const client = await database.connect();
    context.after(async () => {
      client.release();
      await database.end();
    });

    await client.query(`
      CREATE TEMP TABLE environment_runtime (
        environment_id TEXT PRIMARY KEY,
        supervisor_session_id TEXT,
        attempt_id TEXT,
        runtime_generation BIGINT NOT NULL,
        supervisor_cursor BIGINT NOT NULL,
        stdout_tail TEXT NOT NULL,
        decoder_attempt_id TEXT,
        decoder_runtime_generation BIGINT NOT NULL,
        desired_state TEXT NOT NULL,
        observed_state TEXT NOT NULL,
        last_event_at TIMESTAMPTZ,
        version BIGINT NOT NULL
      );
      CREATE TEMP TABLE sessions (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        status TEXT NOT NULL,
        archived BOOLEAN NOT NULL,
        unread BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TEMP TABLE session_runtime (
        session_id TEXT PRIMARY KEY,
        native_session_id TEXT,
        history_revision BIGINT NOT NULL,
        active_native_turn_id TEXT,
        active_turn_attempt_id TEXT,
        active_turn_runtime_generation BIGINT,
        pending_turn_request_id TEXT,
        pending_turn_client_message_id TEXT,
        pending_turn_stable_input_id TEXT,
        pending_turn_phase TEXT,
        pending_turn_native_turn_id TEXT,
        pending_turn_started_at TIMESTAMPTZ,
        pending_turn_attempt_id TEXT,
        pending_turn_runtime_generation BIGINT,
        interrupt_requested_native_turn_id TEXT,
        runtime_error_code TEXT,
        version BIGINT NOT NULL
      );
    `);
    await client.query(
      `INSERT INTO environment_runtime (
         environment_id, supervisor_session_id, attempt_id,
         runtime_generation, supervisor_cursor, stdout_tail,
         decoder_attempt_id, decoder_runtime_generation,
         desired_state, observed_state, version
       ) VALUES ($1, $2, $3, $4, 0, '', $3, $4, 'running', 'running', 1)`,
      ["environment-one", "supervisor-one", "attempt-one", 1],
    );
    await client.query(
      `INSERT INTO sessions (id, environment_id, status, archived)
       VALUES ($1, $2, 'running', FALSE)`,
      ["session-one", "environment-one"],
    );
    await client.query(
      `INSERT INTO session_runtime (
         session_id, native_session_id, history_revision, version
       ) VALUES ($1, $2, 0, 1)`,
      ["session-one", "thread-one"],
    );

    const pinnedClient = {
      query: client.query.bind(client),
      release() {},
    };
    const pinnedPool = {
      query: client.query.bind(client),
      async connect() {
        return pinnedClient;
      },
    } as unknown as Pool;
    const store = new SandpiStore(pinnedPool);

    assert.equal(
      await store.commitEnvironmentTransport(
        "environment-one",
        "supervisor-one",
        "attempt-one",
        1,
        {
          supervisorCursor: 0,
          tailBase64: "",
          attemptId: "attempt-one",
          runtimeGeneration: 1,
        },
        {
          supervisorCursor: 1,
          tailBase64: "",
          attemptId: "attempt-one",
          runtimeGeneration: 1,
        },
        [
          {
            type: "turnStarted",
            nativeSessionId: "thread-one",
            nativeTurnId: "turn-one",
            startedAt: new Date(),
          },
        ],
      ),
      true,
    );

    assert.equal(
      await store.reconcileNativeSessionState({
        sessionId: "session-one",
        nativeSessionId: "thread-one",
        historyRevision: 0,
        runtimeVersion: 2,
        environmentId: "environment-one",
        environmentSupervisorSessionId: "supervisor-one",
        environmentAttemptId: "attempt-one",
        environmentRuntimeGeneration: 1,
        activeNativeTurnId: "turn-two",
        requireUnarchived: true,
      }),
      true,
    );

    await client.query(
      `UPDATE session_runtime
       SET active_native_turn_id = 'turn-stale-active',
           pending_turn_phase = 'accepted',
           pending_turn_native_turn_id = 'turn-current',
           interrupt_requested_native_turn_id = NULL
       WHERE session_id = 'session-one'`,
    );
    assert.equal(
      await store.requestTurnInterrupt("session-one", "turn-browser-stale"),
      "turn-current",
    );
    const interrupted = await client.query<{
      interrupt_requested_native_turn_id: string | null;
    }>(
      `SELECT interrupt_requested_native_turn_id
       FROM session_runtime
       WHERE session_id = 'session-one'`,
    );
    assert.equal(
      interrupted.rows[0]?.interrupt_requested_native_turn_id,
      "turn-current",
    );
  },
);
