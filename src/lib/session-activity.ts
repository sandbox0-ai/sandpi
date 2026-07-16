import type { CodingSession } from "./types";

export type SessionActivityMarker = "running" | "unread" | undefined;

/**
 * Cross-client marker contract: a running Turn takes precedence over unread
 * activity, and the two states remain visually and semantically distinct.
 */
export function sessionActivityMarker(
  session: Pick<CodingSession, "status" | "unread">,
): SessionActivityMarker {
  if (session.status === "running") return "running";
  if (session.unread) return "unread";
  return undefined;
}
