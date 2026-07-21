import assert from "node:assert/strict";
import test from "node:test";

import {
  mockEnvironments,
  mockSandpiPlans,
  mockSessions,
  mockTeamMemberships,
  mockTeams,
  mockViewer,
} from "@/lib/mock-data";
import {
  assignTeamPlan,
  canStartTeamExecution,
  environmentsForTeam,
  membershipForUserInTeam,
  membershipsForUser,
  planForTeam,
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

test("keeps the Plan and quota pool on the Team, never its Memberships", () => {
  const team = mockTeams[0];
  assert.ok(team);
  const viewerMembership = membershipForUserInTeam(
    mockTeamMemberships,
    mockViewer.id,
    team.id,
  );

  assert.ok(viewerMembership);
  assert.equal(team.billingAccount.billingCadence, "monthly");
  assert.equal(team.plan.planId, "max");
  assert.equal(team.plan.quotas.weeklyExecution.window, "weekly");
  assert.equal(planForTeam(mockSandpiPlans, team)?.name, "Max");
  assert.equal("planAssignment" in viewerMembership, false);
  assert.equal(canStartTeamExecution(team), true);
  assert.equal(quotaPercent(4_750, 7_200), 66);
});

test("gives each Team an independent Plan when one User belongs to both", () => {
  const memberships = membershipsForUser(mockTeamMemberships, mockViewer.id);
  const teamIds = new Set(memberships.map((membership) => membership.teamId));

  assert.deepEqual(
    mockTeams
      .filter((team) => teamIds.has(team.id))
      .map((team) => [team.id, team.plan.planId]),
    [
      ["team-sandpi-labs", "max"],
      ["team-side-projects", "pro"],
    ],
  );
});

test("reassigns a Team Plan without moving its recorded usage", () => {
  const team = mockTeams.find((candidate) => candidate.id === "team-side-projects");
  const maxPlan = mockSandpiPlans.find((plan) => plan.id === "max");
  assert.ok(team);
  assert.ok(maxPlan);

  const assigned = assignTeamPlan(team.plan, maxPlan);

  assert.equal(assigned.planId, "max");
  assert.equal(assigned.quotas.weeklyExecution.used, 410);
  assert.equal(assigned.quotas.weeklyExecution.limit, 7_200);
  assert.equal(assigned.quotas.concurrentSessions.limit, 12);
  assert.equal(assigned.quotas.snapshotStorage.limit, 80);
});

test("blocks Team execution when the Team Plan is suspended", () => {
  const team = mockTeams[0];
  assert.ok(team);

  assert.equal(
    canStartTeamExecution({
      ...team,
      plan: { ...team.plan, status: "suspended" },
    }),
    false,
  );
});
