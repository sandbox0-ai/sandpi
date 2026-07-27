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
  blocks: CodexTurnTimelineBlock[];
  activeActivityBlockId?: string;
}

export type CodexTurnTimelineBlock =
  | {
      kind: "message";
      id: string;
      entry: CodexMessageView;
    }
  | {
      kind: "activity";
      id: string;
      entries: CodexTimelineEntry[];
    }
  | {
      kind: "result";
      id: string;
      entry: CodexTurnResultView;
    };

function entryShowsActiveWork(entry: CodexTimelineEntry) {
  if (entry.kind === "message") {
    return entry.role === "assistant" && Boolean(entry.streaming);
  }
  return entry.kind !== "turnResult" && entry.status === "running";
}

/**
 * Preserve Codex-native item order within each Turn while separating visible
 * messages from intermediate work. In particular, do not hoist every user
 * message to the beginning: Codex may add later steering messages between tool
 * calls, and future harness adapters must preserve their own native ordering.
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
    const liveTail = entries.at(-1);
    const activeTurn =
      projection.activeTurn?.turnId === turnId
        ? projection.activeTurn
        : undefined;
    // Native providers may leave AgentMessage.phase null. While that tail item
    // is the work currently responding, render it as the answer instead of
    // nesting its streamed Markdown inside the Turn Activity disclosure.
    const implicitLiveFinal =
      activeTurn &&
      (activeTurn.state === "responding" || activeTurn.state === "working") &&
      liveTail?.kind === "message" &&
      liveTail.role === "assistant" &&
      liveTail.phase !== "commentary"
        ? liveTail
        : undefined;
    const finalMessage =
      explicitFinal ??
      implicitLiveFinal ??
      (turn?.status !== "inProgress" ? assistantMessages.at(-1) : undefined);
    const blocks: CodexTurnTimelineBlock[] = [];
    let activityEntries: CodexTimelineEntry[] = [];
    let activitySequence = 0;

    const flushActivity = () => {
      if (activityEntries.length === 0) return;
      blocks.push({
        kind: "activity",
        id: `${turnId}:activity:${activitySequence++}`,
        entries: activityEntries,
      });
      activityEntries = [];
    };

    for (const entry of entries) {
      if (
        entry.kind === "message" &&
        (entry.role === "user" || entry.id === finalMessage?.id)
      ) {
        flushActivity();
        blocks.push({ kind: "message", id: entry.id, entry });
        continue;
      }
      if (entry.kind === "turnResult") {
        flushActivity();
        blocks.push({ kind: "result", id: entry.id, entry });
        continue;
      }
      activityEntries.push(entry);
    }
    flushActivity();

    // A live suffix can expose work just before its opening userMessage. Move
    // only that first prompt ahead of leading activity; later user messages
    // stay exactly where the native harness placed them.
    const firstUserMessageIndex = blocks.findIndex(
      (block) => block.kind === "message" && block.entry.role === "user",
    );
    if (
      firstUserMessageIndex > 0 &&
      blocks
        .slice(0, firstUserMessageIndex)
        .every((block) => block.kind === "activity")
    ) {
      const [firstUserMessage] = blocks.splice(firstUserMessageIndex, 1);
      if (firstUserMessage) blocks.unshift(firstUserMessage);
    }

    let activeActivityBlockId: string | undefined;
    if (projection.activeTurn?.turnId === turnId) {
      const runningActivityIndex = blocks.findLastIndex(
        (block) =>
          block.kind === "activity" &&
          block.entries.some(entryShowsActiveWork),
      );
      if (runningActivityIndex >= 0) {
        activeActivityBlockId = blocks[runningActivityIndex]?.id;
      } else {
        const lastUserMessageIndex = blocks.findLastIndex(
          (block) => block.kind === "message" && block.entry.role === "user",
        );
        const existingActivityIndex = blocks.findLastIndex(
          (block, index) =>
            index > lastUserMessageIndex && block.kind === "activity",
        );
        if (existingActivityIndex >= 0) {
          activeActivityBlockId = blocks[existingActivityIndex]?.id;
        } else {
          const activeActivity = {
            kind: "activity" as const,
            id: `${turnId}:activity:active`,
            entries: [],
          };
          blocks.splice(
            Math.max(0, lastUserMessageIndex + 1),
            0,
            activeActivity,
          );
          activeActivityBlockId = activeActivity.id;
        }
      }
    }

    return {
      turnId,
      turn,
      blocks,
      activeActivityBlockId,
    };
  });
}
