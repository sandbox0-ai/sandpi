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
import {
  codexRolloutActivityFailed,
  displayCodexCommand,
  summarizeCodexRolloutActivity,
} from "./rollout-activity-summary";

export type CodexSessionActivityFilter =
  | "all"
  | "issues"
  | "external"
  | "commands"
  | "files"
  | "agents"
  | "system";

export type CodexSessionActivityCategory = Exclude<
  CodexSessionActivityFilter,
  "all" | "issues"
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

export interface CodexSessionActivityItem {
  entry: CodexSessionActivityEntry;
  relatedEntries: CodexSessionActivityEntry[];
}

export interface CodexSessionActivityActionTurn
  extends Omit<CodexSessionActivityTurn, "entries"> {
  items: CodexSessionActivityItem[];
  nativeRecordCount: number;
}

export interface CodexSessionActivitySummary {
  total: number;
  records: number;
  issues: number;
  external: number;
  commands: number;
  files: number;
  agents: number;
  system: number;
}

export interface CodexSessionActivityPresentation {
  turns: CodexSessionActivityActionTurn[];
  summary: CodexSessionActivitySummary;
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
const CODEX_HIDDEN_ROLLOUT_TOOLS = new Set(["update_plan"]);

function codexRolloutActivityIsVisible(entry: CodexRolloutToolActivity) {
  if (entry.status === "failed") return true;
  const names =
    entry.codeModeTools.length > 0 ? entry.codeModeTools : [entry.name];
  return !(
    names.length > 0 &&
    names.every((name) =>
      CODEX_HIDDEN_ROLLOUT_TOOLS.has(name.split(".").at(-1) ?? name),
    )
  );
}

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

function itemCategories(
  item: CodexSessionActivityItem,
): CodexSessionActivityCategory[] {
  return [
    ...new Set(
      [item.entry, ...item.relatedEntries].flatMap((entry) =>
        codexSessionActivityCategories(entry),
      ),
    ),
  ];
}

export function codexSessionActivityItemHasIssue(
  item: CodexSessionActivityItem,
) {
  return [item.entry, ...item.relatedEntries].some((entry) => {
    if (entry.kind === "rolloutToolCall") {
      return codexRolloutActivityFailed(entry);
    }
    if (entry.kind === "turnResult") return true;
    const failedStatus =
      "status" in entry &&
      (entry.status === "failed" ||
        entry.status === "declined" ||
        entry.status === "interrupted");
    if (entry.kind === "command") {
      return failedStatus || (entry.exitCode ?? 0) !== 0;
    }
    if (entry.kind === "mcpToolCall") return failedStatus || Boolean(entry.error);
    if (entry.kind === "dynamicToolCall") {
      return failedStatus || entry.success === false;
    }
    return failedStatus;
  });
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

function normalizeActivityPath(path: string) {
  return path
    .replace(/^\/workspace\//, "")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function modeledFileSignature(entry: CodexSessionActivityEntry) {
  if (entry.kind !== "fileChange") return null;
  const paths = entry.changes.flatMap((change) => [
    normalizeActivityPath(change.file),
    ...(change.movePath ? [normalizeActivityPath(change.movePath)] : []),
  ]);
  return [...new Set(paths)].sort().join("\n");
}

function modeledCommandSignature(entry: CodexSessionActivityEntry) {
  return entry.kind === "command"
    ? displayCodexCommand(entry.command)
    : null;
}

/**
 * Builds the readable Codex action layer without losing native evidence.
 * Background updates are attached only through explicit native handles, while
 * richer app-server command/file items replace rollout duplicates only when a
 * semantic signature is unique inside the Turn.
 */
export function groupCodexSessionActivityEntries(
  entries: CodexSessionActivityEntry[],
): CodexSessionActivityItem[] {
  const items = entries.map<CodexSessionActivityItem>((entry) => ({
    entry,
    relatedEntries: [],
  }));
  const removed = new Set<number>();
  const rolloutSummaries = entries.map((entry) =>
    entry.kind === "rolloutToolCall"
      ? summarizeCodexRolloutActivity(entry)
      : null,
  );

  const parentByBackgroundHandle = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const summary = rolloutSummaries[index];
    const parent = summary?.followsBackgroundHandle
      ? parentByBackgroundHandle.get(summary.followsBackgroundHandle)
      : undefined;
    if (parent !== undefined && !removed.has(parent)) {
      items[parent]!.relatedEntries.push(entries[index]!);
      removed.add(index);
    }
    if (summary?.startsBackgroundHandle) {
      parentByBackgroundHandle.set(summary.startsBackgroundHandle, index);
    }
  }

  function mergeUniqueSemanticDuplicates(
    modeledSignature: (
      entry: CodexSessionActivityEntry,
      index: number,
    ) => string | null,
    rolloutSignature: (
      entry: CodexSessionActivityEntry,
      index: number,
    ) => string | null,
  ) {
    const modeledBySignature = new Map<string, number[]>();
    const rolloutBySignature = new Map<string, number[]>();
    for (let index = 0; index < entries.length; index += 1) {
      if (removed.has(index)) continue;
      const modeled = modeledSignature(entries[index]!, index);
      if (modeled) {
        modeledBySignature.set(modeled, [
          ...(modeledBySignature.get(modeled) ?? []),
          index,
        ]);
      }
      const rollout = rolloutSignature(entries[index]!, index);
      if (rollout) {
        rolloutBySignature.set(rollout, [
          ...(rolloutBySignature.get(rollout) ?? []),
          index,
        ]);
      }
    }
    for (const [signature, rolloutIndexes] of rolloutBySignature) {
      const modeledIndexes = modeledBySignature.get(signature);
      if (rolloutIndexes.length !== 1 || modeledIndexes?.length !== 1) continue;
      const rolloutIndex = rolloutIndexes[0]!;
      const modeledIndex = modeledIndexes[0]!;
      items[modeledIndex]!.relatedEntries.push(
        items[rolloutIndex]!.entry,
        ...items[rolloutIndex]!.relatedEntries,
      );
      removed.add(rolloutIndex);
    }
  }

  mergeUniqueSemanticDuplicates(
    modeledCommandSignature,
    (entry, index) => {
      if (entry.kind !== "rolloutToolCall") return null;
      const summary = rolloutSummaries[index];
      return summary?.kind === "command" && summary.command
        ? displayCodexCommand(summary.command)
        : null;
    },
  );
  mergeUniqueSemanticDuplicates(modeledFileSignature, (entry, index) => {
    if (entry.kind !== "rolloutToolCall") return null;
    const summary = rolloutSummaries[index];
    if (summary?.kind !== "fileChange" || summary.filePaths.length === 0) {
      return null;
    }
    return [...new Set(summary.filePaths.map(normalizeActivityPath))]
      .sort()
      .join("\n");
  });

  const logicalTime = (item: CodexSessionActivityItem) => {
    if (item.entry.kind !== "command" && item.entry.kind !== "fileChange") {
      return item.entry.createdAt;
    }
    const rolloutTimes = item.relatedEntries
      .filter((entry) => entry.kind === "rolloutToolCall")
      .map((entry) => entry.createdAt);
    return rolloutTimes.length > 0
      ? Math.min(...rolloutTimes)
      : item.entry.createdAt;
  };
  return items
    .filter((_, index) => !removed.has(index))
    .map((item) => ({
      ...item,
      relatedEntries: item.relatedEntries.sort(
        (left, right) => left.createdAt - right.createdAt,
      ),
    }))
    .sort((left, right) => logicalTime(left) - logicalTime(right));
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
      (filter === "issues"
        ? codexSessionActivityItemHasIssue({
            entry,
            relatedEntries: [],
          })
        : codexSessionActivityCategories(entry).includes(filter))
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
    // Plan updates are internal Codex bookkeeping, not useful Session actions.
    // Keep failures inspectable, but omit successful lifecycle-only records.
    if (!codexRolloutActivityIsVisible(entry)) continue;
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
      (filter === "issues"
        ? codexSessionActivityItemHasIssue({
            entry,
            relatedEntries: [],
          })
        : codexSessionActivityCategories(entry).includes(filter))
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

function buildCodexSessionActivityActions(
  projection: CodexConversationProjection,
  rolloutActivity?: CodexRolloutActivityFeed,
): CodexSessionActivityActionTurn[] {
  const turns = selectCodexSessionActivity(projection, "all", rolloutActivity)
    .map((turn) => {
      const items = groupCodexSessionActivityEntries(turn.entries);
      return {
        turnId: turn.turnId,
        ordinal: turn.ordinal,
        turn: turn.turn,
        prompt: turn.prompt,
        items,
        nativeRecordCount: items.reduce(
          (count, item) => count + 1 + item.relatedEntries.length,
          0,
        ),
      };
    })
    .filter((turn) => turn.items.length > 0);
  // Activity is an inspection feed, so expose the latest Turn first while
  // preserving native chronological order inside each Turn.
  return turns.reverse();
}

export function filterCodexSessionActivityActions(
  turns: CodexSessionActivityActionTurn[],
  filter: CodexSessionActivityFilter,
) {
  if (filter === "all") return turns;
  return turns
    .map((turn) => {
      const items = turn.items.filter((item) =>
        filter === "issues"
          ? codexSessionActivityItemHasIssue(item)
          : itemCategories(item).includes(filter),
      );
      return {
        ...turn,
        items,
        nativeRecordCount: items.reduce(
          (count, item) => count + 1 + item.relatedEntries.length,
          0,
        ),
      };
    })
    .filter((turn) => turn.items.length > 0);
}

function summarizeActionTurns(
  turns: CodexSessionActivityActionTurn[],
): CodexSessionActivitySummary {
  const summary: Record<CodexSessionActivityCategory, number> = {
    external: 0,
    commands: 0,
    files: 0,
    agents: 0,
    system: 0,
  };
  let total = 0;
  let records = 0;
  let issues = 0;
  for (const turn of turns) {
    total += turn.items.length;
    records += turn.nativeRecordCount;
    for (const item of turn.items) {
      if (codexSessionActivityItemHasIssue(item)) issues += 1;
      for (const category of itemCategories(item)) {
        summary[category] += 1;
      }
    }
  }
  return { total, records, issues, ...summary };
}

export function projectCodexSessionActivity(
  projection: CodexConversationProjection,
  rolloutActivity?: CodexRolloutActivityFeed,
): CodexSessionActivityPresentation {
  const turns = buildCodexSessionActivityActions(projection, rolloutActivity);
  return {
    turns,
    summary: summarizeActionTurns(turns),
  };
}

export function selectCodexSessionActivityActions(
  projection: CodexConversationProjection,
  filter: CodexSessionActivityFilter = "all",
  rolloutActivity?: CodexRolloutActivityFeed,
): CodexSessionActivityActionTurn[] {
  return filterCodexSessionActivityActions(
    projectCodexSessionActivity(projection, rolloutActivity).turns,
    filter,
  );
}

export function summarizeCodexSessionActivity(
  projection: CodexConversationProjection,
  rolloutActivity?: CodexRolloutActivityFeed,
) {
  return projectCodexSessionActivity(projection, rolloutActivity).summary;
}
