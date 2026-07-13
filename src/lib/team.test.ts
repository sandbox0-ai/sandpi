import assert from "node:assert/strict";
import test from "node:test";

import {
  mockEnvironments,
  mockSessions,
  mockTeams,
} from "@/lib/mock-data";
import {
  canStartTeamExecution,
  environmentsForTeam,
  quotaPercent,
  sessionsForTeam,
} from "@/lib/team";

test("scopes Environments and Sessions to one Sandpi Team", () => {
  const teamId = "team-side-projects";
  const environments = environmentsForTeam(mockEnvironments, teamId);
  const sessions = sessionsForTeam(mockSessions, mockEnvironments, teamId);

  assert.deepEqual(
    environments.map((environment) => environment.id),
    ["env-side-projects"],
  );
  assert.deepEqual(
    sessions.map((session) => session.id),
    ["session-harmony-shell"],
  );
});

test("models monthly Team subscription with a weekly shared execution pool", () => {
  const subscription = mockTeams[0]?.subscription;
  assert.ok(subscription);
  assert.equal(subscription.billingCadence, "monthly");
  assert.equal(subscription.quotas.weeklyExecution.window, "weekly");
  assert.equal(subscription.quotas.weeklyExecution.unit, "minute");
  assert.equal(canStartTeamExecution(subscription), true);
  assert.equal(quotaPercent(3_240, 7_200), 45);
});

