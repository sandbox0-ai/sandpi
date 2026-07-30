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
 * Returns one client-side Sidebar window without hiding an explicitly selected
 * Session. The source array remains authoritative for search and navigation.
 */
export function sidebarSessionPage(
  sessions: CodingSession[],
  requestedCount: number,
  selectedSessionId?: string,
): SidebarSessionPage {
  const normalizedCount = Number.isFinite(requestedCount)
    ? Math.trunc(requestedCount)
    : SIDEBAR_INITIAL_SESSION_COUNT;
  const windowSize = Math.min(
    sessions.length,
    Math.max(SIDEBAR_INITIAL_SESSION_COUNT, normalizedCount),
  );
  const windowSessions = sessions.slice(0, windowSize);
  const selectedOutsideWindow = selectedSessionId
    ? sessions
        .slice(windowSize)
        .find((session) => session.id === selectedSessionId)
    : undefined;
  const visibleSessions = selectedOutsideWindow
    ? [...windowSessions, selectedOutsideWindow]
    : windowSessions;
  const visibleIds = new Set(visibleSessions.map((session) => session.id));
  const nextCount = sessions
    .slice(windowSize, windowSize + SIDEBAR_SESSION_PAGE_SIZE)
    .filter((session) => !visibleIds.has(session.id)).length;

  return {
    sessions: visibleSessions,
    hiddenCount: sessions.length - visibleSessions.length,
    nextCount,
    expanded: windowSize > SIDEBAR_INITIAL_SESSION_COUNT,
  };
}
