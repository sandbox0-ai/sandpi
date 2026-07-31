import type { CodingSession } from "@/lib/types";

export const SIDEBAR_INITIAL_SESSION_COUNT = 6;
export const SIDEBAR_SESSION_PAGE_SIZE = 10;

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

export interface SidebarSessionPage {
  sessions: CodingSession[];
  hiddenCount: number;
  nextCount: number;
  expanded: boolean;
}

/**
 * Returns one client-side Sidebar window without hiding running or explicitly
 * selected Sessions. The source array remains authoritative for search and
 * navigation. Those always-visible Sessions do not consume incremental page
 * slots.
 */
export function sidebarSessionPage(
  sessions: CodingSession[],
  requestedCount: number,
  selectedSessionId?: string,
): SidebarSessionPage {
  const normalizedCount = Number.isFinite(requestedCount)
    ? Math.trunc(requestedCount)
    : SIDEBAR_INITIAL_SESSION_COUNT;
  const additionalCount = Math.max(
    0,
    normalizedCount - SIDEBAR_INITIAL_SESSION_COUNT,
  );
  const visibleIds = new Set(
    sessions
      .slice(0, SIDEBAR_INITIAL_SESSION_COUNT)
      .map((session) => session.id),
  );
  for (const session of sessions) {
    if (session.status === "running" || session.id === selectedSessionId) {
      visibleIds.add(session.id);
    }
  }
  let revealedCount = 0;
  for (const session of sessions) {
    if (revealedCount >= additionalCount) break;
    if (visibleIds.has(session.id)) continue;
    visibleIds.add(session.id);
    revealedCount += 1;
  }
  const visibleSessions = sessions.filter((session) =>
    visibleIds.has(session.id),
  );
  const hiddenCount = sessions.length - visibleSessions.length;

  return {
    sessions: visibleSessions,
    hiddenCount,
    nextCount: Math.min(SIDEBAR_SESSION_PAGE_SIZE, hiddenCount),
    expanded: revealedCount > 0,
  };
}
