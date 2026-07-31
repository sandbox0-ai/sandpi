import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { SandpiStore } from "./store";

test("serializes Environment creation against the user plan limit", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("COUNT(*)::TEXT")) {
        return { rowCount: 1, rows: [{ count: "1" }] };
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

  await assert.rejects(
    store.createEnvironmentMetadata({
      userId: "user-viewer",
      name: "Second Environment",
      sandboxMemoryMiB: 2 * 1024,
      environmentLimit: 1,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_plan_limit",
  );

  assert.equal(
    queries.some((sql) => sql.includes("pg_advisory_xact_lock")),
    true,
  );
  assert.equal(
    queries.some((sql) => sql.includes("INSERT INTO environments")),
    false,
  );
  assert.equal(queries.at(-1), "ROLLBACK");
});

test("persists the plan-selected Sandbox memory during Environment creation", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);
  Object.defineProperty(store, "getEnvironment", {
    value: async () => ({ id: "environment-user" }),
  });

  await store.createEnvironmentMetadata({
    userId: "user-viewer",
    name: "Free Environment",
    sandboxMemoryMiB: 2 * 1024,
    environmentLimit: 1,
  });

  const insert = queries.find(({ sql }) =>
    sql.includes("INSERT INTO environments"),
  );
  assert.ok(insert);
  assert.match(insert.sql, /network_policy, sandbox_memory_mib/);
  assert.deepEqual(insert.values?.slice(1), [
    "user-viewer",
    "Free Environment",
    2 * 1024,
  ]);
});

test("scopes Environments and Sessions to the owning user", async () => {
  const queries: string[] = [];
  const now = new Date("2026-07-21T00:00:00.000Z");
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("FROM sessions session")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "session-user",
              environment_id: "environment-user",
              title: "Owned work",
              status: "waiting",
              unread: false,
              pinned: false,
              archived: false,
              harness: "codex",
              harness_state: {},
              environment_revision: 1,
              origin_kind: null,
              origin_label: null,
              source_session_id: null,
              source_native_item_id: null,
              created_at: now,
              updated_at: now,
              native_session_id: "thread-user",
              model_id: "gpt-test",
              reasoning_effort: null,
              history_revision: 0,
              owner_id: "user-viewer",
              owner_email: "viewer@example.com",
              owner_name: "Environment Owner",
              owner_avatar_initials: "EO",
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;
  const store = new SandpiStore(pool);

  assert.deepEqual(await store.listEnvironments("user-viewer"), []);
  const sessions = await store.listSessions("user-viewer");

  assert.equal(sessions[0]?.owner?.name, "Environment Owner");
  assert.equal(sessions[0]?.owner?.avatarInitials, "EO");
  assert.match(
    queries[0] ?? "",
    /environment\.created_by_user_id = \$1/,
  );
  assert.doesNotMatch(queries[0] ?? "", /membership|visibility/i);
  assert.match(
    queries[1] ?? "",
    /LEFT JOIN users owner ON owner\.id = session\.created_by_user_id/,
  );
  assert.match(
    queries[1] ?? "",
    /LEFT JOIN session_pins pin[\s\S]+pin\.user_id = \$1/,
  );
  assert.match(
    queries[1] ?? "",
    /ORDER BY \(pin\.user_id IS NOT NULL\) DESC/,
  );
  assert.match(queries[1] ?? "", /environment\.created_by_user_id = \$1/);
  assert.doesNotMatch(queries[1] ?? "", /membership|visibility/i);
});

test("reorders every owned Environment in one transaction", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT id") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 2,
          rows: [{ id: "environment-first" }, { id: "environment-second" }],
        };
      }
      return { rowCount: 2, rows: [] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  await store.reorderEnvironments("user-viewer", [
    "environment-second",
    "environment-first",
  ]);

  const update = queries.find(({ sql }) =>
    sql.includes("WITH ORDINALITY"),
  );
  assert.ok(update);
  assert.deepEqual(update.values, [
    "user-viewer",
    ["environment-second", "environment-first"],
  ]);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
});

