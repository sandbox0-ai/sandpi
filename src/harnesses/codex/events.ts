import { createId } from "@/lib/id";
import { toUnixTimestamp, type UnixTimestamp } from "@/lib/time";

import type {
  CodexComposerImage,
  CodexEventEnvelope,
  CodexFileUpdateChange,
  CodexHarnessState,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
  CodexUserInput,
} from "./types";

export type CodexActivityStatus =
  | "running"
  | "completed"
  | "failed"
  | "declined"
  | "interrupted";

export interface CodexDiffView {
  file: string;
  kind: "add" | "delete" | "update";
  movePath?: string;
  additions: number;
  deletions: number;
}

export interface CodexMessageView {
  kind: "message";
  id: string;
  /** Native Codex Turn ID used by edit, delete, and fork actions. */
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: UnixTimestamp;
  phase?: "commentary" | "final_answer" | null;
  streaming?: boolean;
  attachments?: CodexComposerImage[];
}

export interface CodexCommandActivityView {
  kind: "command";
  id: string;
  turnId: string;
  createdAt: UnixTimestamp;
  status: CodexActivityStatus;
  command: string;
  cwd: string;
  output: string;
  outputTruncated: boolean;
  exitCode: number | null;
  durationMs: number | null;
  exploration: boolean;
  waitingForProcess: boolean;
}

export interface CodexFileChangeActivityView {
  kind: "fileChange";
  id: string;
  turnId: string;
  createdAt: UnixTimestamp;
  status: CodexActivityStatus;
  changes: CodexDiffView[];
  output: string;
}

/**
 * Codex-owned fallback for native ThreadItem variants that do not yet have a
 * richer Sandpi renderer. Keeping the native item type visible is deliberate:
 * other harnesses must define their own activity vocabulary and interaction.
 */
export interface CodexNativeItemActivityView {
  kind: "nativeItem";
  id: string;
  turnId: string;
  createdAt: UnixTimestamp;
  status: CodexActivityStatus;
  itemType: string;
  detail?: string;
}

export interface CodexTurnResultView {
  kind: "turnResult";
  id: string;
  turnId: string;
  createdAt: UnixTimestamp;
  status: "failed" | "interrupted";
  detail?: string;
}

export type CodexTimelineEntry =
  | CodexMessageView
  | CodexCommandActivityView
  | CodexFileChangeActivityView
  | CodexNativeItemActivityView
  | CodexTurnResultView;

export interface CodexActiveTurnView {
  turnId: string;
  startedAt: UnixTimestamp;
  state:
    | "working"
    | "thinking"
    | "responding"
    | "runningCommand"
    | "waitingForCommand"
    | "editingFiles";
  detail?: string;
}

export interface CodexConversationProjection {
  entries: CodexTimelineEntry[];
  activeTurn?: CodexActiveTurnView;
}

/** Maximum native notification suffix replayed over one Thread snapshot. */
export const MAX_CODEX_LIVE_SUFFIX_EVENTS = 256;

export function shouldRefreshCodexNativeSnapshot(liveEventCount: number) {
  return liveEventCount >= MAX_CODEX_LIVE_SUFFIX_EVENTS;
}

interface MockCodexCommand {
  command: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface MockCodexTurnInput {
  content: string;
  images?: CodexComposerImage[];
  assistantText: string;
  createdAt: UnixTimestamp;
  commands?: MockCodexCommand[];
  changes?: CodexFileUpdateChange[];
}

interface ActiveItem {
  id: string;
  type: string;
  sequence: number;
  waitingForProcess?: boolean;
  detail?: string;
}

interface TurnState {
  id: string;
  status: CodexTurn["status"];
  startedAt: UnixTimestamp;
  sequence: number;
  activeItems: Map<string, ActiveItem>;
}

function asUnixTime(milliseconds: number, fallback: UnixTimestamp) {
  return Number.isFinite(milliseconds) ? milliseconds / 1_000 : fallback;
}

function eventTimestamp(event: CodexEventEnvelope, milliseconds?: number) {
  return milliseconds === undefined
    ? event.receivedAt
    : asUnixTime(milliseconds, event.receivedAt);
}

const MAX_PROJECTED_COMMAND_OUTPUT_CHARS = 32 * 1024;

function activityStatus(
  status: "inProgress" | "completed" | "failed" | "declined",
  turnStatus?: CodexTurn["status"],
): CodexActivityStatus {
  if (status !== "inProgress") return status;
  if (turnStatus === "interrupted") return "interrupted";
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "completed") return "completed";
  return "running";
}

