import type { CodingSession } from "./types";

export type SessionStateMarker = "running" | "unread" | undefined;

/**
 * Cross-client sidebar marker contract: a running Turn takes precedence over
 * unread state, and the two states remain visually and semantically distinct.
 */
export function sessionStateMarker(
  session: Pick<CodingSession, "status" | "unread">,
): SessionStateMarker {
  if (session.status === "running") return "running";
  if (session.unread) return "unread";
  return undefined;
}