test("rejects an Environment order that omits an owned Environment", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("SELECT id") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: 2,
          rows: [{ id: "environment-first" }, { id: "environment-second" }],
        };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);

  await assert.rejects(
    store.reorderEnvironments("user-viewer", ["environment-first"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_order_mismatch",
  );
  assert.equal(queries.at(-1), "ROLLBACK");
});

test("stores a Session pin only for the acting user", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [{ id: "session-user" }] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);
  Object.defineProperty(store, "getSession", {
    value: async () => ({ id: "session-user", pinned: true }),
  });

  await store.setSessionMetadata("user-viewer", "session-user", {
    pinned: true,
  });

  const metadataUpdate = queries.find(({ sql }) => sql.includes("UPDATE sessions"));
  assert.ok(metadataUpdate);
  assert.doesNotMatch(metadataUpdate.sql, /pinned/);
  const personalPin = queries.find(({ sql }) =>
    sql.includes("INSERT INTO session_pins"),
  );
  assert.ok(personalPin);
  assert.deepEqual(personalPin.values, ["session-user", "user-viewer"]);
});

test("stores Session completion independently from archive state", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [{ id: "session-user" }] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);
  Object.defineProperty(store, "getSession", {
    value: async () => ({ id: "session-user", completed: true }),
  });

  await store.setSessionMetadata("user-viewer", "session-user", {
    completed: true,
  });

  const metadataUpdate = queries.find(({ sql }) => sql.includes("UPDATE sessions"));
  assert.ok(metadataUpdate);
  assert.match(metadataUpdate.sql, /completed = COALESCE/);
  assert.deepEqual(metadataUpdate.values, [
    "session-user",
    null,
    null,
    null,
    true,
  ]);
});

test("clears the idle deadline when automatic Environment pause is disabled", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);
  Object.defineProperty(store, "getManageableEnvironment", {
    value: async () => ({
      id: "environment-user",
      idlePauseTimeoutSeconds: 30 * 60,
      sandboxMemoryMiB: 2 * 1024,
      workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
    }),
  });

  await store.updateEnvironment("user-viewer", "environment-user", {
    name: "Owned work",
    description: "",
    color: "#151515",
    idlePauseTimeoutSeconds: 0,
    sandboxMemoryMiB: 4 * 1024,
    workspaceBackup: { intervalSeconds: 86_400, retentionCount: 7 },
    networkPolicy: { mode: "allow-all", domainExceptions: [] },
  });

  const environmentUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE environments"),
  );
  assert.ok(environmentUpdate);
  assert.match(environmentUpdate.sql, /idle_pause_timeout_seconds = \$5/);
  assert.match(environmentUpdate.sql, /sandbox_memory_mib = \$6/);
  assert.match(
    environmentUpdate.sql,
    /workspace_backup_interval_seconds = \$7/,
  );
  assert.match(
    environmentUpdate.sql,
    /workspace_backup_retention_count = \$8/,
  );
  assert.deepEqual(environmentUpdate.values?.slice(4, 8), [
    0,
    4 * 1024,
    86_400,
    7,
  ]);
  const runtimeUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE environment_runtime") &&
    sql.includes("idle_pause_due_at"),
  );
  assert.ok(runtimeUpdate);
  assert.match(runtimeUpdate.sql, /WHEN \$2::INTEGER = 0 THEN NULL/);
  assert.deepEqual(runtimeUpdate.values, ["environment-user", 0]);
  const backupRuntimeUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE environment_runtime") &&
    sql.includes("workspace_backup_due_at"),
  );
  assert.ok(backupRuntimeUpdate);
  assert.deepEqual(backupRuntimeUpdate.values, [
    "environment-user",
    86_400,
    true,
  ]);
});

test("limits Environment management to its owner", async () => {
  let query = "";
  const store = new SandpiStore({
    async query(sql: string) {
      query = sql;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool);

  await assert.rejects(
    store.getManageableEnvironment("user-viewer", "environment-user"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_not_found",
  );
  assert.match(query, /environment\.created_by_user_id = \$1/);
  assert.doesNotMatch(query, /membership|visibility/i);
});