function stringField(
  item: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function nativeItemDetail(item: Record<string, unknown>) {
  if (item.type === "reasoning") {
    // Codex exposes a user-facing reasoning summary separately from private
    // reasoning content. The fallback must never turn the latter into UI text.
    const summary = Array.isArray(item.summary)
      ? item.summary.filter((part): part is string => typeof part === "string")
      : [];
    return summary.join("\n").trim().slice(0, 2_000) || undefined;
  }
  if (item.type === "plan") {
    return stringField(item, "text")?.slice(0, 2_000);
  }

  const direct = stringField(
    item,
    "description",
    "message",
    "query",
    "path",
    "name",
  );
  if (direct) return direct.slice(0, 2_000);

  const server = stringField(item, "server", "serverName");
  const namespace = stringField(item, "namespace");
  const tool = stringField(item, "tool", "toolName", "name");
  const toolLabel = [server ?? namespace, tool].filter(Boolean).join(" · ");
  if (toolLabel) return toolLabel.slice(0, 2_000);

  const agentPath = stringField(item, "agentPath", "agentId");
  return agentPath?.slice(0, 2_000);
}

function nativeItemStatus(
  item: Record<string, unknown>,
  turnStatus: CodexTurn["status"],
  streaming: boolean,
): CodexActivityStatus {
  const status = item.status;
  if (
    status === "inProgress" ||
    status === "completed" ||
    status === "failed" ||
    status === "declined"
  ) {
    return activityStatus(status, turnStatus);
  }
  if (status === "interrupted" || status === "cancelled" || status === "canceled") {
    return "interrupted";
  }
  if (status === "success" || status === "succeeded") return "completed";
  if (status === "error") return "failed";
  if (turnStatus === "interrupted") return "interrupted";
  if (turnStatus === "failed") return "failed";
  return streaming && turnStatus === "inProgress" ? "running" : "completed";
}

function boundedCommandOutput(output: string | null | undefined) {
  const value = output ?? "";
  if (value.length <= MAX_PROJECTED_COMMAND_OUTPUT_CHARS) {
    return { output: value, outputTruncated: false };
  }
  const headLength = Math.floor(MAX_PROJECTED_COMMAND_OUTPUT_CHARS / 4);
  const tailLength = MAX_PROJECTED_COMMAND_OUTPUT_CHARS - headLength;
  return {
    output: `${value.slice(0, headLength)}\n… output truncated …\n${value.slice(-tailLength)}`,
    outputTruncated: true,
  };
}

function diffView(change: CodexFileUpdateChange): CodexDiffView {
  const lines = change.diff.split("\n");
  const contentLineCount = change.diff
    ? lines.length - (change.diff.endsWith("\n") ? 1 : 0)
    : 0;
  return {
    file: change.path,
    kind: change.kind.type,
    ...(change.kind.type === "update" && change.kind.move_path
      ? { movePath: change.kind.move_path }
      : {}),
    additions:
      change.kind.type === "add"
        ? contentLineCount
        : lines.filter(
            (line) => line.startsWith("+") && !line.startsWith("+++"),
          ).length,
    deletions:
      change.kind.type === "delete"
        ? contentLineCount
        : lines.filter(
            (line) => line.startsWith("-") && !line.startsWith("---"),
          ).length,
  };
}

function userMessageView(
  item: Extract<CodexThreadItem, { type: "userMessage" }>,
  turnId: string,
  createdAt: UnixTimestamp,
): CodexMessageView {
  const attachments = item.content
    .filter(
      (input): input is Extract<CodexUserInput, { type: "image" }> =>
        input.type === "image",
    )
    .map((input, index) => ({
      id: `${item.id}-image-${index}`,
      name: `pasted-image-${index + 1}`,
      mimeType: input.url.slice(5, input.url.indexOf(";")) || "image/*",
      sizeBytes: 0,
      previewUrl: input.url,
    }));
  return {
    kind: "message",
    id: item.id,
    turnId,
    role: "user",
    content: item.content
      .filter(
        (input): input is Extract<CodexUserInput, { type: "text" }> =>
          input.type === "text",
      )
      .map((input) => input.text)
      .join("\n"),
    createdAt,
    attachments: attachments.length ? attachments : undefined,
  };
}

/**
 * Project the Codex-native `thread/read(includeTurns=true)` response and the
 * bounded live notification suffix into Codex-specific UI rows. The Thread is
 * always the base authority: notifications are never a persisted transcript
 * and are discarded whenever a new snapshot arrives.
 */
export function projectCodexTimeline(
  thread: CodexThread | undefined,
  notifications: CodexEventEnvelope[] = [],
): CodexConversationProjection {
  const entries: CodexTimelineEntry[] = [];
  const entryIndex = new Map<string, number>();
  const turns = new Map<string, TurnState>();
  const seenSequences = new Set<number>();
  let projectionSequence = 0;

  const upsert = (entry: CodexTimelineEntry) => {
    const index = entryIndex.get(entry.id);
    if (index === undefined) {
      entryIndex.set(entry.id, entries.length);
      entries.push(entry);
      return;
    }
    entries[index] = { ...entries[index], ...entry } as CodexTimelineEntry;
  };

  const ensureTurn = (
    turnId: string,
    startedAt: UnixTimestamp,
    status: CodexTurn["status"] = "inProgress",
    sequence = ++projectionSequence,
  ) => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const created: TurnState = {
      id: turnId,
      status,
      startedAt,
      sequence,
      activeItems: new Map(),
    };
    turns.set(turnId, created);
    return created;
  };

  const upsertAssistant = (
    itemId: string,
    turnId: string,
    text: string,
    createdAt: UnixTimestamp,
    streaming: boolean,
    phase?: "commentary" | "final_answer" | null,
  ) => {
    const existingIndex = entryIndex.get(itemId);
    const existing =
      existingIndex === undefined ? undefined : entries[existingIndex];
    upsert({
      kind: "message",
      id: itemId,
      turnId,
      role: "assistant",
      content: text,
      createdAt:
        existing?.kind === "message" ? existing.createdAt : createdAt,
      phase:
        phase ?? (existing?.kind === "message" ? existing.phase : undefined),
      streaming,
    });
  };

  const upsertItem = (
    item: CodexThreadItem,
    turnId: string,
    createdAt: UnixTimestamp,
    turnStatus: CodexTurn["status"],
    streaming: boolean,
  ) => {
    if (item.type === "userMessage") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      const message = userMessageView(item, turnId, createdAt);
      upsert({
        ...message,
        createdAt:
          existing?.kind === "message" ? existing.createdAt : createdAt,
      });
      return;
    }
    if (item.type === "agentMessage") {
      upsertAssistant(
        item.id,
        turnId,
        item.text,
        createdAt,
        streaming,
        item.phase,
      );
      return;
    }
    if (item.type === "commandExecution") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "command",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "command" ? existing.createdAt : createdAt,
        status: activityStatus(item.status, turnStatus),
        command: item.command,
        cwd: item.cwd,
        ...boundedCommandOutput(item.aggregatedOutput),
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        exploration:
          item.commandActions.length > 0 &&
          item.commandActions.every((action) => action.type !== "unknown"),
        waitingForProcess:
          existing?.kind === "command" ? existing.waitingForProcess : false,
      });
      return;
    }
    if (item.type === "fileChange") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "fileChange",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "fileChange" ? existing.createdAt : createdAt,
        status: activityStatus(item.status, turnStatus),
        changes: item.changes.map(diffView),
        output: existing?.kind === "fileChange" ? existing.output : "",
      });
      return;
    }

    // JSON received from app-server can contain newer ThreadItem variants than
    // the schema pinned in this client. Render a compact Codex-native row so a
    // tool/review/compaction activity never silently disappears while the
    // richer variant-specific renderer catches up.
    const nativeItem = item as unknown as Record<string, unknown>;
    const itemType = stringField(nativeItem, "type") ?? "unknown";
    const itemId = stringField(nativeItem, "id") ??
      `native-item:${turnId}:${itemType}:${createdAt}`;
    const existingIndex = entryIndex.get(itemId);
    const existing = existingIndex === undefined ? undefined : entries[existingIndex];
    upsert({
      kind: "nativeItem",
      id: itemId,
      turnId,
      createdAt:
        existing?.kind === "nativeItem" ? existing.createdAt : createdAt,
      status: nativeItemStatus(nativeItem, turnStatus, streaming),
      itemType,
      detail: nativeItemDetail(nativeItem),
    });
  };

  const reconcileTurn = (turn: CodexTurn, fallbackAt: UnixTimestamp) => {
    const startedAt = turn.startedAt ?? fallbackAt;
    const state = ensureTurn(turn.id, startedAt, turn.status);
    state.status = turn.status;
    state.startedAt = startedAt;
    state.sequence = ++projectionSequence;
    const lastItem = turn.items.at(-1);
    turn.items.forEach((item) => {
      const sequence = ++projectionSequence;
      const isLiveTail =
        turn.status === "inProgress" &&
        (item.type === "commandExecution" || item.type === "fileChange"
          ? item.status === "inProgress"
          : item.id === lastItem?.id && item.type !== "userMessage");
      if (isLiveTail) {
        state.activeItems.set(item.id, {
          id: item.id,
          type: item.type,
          sequence,
          detail:
            item.type === "reasoning"
              ? item.summary.join("\n") || item.content.join("\n")
              : item.type === "plan"
                ? item.text
                : undefined,
        });
      }
      upsertItem(item, turn.id, startedAt, turn.status, isLiveTail);
    });
    if (turn.status !== "inProgress") {
      state.activeItems.clear();
      for (const entry of entries) {
        if (
          entry.turnId === turn.id &&
          entry.kind === "message" &&
          entry.role === "assistant" &&
          entry.streaming
        ) {
          upsert({ ...entry, streaming: false });
        }
      }
    }
    if (turn.status === "failed" || turn.status === "interrupted") {
      upsert({
        kind: "turnResult",
        id: `turn-result:${turn.id}`,
        turnId: turn.id,
        createdAt: turn.completedAt ?? startedAt,
        status: turn.status,
        detail: turn.error?.message,
      });
    }
  };

  if (thread) {
    const fallbackAt = thread.createdAt ?? 0;
    for (const turn of thread.turns) reconcileTurn(turn, fallbackAt);
  }

  // Live notification order belongs only to this SSE connection. Duplicate
  // envelopes can occur during network retry and are ignored in-memory.
  for (const event of notifications) {
    if (seenSequences.has(event.sequence)) continue;
    seenSequences.add(event.sequence);
    projectionSequence += 1;
    const notification = event.notification;

    if (notification.method === "turn/started") {
      const { turn } = notification.params;
      const state = ensureTurn(
        turn.id,
        turn.startedAt ?? event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      state.status = "inProgress";
      state.startedAt = turn.startedAt ?? event.receivedAt;
      state.sequence = projectionSequence;
      for (const item of turn.items) {
        upsertItem(item, turn.id, state.startedAt, "inProgress", true);
      }
      continue;
    }

    if (notification.method === "item/started") {
      const { item, turnId, startedAtMs } = notification.params;
      const createdAt = eventTimestamp(event, startedAtMs);
      const state = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      if (item.type !== "userMessage") {
        state.activeItems.set(item.id, {
          id: item.id,
          type: item.type,
          sequence: projectionSequence,
          detail:
            item.type === "reasoning"
              ? item.summary.join("\n") || item.content.join("\n")
              : item.type === "plan"
                ? item.text
                : undefined,
        });
      }
      upsertItem(item, turnId, createdAt, "inProgress", true);
      continue;
    }

    if (notification.method === "item/agentMessage/delta") {
      const { itemId, turnId, delta } = notification.params;
      const index = entryIndex.get(itemId);
      const existing = index === undefined ? undefined : entries[index];
      upsertAssistant(
        itemId,
        turnId,
        `${existing?.kind === "message" ? existing.content : ""}${delta}`,
        event.receivedAt,
        true,
      );
      const state = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      state.activeItems.set(itemId, {
        id: itemId,
        type: "agentMessage",
        sequence: projectionSequence,
      });
      continue;
    }

    if (
      notification.method === "item/plan/delta" ||
      notification.method === "item/reasoning/summaryTextDelta" ||
      notification.method === "item/reasoning/textDelta"
    ) {
      const { itemId, turnId, delta } = notification.params;
      const state = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      const active = state.activeItems.get(itemId) ?? {
        id: itemId,
        type:
          notification.method === "item/plan/delta"
            ? ("plan" as const)
            : ("reasoning" as const),
        sequence: projectionSequence,
      };
      active.detail = `${active.detail ?? ""}${delta}`;
      active.sequence = projectionSequence;
      state.activeItems.set(itemId, active);
      const index = entryIndex.get(itemId);
      const existing = index === undefined ? undefined : entries[index];
      if (existing?.kind === "nativeItem") {
        upsert({
          ...existing,
          status: "running",
          detail: `${existing.detail ?? ""}${delta}`.slice(0, 2_000),
        });
      }
      continue;
    }

    if (notification.method === "item/reasoning/summaryPartAdded") {
      const { itemId, turnId } = notification.params;
      const state = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      state.activeItems.set(itemId, {
        ...(state.activeItems.get(itemId) ?? {
          id: itemId,
          type: "reasoning" as const,
        }),
        sequence: projectionSequence,
      });
      continue;
    }

    if (notification.method === "item/commandExecution/outputDelta") {
      const { itemId, turnId, delta } = notification.params;
      const index = entryIndex.get(itemId);
      const existing = index === undefined ? undefined : entries[index];
      if (existing?.kind === "command") {
        upsert({
          ...existing,
          ...boundedCommandOutput(`${existing.output}${delta}`),
          status: "running",
        });
      }
      const active = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      ).activeItems.get(itemId);
      if (active) active.sequence = projectionSequence;
      continue;
    }

    if (notification.method === "item/commandExecution/terminalInteraction") {
      const { itemId, turnId, stdin } = notification.params;
      const waitingForProcess = stdin.length === 0;
      const index = entryIndex.get(itemId);
      const existing = index === undefined ? undefined : entries[index];
      if (existing?.kind === "command") {
        upsert({ ...existing, waitingForProcess });
      }
      const active = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      ).activeItems.get(itemId);
      if (active) {
        active.waitingForProcess = waitingForProcess;
        active.sequence = projectionSequence;
      }
      continue;
    }

    if (notification.method === "item/fileChange/patchUpdated") {
      const { itemId, turnId, changes } = notification.params;
      const index = entryIndex.get(itemId);
      const existing = index === undefined ? undefined : entries[index];
      upsert({
        kind: "fileChange",
        id: itemId,
        turnId,
        createdAt:
          existing?.kind === "fileChange"
            ? existing.createdAt
            : event.receivedAt,
        status: "running",
        changes: changes.map(diffView),
        output: existing?.kind === "fileChange" ? existing.output : "",
      });
      ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      ).activeItems.set(itemId, {
        id: itemId,
        type: "fileChange",
        sequence: projectionSequence,
      });
      continue;
    }

    if (notification.method === "item/fileChange/outputDelta") {
      const { itemId, delta } = notification.params;
      const index = entryIndex.get(itemId);
      const existing = index === undefined ? undefined : entries[index];
      if (existing?.kind === "fileChange") {
        upsert({ ...existing, output: `${existing.output}${delta}`.slice(-8_192) });
      }
      continue;
    }

    if (notification.method === "item/completed") {
      const { item, turnId, completedAtMs } = notification.params;
      const state = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      state.activeItems.delete(item.id);
      upsertItem(
        item,
        turnId,
        eventTimestamp(event, completedAtMs),
        "inProgress",
        false,
      );
      continue;
    }

    if (notification.method === "turn/completed") {
      const { turn } = notification.params;
      reconcileTurn(turn, event.receivedAt);
    }
  }

  const activeState = [...turns.values()]
    .filter((turn) => turn.status === "inProgress")
    .sort((left, right) => right.sequence - left.sequence)[0];
  let activeTurn: CodexActiveTurnView | undefined;
  if (activeState) {
    const activeItem = [...activeState.activeItems.values()].sort(
      (left, right) => right.sequence - left.sequence,
    )[0];
    const state: CodexActiveTurnView["state"] =
      activeItem?.type === "commandExecution"
        ? activeItem.waitingForProcess
          ? "waitingForCommand"
          : "runningCommand"
        : activeItem?.type === "fileChange"
          ? "editingFiles"
          : activeItem?.type === "reasoning" || activeItem?.type === "plan"
            ? "thinking"
            : activeItem?.type === "agentMessage"
              ? "responding"
              : "working";
    activeTurn = {
      turnId: activeState.id,
      startedAt: activeState.startedAt,
      state,
      detail: activeItem?.detail?.trim() || undefined,
    };
  }

  return { entries, activeTurn };
}

