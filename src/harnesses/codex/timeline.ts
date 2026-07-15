import type {
  CodexConversationProjection,
  CodexMessageView,
} from "./events";

/**
 * While editing, hide the selected user item, its complete native Turn, and
 * every later Turn. Leaving the old suffix visible makes Send look like an
 * append instead of a rollback-and-replace operation. iOS, Android, and
 * HarmonyOS clients must preserve this same Codex-specific interaction.
 */
export function visibleCodexTimelineWhileEditing(
  projection: CodexConversationProjection,
  itemId: string | null,
): CodexConversationProjection {
  if (!itemId) return projection;
  const selected = projection.entries.find(
    (entry): entry is CodexMessageView =>
      entry.kind === "message" &&
      entry.role === "user" &&
      entry.id === itemId,
  );
  if (!selected) return projection;

  const turnOrder = [...new Set(projection.entries.map((entry) => entry.turnId))];
  const selectedTurnIndex = turnOrder.indexOf(selected.turnId);
  if (selectedTurnIndex < 0) return projection;
  const visibleTurnIds = new Set(turnOrder.slice(0, selectedTurnIndex));
  return {
    entries: projection.entries.filter((entry) => visibleTurnIds.has(entry.turnId)),
  };
}

export function visibleCodexConversationWhileEditing(
  projection: CodexConversationProjection,
  itemId: string | null,
): CodexMessageView[] {
  return visibleCodexTimelineWhileEditing(projection, itemId).entries.filter(
    (entry): entry is CodexMessageView => entry.kind === "message",
  );
}
