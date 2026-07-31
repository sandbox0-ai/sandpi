import type { CodingSession } from "./types";

export type SessionStateMarker = "running" | "unread" | undefined;

/**
 * Cross-client sidebar marker contract. Completed Sessions stay visually quiet
 * until the user explicitly reopens them.
 */
export function sessionStateMarker(
  session: Pick<CodingSession, "status" | "unread" | "completed">,
): SessionStateMarker {
  if (session.completed) return undefined;
  if (session.status === "running") return "running";
  if (session.unread) return "unread";
  return undefined;
}
