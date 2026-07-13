import type { CodingSession, Environment, Team, TeamSubscription } from "@/lib/types";

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

export function quotaPercent(used: number, limit: number): number {
  if (limit <= 0) {
    return 100;
  }
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

export function canStartTeamExecution(subscription: TeamSubscription): boolean {
  return (
    (subscription.status === "active" || subscription.status === "trialing") &&
    subscription.quotas.weeklyExecution.used <
      subscription.quotas.weeklyExecution.limit &&
    subscription.quotas.concurrentSessions.used <
      subscription.quotas.concurrentSessions.limit
  );
}

