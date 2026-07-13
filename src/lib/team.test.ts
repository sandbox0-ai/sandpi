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
  assignMembershipPlan,
  canStartMembershipExecution,
  environmentsForTeam,
  membershipForUserInTeam,
  membershipPlanCounts,
  membershipsForUser,
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

test("keeps Plans on Memberships while the Team owns consolidated billing", () => {
  const team = mockTeams[0];
  assert.ok(team);
  const memberships = mockTeamMemberships.filter(
    (membership) => membership.teamId === team.id,
  );
  const viewerMembership = membershipForUserInTeam(
    memberships,
    mockViewer.id,
    team.id,
  );

  assert.ok(viewerMembership);
  assert.equal(team.billingAccount.billingCadence, "monthly");
  assert.equal("planId" in team, false);
  assert.equal("subscription" in team, false);
  assert.equal(viewerMembership.planAssignment.planId, "max");
  assert.equal(
    viewerMembership.planAssignment.quotas.weeklyExecution.window,
    "weekly",
  );
  assert.equal(canStartMembershipExecution(viewerMembership, team), true);
  assert.deepEqual(membershipPlanCounts(memberships), {
    free: 1,
    pro: 2,
    max: 1,
  });
  assert.equal(quotaPercent(3_240, 7_200), 45);
});

test("gives one User an independent Plan assignment in every Team", () => {
  const memberships = membershipsForUser(mockTeamMemberships, mockViewer.id);

  assert.deepEqual(
    memberships.map((membership) => [
      membership.teamId,
      membership.planAssignment.planId,
    ]),
    [
      ["team-sandpi-labs", "max"],
      ["team-side-projects", "pro"],
    ],
  );
});

test("reassigns one Membership without moving its recorded usage", () => {
  const membership = mockTeamMemberships.find(
    (candidate) => candidate.id === "member-ada-labs",
  );
  const maxPlan = mockSandpiPlans.find((plan) => plan.id === "max");
  assert.ok(membership);
  assert.ok(maxPlan);

  const assigned = assignMembershipPlan(membership.planAssignment, maxPlan);

  assert.equal(assigned.planId, "max");
  assert.equal(assigned.quotas.weeklyExecution.used, 160);
  assert.equal(assigned.quotas.weeklyExecution.limit, 7_200);
  assert.equal(assigned.quotas.concurrentSessions.limit, 12);
  assert.equal(assigned.quotas.snapshotStorage.limit, 80);
});

test("does not activate a pending invite when its sponsored Plan changes", () => {
  const invited = mockTeamMemberships.find(
    (candidate) => candidate.id === "member-noah-labs",
  );
  const proPlan = mockSandpiPlans.find((plan) => plan.id === "pro");
  assert.ok(invited);
  assert.ok(proPlan);

  const assigned = assignMembershipPlan(invited.planAssignment, proPlan);

  assert.equal(assigned.planId, "pro");
  assert.equal(assigned.status, "pending");
});
