import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  SandpiStore,
  WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
} from "./store";

test("Workspace quiescence includes every current native delivery state", async () => {
  let query = "";
  const store = new SandpiStore({
    async query(sql: string) {
      query = sql;
      return { rowCount: 1, rows: [{ busy: true }] };
    },
  } as unknown as Pool);

  await assert.rejects(
    store.assertEnvironmentWorkspaceQuiescent("environment-one"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_workspace_busy",
  );

  assert.match(query, /session\.status IN \('provisioning', 'running'\)/);
  assert.match(query, /runtime\.active_native_turn_id IS NOT NULL/);
  assert.match(query, /runtime\.pending_turn_phase IS NOT NULL/);
  assert.doesNotMatch(query, /exclusive_operation_id/);
});

test("recording a native Workspace restore invalidates only Sessions newer than the backup", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const backupCreatedAt = new Date("2026-07-21T12:00:00.000Z");
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT backup.created_at")) {
        return {
          rowCount: 1,
          rows: [
            {
              created_at: backupCreatedAt,
              workspace_volume_id: "volume-one",
            },
          ],
        };
      }
      if (sql.startsWith("SELECT workspace_volume_id")) {
        return {
          rowCount: 1,
          rows: [{ workspace_volume_id: "volume-one" }],
        };
      }
      if (sql.includes("RETURNING id")) {
        return {
          rowCount: 2,
          rows: [{ id: "session-new-one" }, { id: "session-new-two" }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  const result = await store.recordEnvironmentWorkspaceRestored(
    "environment-one",
    "sandbox-one",
    "snapshot-one",
  );

  assert.equal(result.unavailableSessionCount, 2);
  const recoverOlder = queries.find(({ sql }) =>
    sql.includes("metadata = metadata - 'workspaceRestore'"),
  );
  assert.ok(recoverOlder);
  assert.deepEqual(recoverOlder.values, [
    "environment-one",
    backupCreatedAt,
    WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
  ]);
  const invalidateNewer = queries.find(({ sql }) =>
    sql.includes("native-session-created-after-backup"),
  );
  assert.ok(invalidateNewer);
  assert.match(invalidateNewer.sql, /created_at > \$2/);
  assert.equal(invalidateNewer.values?.[2], "snapshot-one");
  const runtimeUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE session_runtime runtime"),
  );
  assert.ok(runtimeUpdate);
  assert.match(runtimeUpdate.sql, /WHEN session\.created_at > \$2 THEN \$3/);
  assert.deepEqual(runtimeUpdate.values, [
    "environment-one",
    backupCreatedAt,
    WORKSPACE_RESTORE_UNAVAILABLE_SESSION_ERROR,
  ]);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
});
