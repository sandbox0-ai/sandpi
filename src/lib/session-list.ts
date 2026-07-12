import type { CodingSession } from "@/lib/types";

export function visibleSessionsForEnvironment(
  sessions: CodingSession[],
  environmentId: string,
  omittedSessionId?: string,
): CodingSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .filter(
      ({ session }) =>
        session.environmentId === environmentId &&
        !session.archived &&
        session.id !== omittedSessionId,
    )
    .sort(
      (left, right) =>
        Number(right.session.pinned) - Number(left.session.pinned) ||
        left.index - right.index,
    )
    .map(({ session }) => session);
}
