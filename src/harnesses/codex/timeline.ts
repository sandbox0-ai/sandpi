import type {
  CodexConversationProjection,
  CodexMessageView,
  CodexTimelineEntry,
  CodexTurnResultView,
  CodexTurnView,
} from "./events";

export interface CodexTurnTimelineGroup {
  turnId: string;
  turn?: CodexTurnView;
  userMessages: CodexMessageView[];
  activityEntries: CodexTimelineEntry[];
  finalMessage?: CodexMessageView;
  results: CodexTurnResultView[];
}

/**
 * Preserve Codex-native Turn boundaries while separating the durable prompt
 * and final answer from noisy intermediate work. Completed Turns can then
 * collapse their activity without hiding either side of the conversation.
 */
export function groupCodexTimelineByTurn(
  projection: CodexConversationProjection,
): CodexTurnTimelineGroup[] {
  const turnById = new Map(projection.turns.map((turn) => [turn.turnId, turn]));
  const entriesByTurn = new Map<string, CodexTimelineEntry[]>();

  for (const entry of projection.entries) {
    const entries = entriesByTurn.get(entry.turnId) ?? [];
    entries.push(entry);
    entriesByTurn.set(entry.turnId, entries);
  }

  return [...entriesByTurn].map(([turnId, entries]) => {
    const turn = turnById.get(turnId);
    const assistantMessages = entries.filter(
      (entry): entry is CodexMessageView =>
        entry.kind === "message" && entry.role === "assistant",
    );
    const explicitFinal = assistantMessages.findLast(
      (message) => message.phase === "final_answer",
    );
    const finalMessage =
      explicitFinal ??
      (turn?.status !== "inProgress" ? assistantMessages.at(-1) : undefined);
    const results = entries.filter(
      (entry): entry is CodexTurnResultView => entry.kind === "turnResult",
    );

    return {
      turnId,
      turn,
      userMessages: entries.filter(
        (entry): entry is CodexMessageView =>
          entry.kind === "message" && entry.role === "user",
      ),
      activityEntries: entries.filter(
        (entry) =>
          entry.kind !== "turnResult" &&
          !(entry.kind === "message" && entry.role === "user") &&
          entry.id !== finalMessage?.id,
      ),
      finalMessage,
      results,
    };
  });
}

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
    turns: projection.turns.filter((turn) => visibleTurnIds.has(turn.turnId)),
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
