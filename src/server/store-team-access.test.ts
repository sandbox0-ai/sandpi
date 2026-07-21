import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { SandpiStore } from "./store";

test("queries Team Environments and Sessions without exposing another user's private Environment", async () => {
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
              id: "session-team",
              environment_id: "environment-team",
              title: "Shared work",
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
              native_session_id: "thread-team",
              model_id: "gpt-test",
              reasoning_effort: null,
              history_revision: 0,
              owner_id: "user-owner",
              owner_email: "owner@example.com",
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
    /environment\.visibility = 'team'[\s\S]+OR environment\.created_by_user_id = \$1/,
  );
  assert.match(
    queries[1] ?? "",
    /LEFT JOIN users owner ON owner\.id = session\.created_by_user_id/,
  );
  assert.match(
    queries[1] ?? "",
    /LEFT JOIN session_pins pin[\s\S]+pin\.user_id = membership\.user_id/,
  );
  assert.match(
    queries[1] ?? "",
    /ORDER BY \(pin\.user_id IS NOT NULL\) DESC/,
  );
  assert.match(
    queries[1] ?? "",
    /environment\.visibility = 'team'[\s\S]+OR environment\.created_by_user_id = \$1/,
  );
});

test("stores a Session pin only for the acting user", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      return { rowCount: 1, rows: [{ id: "session-team" }] };
    },
    release() {},
  };
  const store = new SandpiStore({
    async connect() {
      return client;
    },
  } as unknown as Pool);
  Object.defineProperty(store, "getSession", {
    value: async () => ({ id: "session-team", pinned: true }),
  });

  await store.setSessionMetadata("user-viewer", "session-team", {
    pinned: true,
  });

  const metadataUpdate = queries.find(({ sql }) => sql.includes("UPDATE sessions"));
  assert.ok(metadataUpdate);
  assert.doesNotMatch(metadataUpdate.sql, /pinned/);
  const personalPin = queries.find(({ sql }) =>
    sql.includes("INSERT INTO session_pins"),
  );
  assert.ok(personalPin);
  assert.deepEqual(personalPin.values, ["session-team", "user-viewer"]);
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
      id: "environment-team",
      idlePauseTimeoutSeconds: 30 * 60,
    }),
  });

  await store.updateEnvironment("user-viewer", "environment-team", {
    name: "Shared work",
    description: "",
    color: "#151515",
    visibility: "team",
    idlePauseTimeoutSeconds: 0,
    networkPolicy: { mode: "allow-all", domainExceptions: [] },
  });

  const environmentUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE environments"),
  );
  assert.ok(environmentUpdate);
  assert.match(environmentUpdate.sql, /idle_pause_timeout_seconds = \$6/);
  const runtimeUpdate = queries.find(({ sql }) =>
    sql.includes("UPDATE environment_runtime"),
  );
  assert.ok(runtimeUpdate);
  assert.match(runtimeUpdate.sql, /WHEN \$2::INTEGER = 0 THEN NULL/);
  assert.deepEqual(runtimeUpdate.values, ["environment-team", 0]);
});

test("limits Environment management to its creator or a Team owner or admin", async () => {
  let query = "";
  const store = new SandpiStore({
    async query(sql: string) {
      query = sql;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool);

  await assert.rejects(
    store.getManageableEnvironment("user-viewer", "environment-team"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_not_found",
  );
  assert.match(query, /environment\.created_by_user_id = \$1/);
  assert.match(
    query,
    /environment\.visibility = 'team'[\s\S]+membership\.role IN \('owner', 'admin'\)/,
  );
});

test("updates Plan limits on the Team while preserving Team usage", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const now = new Date("2026-07-21T00:00:00.000Z");
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT role FROM team_memberships")) {
        return { rowCount: 1, rows: [{ role: "owner" }] };
      }
      if (sql.includes("SELECT team.*")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "team-one",
              name: "Team One",
              slug: "team-one",
              color: "#315c4b",
              member_count: 2,
              plan_id: "max",
              plan_status: "active",
              plan_quotas: {
                weeklyExecution: {
                  used: 45,
                  limit: 7_200,
                  unit: "minute",
                  window: "weekly",
                  resetsAt: now.toISOString(),
                },
                concurrentSessions: { used: 1, limit: 12, unit: "session" },
                snapshotStorage: { used: 2, limit: 80, unit: "gibibyte" },
              },
              billing_account_id: "billing-one",
              billing_status: "active",
              billing_cadence: "monthly",
              billing_email: "billing@example.com",
              billing_period_starts_at: now,
              billing_period_ends_at: new Date("2026-08-21T00:00:00.000Z"),
              created_at: now,
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;

  const team = await new SandpiStore(pool).updateTeamPlan(
    "user-owner",
    "team-one",
    "max",
  );

  assert.equal(team.plan.planId, "max");
  assert.equal(team.plan.quotas.weeklyExecution.used, 45);
  assert.equal(team.plan.quotas.weeklyExecution.limit, 7_200);
  const update = queries.find(({ sql }) => sql.includes("UPDATE teams"));
  assert.ok(update);
  assert.doesNotMatch(update.sql, /UPDATE team_memberships/);
  assert.deepEqual(update.values, ["team-one", "max", 7_200, 12, 80]);
});
