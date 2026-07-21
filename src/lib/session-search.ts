import type { CodingSession, Environment } from "@/lib/types";

export interface SessionSearchResult {
  session: CodingSession;
  environment: Environment;
}

function relevance(
  session: CodingSession,
  environment: Environment,
  query: string,
): number {
  const title = session.title.toLocaleLowerCase();
  if (title.startsWith(query)) {
    return 0;
  }
  if (title.includes(query)) {
    return 1;
  }
  if (environment.name.toLocaleLowerCase().includes(query)) {
    return 2;
  }
  if (session.owner?.name.toLocaleLowerCase().includes(query)) {
    return 3;
  }
  if (session.harnessLabel.toLocaleLowerCase().includes(query)) {
    return 4;
  }
  return 5;
}

export function searchSessions(
  sessions: CodingSession[],
  environments: Environment[],
  input: string,
): SessionSearchResult[] {
  const query = input.trim().toLocaleLowerCase();
  const environmentById = new Map(
    environments.map((environment) => [environment.id, environment]),
  );

  return sessions
    .filter((session) => !session.archived)
    .map((session) => {
      const environment = environmentById.get(session.environmentId);
      return environment ? { session, environment } : null;
    })
    .filter((result): result is SessionSearchResult => Boolean(result))
    .filter(({ session, environment }) => {
      if (!query) {
        return true;
      }
      return [
        session.title,
        environment.name,
        session.owner?.name ?? "",
        session.owner?.email ?? "",
        session.harnessLabel,
        session.status,
      ].some((value) => value.toLocaleLowerCase().includes(query));
    })
    .sort((left, right) => {
      if (query) {
        const relevanceDifference =
          relevance(left.session, left.environment, query) -
          relevance(right.session, right.environment, query);
        if (relevanceDifference !== 0) {
          return relevanceDifference;
        }
      }
      return right.session.updatedAt - left.session.updatedAt;
    });
}