export function projectCodexConversation(
  thread: CodexThread | undefined,
  notifications: CodexEventEnvelope[] = [],
): CodexMessageView[] {
  return projectCodexTimeline(thread, notifications).entries.filter(
    (entry): entry is CodexMessageView => entry.kind === "message",
  );
}

/** Build a native mock Thread for reducer and SSE fixture tests. */
export function createMockCodexTurn(input: MockCodexTurnInput): CodexTurn {
  const userItem: CodexThreadItem = {
    type: "userMessage",
    id: createId("item", 10),
    clientId: null,
    content: [
      ...(input.content
        ? [
            {
              type: "text" as const,
              text: input.content,
              text_elements: [] as [],
            },
          ]
        : []),
      ...(input.images ?? []).map((image) => ({
        type: "image" as const,
        url: image.previewUrl,
        detail: "auto" as const,
      })),
    ],
  };
  const commands: CodexThreadItem[] = (input.commands ?? []).map((command) => ({
    type: "commandExecution",
    id: createId("item", 10),
    command: command.command,
    cwd: command.cwd ?? "/workspace",
    processId: null,
    source: "agent",
    status: (command.exitCode ?? 0) === 0 ? "completed" : "failed",
    commandActions: [],
    aggregatedOutput: command.output ?? null,
    exitCode: command.exitCode ?? 0,
    durationMs: command.durationMs ?? null,
  }));
  const changes: CodexThreadItem[] = input.changes?.length
    ? [
        {
          type: "fileChange",
          id: createId("item", 10),
          changes: input.changes,
          status: "completed",
        },
      ]
    : [];
  const assistant: CodexThreadItem = {
    type: "agentMessage",
    id: createId("item", 10),
    text: input.assistantText,
    phase: "final_answer",
    memoryCitation: null,
  };
  return {
    id: createId("turn", 10),
    items: [userItem, ...commands, ...changes, assistant],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: input.createdAt,
    completedAt: input.createdAt,
    durationMs: 1,
  };
}

export function createMockCodexThread(
  threadId: string,
  turns: CodexTurn[] = [],
): CodexThread {
  const createdAt = turns[0]?.startedAt ?? toUnixTimestamp(new Date());
  const updatedAt = turns.at(-1)?.completedAt ?? createdAt;
  return {
    id: threadId,
    createdAt,
    updatedAt,
    status: { type: "idle" },
    turns,
  };
}

/**
 * Session DTO fixture. The optional Turn is intentionally ignored here:
 * conversation content belongs in a separate native SSE snapshot, never in
 * `CodingSession.harnessState`.
 */
export function createMockCodexHarnessState(
  threadId: string,
  modelId: string,
  _initialTurn?: MockCodexTurnInput,
): CodexHarnessState {
  void _initialTurn;
  return {
    protocol: "codex-app-server",
    threadId,
    modelId,
    harnessVersion: "mock-codex-cli",
    protocolVersion: "v2",
    historyRevision: 0,
  };
}
