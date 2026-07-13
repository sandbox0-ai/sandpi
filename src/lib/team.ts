import type {
  CodingSession,
  Environment,
  MembershipPlanAssignment,
  SandpiPlan,
  SandpiPlanId,
  Team,
  TeamMembership,
} from "@/lib/types";

export function environmentsForTeam(
  environments: Environment[],
  teamId: string,
): Environment[] {
  return environments.filter((environment) => environment.teamId === teamId);
}

export function sessionsForTeam(
  sessions: CodingSession[],
  environments: Environment[],
  teamId: string,
): CodingSession[] {
  const environmentIds = new Set(
    environmentsForTeam(environments, teamId).map((environment) => environment.id),
  );
  return sessions.filter((session) => environmentIds.has(session.environmentId));
}

export function teamForEnvironment(
  teams: Team[],
  environment: Pick<Environment, "teamId">,
): Team | undefined {
  return teams.find((team) => team.id === environment.teamId);
}

export function membershipsForUser(
  memberships: TeamMembership[],
  userId: string,
): TeamMembership[] {
  return memberships.filter((membership) => membership.user.id === userId);
}

export function membershipForUserInTeam(
  memberships: TeamMembership[],
  userId: string,
  teamId: string,
): TeamMembership | undefined {
  return memberships.find(
    (membership) =>
      membership.user.id === userId && membership.teamId === teamId,
  );
}

export function planForAssignment(
  plans: SandpiPlan[],
  assignment: MembershipPlanAssignment,
): SandpiPlan | undefined {
  return plans.find((plan) => plan.id === assignment.planId);
}

export function quotaPercent(used: number, limit: number): number {
  if (limit <= 0) {
    return 100;
  }
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

/**
 * Sandpi admits execution against the acting Membership's entitlement and the sponsoring
 * Team's billing state. Production usage records both identifiers per Turn; attribution must
 * stay outside the native coding-agent event payload.
 */
export function canStartMembershipExecution(
  membership: TeamMembership,
  team: Team,
): boolean {
  const billingAvailable = [
    "public-beta",
    "active",
    "deployment-managed",
  ].includes(team.billingAccount.status);
  const assignment = membership.planAssignment;
  return (
    membership.status === "active" &&
    assignment.status === "active" &&
    billingAvailable &&
    assignment.quotas.weeklyExecution.used <
      assignment.quotas.weeklyExecution.limit &&
    assignment.quotas.concurrentSessions.used <
      assignment.quotas.concurrentSessions.limit
  );
}

export function assignMembershipPlan(
  assignment: MembershipPlanAssignment,
  plan: SandpiPlan,
): MembershipPlanAssignment {
  return {
    ...assignment,
    planId: plan.id,
    quotas: {
      weeklyExecution: {
        ...assignment.quotas.weeklyExecution,
        limit: plan.execution.weeklyLimitMinutes,
      },
      concurrentSessions: {
        ...assignment.quotas.concurrentSessions,
        limit: plan.execution.concurrentSessionLimit,
      },
      snapshotStorage: {
        ...assignment.quotas.snapshotStorage,
        limit: plan.storage.snapshotLimitGiB,
      },
    },
  };
}

export function membershipPlanCounts(
  memberships: TeamMembership[],
): Record<SandpiPlanId, number> {
  return memberships.reduce<Record<SandpiPlanId, number>>(
    (counts, membership) => {
      if (membership.status === "active") {
        counts[membership.planAssignment.planId] += 1;
      }
      return counts;
    },
    { free: 0, pro: 0, max: 0 },
  );
}
