import type { CodingSession } from "./types";

export type SessionStateMarker = "running" | "unread" | "completed" | undefined;

/**
 * Cross-client sidebar marker contract. Completion has a quiet, persistent
 * marker and takes precedence over transient activity.
 */
export function sessionStateMarker(
  session: Pick<CodingSession, "status" | "unread" | "completed">,
): SessionStateMarker {
  if (session.completed) return "completed";
  if (session.status === "running") return "running";
  if (session.unread) return "unread";
  return undefined;
}
