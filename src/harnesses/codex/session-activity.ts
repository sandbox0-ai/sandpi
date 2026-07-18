import type {
  CodexConversationProjection,
  CodexMessageView,
  CodexTimelineEntry,
  CodexTurnView,
} from "./events";

export type CodexSessionActivityFilter =
  | "all"
  | "external"
  | "commands"
  | "files"
  | "agents"
  | "system";

export type CodexSessionActivityCategory = Exclude<
  CodexSessionActivityFilter,
  "all"
>;

export type CodexSessionActivityEntry = Exclude<
  CodexTimelineEntry,
  CodexMessageView
>;

export interface CodexSessionActivityTurn {
  turnId: string;
  ordinal: number;
  turn?: CodexTurnView;
  prompt?: string;
  entries: CodexSessionActivityEntry[];
}

const CODEX_EXTERNAL_ACTIVITY_KINDS = new Set<CodexTimelineEntry["kind"]>([
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageGeneration",
]);

/**
 * Codex-only categorization for its Session Activity UI. These categories are
 * deliberately not exported through Sandpi's shared Session contract.
 */
export function codexSessionActivityCategory(
  entry: CodexSessionActivityEntry,
): CodexSessionActivityCategory {
  if (entry.kind === "command") return "commands";
  if (entry.kind === "fileChange") return "files";
  if (CODEX_EXTERNAL_ACTIVITY_KINDS.has(entry.kind)) return "external";
  if (
    entry.kind === "collabAgentToolCall" ||
    entry.kind === "subAgentActivity"
  ) {
    return "agents";
  }
  return "system";
}

export function selectCodexSessionActivity(
  projection: CodexConversationProjection,
  filter: CodexSessionActivityFilter = "all",
): CodexSessionActivityTurn[] {
  const turns = new Map<string, CodexSessionActivityTurn>();
  let nextOrdinal = 1;

  for (const turn of projection.turns) {
    turns.set(turn.turnId, {
      turnId: turn.turnId,
      ordinal: nextOrdinal,
      turn,
      entries: [],
    });
    nextOrdinal += 1;
  }

  for (const entry of projection.entries) {
    const group = turns.get(entry.turnId) ?? {
      turnId: entry.turnId,
      ordinal: nextOrdinal,
      entries: [],
    };
    if (!turns.has(entry.turnId)) nextOrdinal += 1;
    turns.set(entry.turnId, group);

    if (entry.kind === "message") {
      if (entry.role === "user" && entry.content.trim()) {
        group.prompt = entry.content.trim();
      }
      continue;
    }
    if (
      filter === "all" ||
      codexSessionActivityCategory(entry) === filter
    ) {
      group.entries.push(entry);
    }
  }

  return [...turns.values()].filter((turn) => turn.entries.length > 0);
}

export function summarizeCodexSessionActivity(
  projection: CodexConversationProjection,
) {
  const summary: Record<CodexSessionActivityCategory, number> = {
    external: 0,
    commands: 0,
    files: 0,
    agents: 0,
    system: 0,
  };
  let total = 0;

  for (const entry of projection.entries) {
    if (entry.kind === "message") continue;
    total += 1;
    summary[codexSessionActivityCategory(entry)] += 1;
  }

  return { total, ...summary };
}
