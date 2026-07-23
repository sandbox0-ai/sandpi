import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  buildCommunitySeed,
  COMMUNITY_DEFAULT_SEED,
  seedCommunityDefaults,
} from "./seed";

test("community seed is deterministic", () => {
  const seed = buildCommunitySeed();

  assert.equal(seed.admin.id, COMMUNITY_DEFAULT_SEED.admin.id);
  assert.equal(seed.environment.id, COMMUNITY_DEFAULT_SEED.environment.id);
  assert.equal(seed.environment.harness, "codex");
});

test("community seed allows deployment-owned identity labels", () => {
  const seed = buildCommunitySeed({
    admin: { email: "owner@example.com", name: "Owner" },
    environment: { name: "Main", harness: "codex" },
  });

  assert.equal(seed.admin.email, "owner@example.com");
  assert.equal(seed.environment.name, "Main");
});

test("community seed persists only user-owned resources", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };

  await seedCommunityDefaults({
    async connect() {
      return client;
    },
  } as unknown as Pick<Pool, "connect">);

  const sql = queries.join("\n");
  assert.match(sql, /INSERT INTO users/);
  assert.match(sql, /INSERT INTO environments[\s\S]+created_by_user_id/);
  assert.doesNotMatch(sql, /\bteams\b|team_memberships|team_id/i);
});
