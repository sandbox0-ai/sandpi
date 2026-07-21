import assert from "node:assert/strict";
import test from "node:test";
import { buildCommunitySeed, COMMUNITY_DEFAULT_SEED } from "./seed";

test("community seed is deterministic for an injected timestamp", () => {
  const seed = buildCommunitySeed({ now: new Date("2026-07-14T00:00:00.000Z") });

  assert.equal(seed.admin.id, COMMUNITY_DEFAULT_SEED.admin.id);
  assert.equal(seed.team.id, COMMUNITY_DEFAULT_SEED.team.id);
  assert.equal(seed.environment.id, COMMUNITY_DEFAULT_SEED.environment.id);
  assert.equal(seed.environment.harness, "codex");
  assert.equal("planAssignmentId" in seed.membership, false);
  assert.equal(seed.periodEndsAt.toISOString(), "2026-08-14T00:00:00.000Z");
  assert.equal(seed.weeklyQuotaResetsAt.toISOString(), "2026-07-21T00:00:00.000Z");
});

test("community seed allows deployment-owned identity labels", () => {
  const seed = buildCommunitySeed({
    now: new Date("2026-07-14T00:00:00.000Z"),
    admin: { email: "owner@example.com", name: "Owner" },
    team: { name: "Example Team", slug: "example" },
    environment: { name: "Main", harness: "codex" },
  });

  assert.equal(seed.admin.email, "owner@example.com");
  assert.equal(seed.team.slug, "example");
  assert.equal(seed.environment.name, "Main");
});
