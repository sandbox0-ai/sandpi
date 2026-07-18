import type {
  CodexConversationProjection,
  CodexMessageView,
  CodexTimelineEntry,
  CodexTurnView,
} from "./events";
import type {
  CodexRolloutActivityFeed,
  CodexRolloutToolActivity,
} from "./rollout-activity";

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
> | CodexRolloutToolActivity;

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

const CODEX_ROLLOUT_COMMAND_TOOLS = new Set([
  "command",
  "exec",
  "exec_command",
  "local_shell",
  "shell_command",
  "unified_exec",
  "wait",
  "write_stdin",
]);
const CODEX_ROLLOUT_FILE_TOOLS = new Set([
  "apply_patch",
  "file_change",
  "write_file",
]);
const CODEX_ROLLOUT_AGENT_TOOLS = new Set([
  "close_agent",
  "followup_task",
  "interrupt_agent",
  "resume_agent",
  "send_input",
  "send_message",
  "spawn_agent",
  "wait_agent",
]);

function rolloutToolCategories(
  entry: CodexRolloutToolActivity,
): CodexSessionActivityCategory[] {
  const names =
    entry.codeModeTools.length > 0 ? entry.codeModeTools : [entry.name];
  const nameVariants = names.flatMap((name) => [
    name,
    name.split(".").at(-1) ?? name,
  ]);
  const categories: CodexSessionActivityCategory[] = [];
  const external =
    names.some(
      (name) =>
        name.startsWith("mcp__") ||
        name.startsWith("web.") ||
        name.startsWith("image_gen.") ||
        name.startsWith("image_gen__") ||
        name.startsWith("browser.") ||
        name.includes("web_search") ||
        name.includes("imagegen") ||
        name.includes("image_generation") ||
        name.includes("browser"),
    ) ||
    entry.callType === "tool_search_call" ||
    entry.callType === "web_search_call" ||
    entry.callType === "image_generation_call";
  if (external) categories.push("external");
  if (nameVariants.some((name) => CODEX_ROLLOUT_AGENT_TOOLS.has(name))) {
    categories.push("agents");
  }
  if (nameVariants.some((name) => CODEX_ROLLOUT_FILE_TOOLS.has(name))) {
    categories.push("files");
  }
  if (nameVariants.some((name) => CODEX_ROLLOUT_COMMAND_TOOLS.has(name))) {
    categories.push("commands");
  }
  return categories.length > 0 ? categories : ["system"];
}

function codexSessionActivityCategories(
  entry: CodexSessionActivityEntry,
): CodexSessionActivityCategory[] {
  if (entry.kind === "rolloutToolCall") return rolloutToolCategories(entry);
  if (entry.kind === "command") return ["commands"];
  if (entry.kind === "fileChange") return ["files"];
  if (CODEX_EXTERNAL_ACTIVITY_KINDS.has(entry.kind)) return ["external"];
  if (
    entry.kind === "collabAgentToolCall" ||
    entry.kind === "subAgentActivity"
  ) {
    return ["agents"];
  }
  return ["system"];
}

/**
 * Codex-only categorization for its Session Activity UI. These categories are
 * deliberately not exported through Sandpi's shared Session contract.
 */
export function codexSessionActivityCategory(
  entry: CodexSessionActivityEntry,
): CodexSessionActivityCategory {
  return codexSessionActivityCategories(entry)[0]!;
}

export function selectCodexSessionActivity(
  projection: CodexConversationProjection,
  filter: CodexSessionActivityFilter = "all",
  rolloutActivity?: CodexRolloutActivityFeed,
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
      codexSessionActivityCategories(entry).includes(filter)
    ) {
      group.entries.push(entry);
    }
  }

  const nativeIdsByTurn = new Map<string, Set<string>>();
  for (const entry of projection.entries) {
    if (entry.kind === "message") continue;
    const ids = nativeIdsByTurn.get(entry.turnId) ?? new Set<string>();
    ids.add(entry.id);
    nativeIdsByTurn.set(entry.turnId, ids);
  }
  for (const entry of rolloutActivity?.records ?? []) {
    if (
      nativeIdsByTurn.get(entry.turnId)?.has(entry.callId) ||
      nativeIdsByTurn.get(entry.turnId)?.has(entry.id)
    ) {
      continue;
    }
    const group = turns.get(entry.turnId) ?? {
      turnId: entry.turnId,
      ordinal: nextOrdinal,
      entries: [],
    };
    if (!turns.has(entry.turnId)) nextOrdinal += 1;
    turns.set(entry.turnId, group);
    if (
      filter === "all" ||
      codexSessionActivityCategories(entry).includes(filter)
    ) {
      group.entries.push(entry);
    }
  }

  for (const turn of turns.values()) {
    // Array.sort is stable: native Thread items keep their app-server order
    // when historical snapshots expose only a shared Turn timestamp, while
    // rollout items with precise timestamps still interleave chronologically.
    turn.entries.sort((left, right) => left.createdAt - right.createdAt);
  }

  return [...turns.values()].filter((turn) => turn.entries.length > 0);
}

export function summarizeCodexSessionActivity(
  projection: CodexConversationProjection,
  rolloutActivity?: CodexRolloutActivityFeed,
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
    for (const category of codexSessionActivityCategories(entry)) {
      summary[category] += 1;
    }
  }
  const nativeIdsByTurn = new Map<string, Set<string>>();
  for (const entry of projection.entries) {
    if (entry.kind === "message") continue;
    const ids = nativeIdsByTurn.get(entry.turnId) ?? new Set<string>();
    ids.add(entry.id);
    nativeIdsByTurn.set(entry.turnId, ids);
  }
  for (const entry of rolloutActivity?.records ?? []) {
    if (
      nativeIdsByTurn.get(entry.turnId)?.has(entry.callId) ||
      nativeIdsByTurn.get(entry.turnId)?.has(entry.id)
    ) {
      continue;
    }
    total += 1;
    for (const category of codexSessionActivityCategories(entry)) {
      summary[category] += 1;
    }
  }

  return { total, ...summary };
}
