import { createId } from "@/lib/id";
import { toUnixTimestamp, type UnixTimestamp } from "@/lib/time";

import type {
  CodexComposerImage,
  CodexComposerLocalImage,
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
  /** Native Codex Turn ID used by Turn-level actions such as fork. */
  turnId: string;
  /** Native client correlation ID, present on Codex user messages. */
  clientId?: string | null;
  role: "user" | "assistant";
  content: string;
  createdAt: UnixTimestamp;
  phase?: "commentary" | "final_answer" | null;
  streaming?: boolean;
  attachments?: CodexComposerImage[];
  localImages?: CodexComposerLocalImage[];
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

interface CodexNativeToolActivityBase {
  id: string;
  turnId: string;
  createdAt: UnixTimestamp;
  status: CodexActivityStatus;
}

export interface CodexMcpToolCallActivityView
  extends CodexNativeToolActivityBase {
  kind: "mcpToolCall";
  server: string;
  tool: string;
  appName: string | null;
  arguments: unknown;
  result: unknown | null;
  error: string | null;
  durationMs: number | null;
}

export interface CodexDynamicToolCallActivityView
  extends CodexNativeToolActivityBase {
  kind: "dynamicToolCall";
  namespace: string | null;
  tool: string;
  arguments: unknown;
  contentItems: unknown[] | null;
  success: boolean | null;
  durationMs: number | null;
}

export interface CodexWebSearchActivityView
  extends CodexNativeToolActivityBase {
  kind: "webSearch";
  query: string;
  action: Extract<CodexThreadItem, { type: "webSearch" }>["action"];
}

export interface CodexCollabAgentToolCallActivityView
  extends CodexNativeToolActivityBase {
  kind: "collabAgentToolCall";
  tool: Extract<
    CodexThreadItem,
    { type: "collabAgentToolCall" }
  >["tool"];
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
}

export interface CodexSubAgentActivityView
  extends CodexNativeToolActivityBase {
  kind: "subAgentActivity";
  activityKind: Extract<
    CodexThreadItem,
    { type: "subAgentActivity" }
  >["kind"];
  agentThreadId: string;
  agentPath: string;
}

export interface CodexImageGenerationActivityView
  extends CodexNativeToolActivityBase {
  kind: "imageGeneration";
  revisedPrompt: string | null;
  savedPath?: string;
}

export type CodexNativeToolActivityView =
  | CodexMcpToolCallActivityView
  | CodexDynamicToolCallActivityView
  | CodexWebSearchActivityView
  | CodexCollabAgentToolCallActivityView
  | CodexSubAgentActivityView
  | CodexImageGenerationActivityView;

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
  | CodexNativeToolActivityView
  | CodexNativeItemActivityView
  | CodexTurnResultView;

export interface CodexActiveTurnView {
  turnId: string;
  startedAt: UnixTimestamp;
  state:
    | "submitting"
    | "working"
    | "thinking"
    | "responding"
    | "runningCommand"
    | "waitingForCommand"
    | "editingFiles";
  detail?: string;
}

export interface CodexTurnView {
  turnId: string;
  status: CodexTurn["status"];
  startedAt: UnixTimestamp;
  completedAt: UnixTimestamp | null;
  durationMs: number | null;
}

export interface CodexConversationProjection {
  entries: CodexTimelineEntry[];
  turns: CodexTurnView[];
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
  completedAt: UnixTimestamp | null;
  durationMs: number | null;
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

function activeItemDetail(item: CodexThreadItem) {
  if (item.type === "reasoning") {
    return item.summary.join("\n").trim().slice(0, 2_000) || undefined;
  }
  if (item.type === "plan") {
    return item.text.trim().slice(0, 2_000) || undefined;
  }
  if (item.type === "mcpToolCall") {
    return [item.appContext?.appName ?? item.server, item.tool]
      .filter(Boolean)
      .join(" · ");
  }
  if (item.type === "dynamicToolCall") {
    return [item.namespace, item.tool].filter(Boolean).join(" · ");
  }
  if (item.type === "webSearch") {
    return item.query;
  }
  if (item.type === "collabAgentToolCall") {
    return item.tool;
  }
  if (item.type === "subAgentActivity") {
    return item.agentPath;
  }
  if (item.type === "imageGeneration") {
    return item.revisedPrompt ?? undefined;
  }
  return undefined;
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
  const localImages = item.content.flatMap(
    (input, index): CodexComposerLocalImage[] => {
      if (input.type !== "localImage") return [];
      const filePath = input.path;
      return [
        {
          id: `${item.id}-local-image-${index}`,
          name: filePath.split("/").at(-1) || "image",
          path: filePath,
          kind: "localImage",
          source: filePath.startsWith("/workspace/.sandpi/uploads/")
            ? "upload"
            : "workspace",
        },
      ];
    },
  );
  return {
    kind: "message",
    id: item.id,
    turnId,
    clientId: item.clientId,
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
    localImages: localImages.length ? localImages : undefined,
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
  let projectedThreadStatus = thread?.status;

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
      completedAt: null,
      durationMs: null,
      sequence,
      activeItems: new Map(),
    };
    turns.set(turnId, created);
    return created;
  };

  const finishProjectedTurn = (
    state: TurnState,
    status: Exclude<CodexTurn["status"], "inProgress">,
    completedAt: UnixTimestamp,
    detail?: string,
  ) => {
    state.status = status;
    state.completedAt ??= completedAt;
    state.durationMs ??= Math.max(
      0,
      (state.completedAt - state.startedAt) * 1_000,
    );
    state.sequence = ++projectionSequence;
    state.activeItems.clear();
    for (const entry of entries) {
      if (entry.turnId !== state.id) continue;
      if (entry.kind === "message" && entry.role === "assistant") {
        if (entry.streaming) upsert({ ...entry, streaming: false });
        continue;
      }
      if ("status" in entry && entry.status === "running") {
        upsert({
          ...entry,
          status:
            status === "failed"
              ? "failed"
              : status === "interrupted"
                ? "interrupted"
                : "completed",
        });
      }
    }
    if (status === "failed" || status === "interrupted") {
      const existingResultIndex = entryIndex.get(`turn-result:${state.id}`);
      const existingResult =
        existingResultIndex === undefined
          ? undefined
          : entries[existingResultIndex];
      upsert({
        kind: "turnResult",
        id: `turn-result:${state.id}`,
        turnId: state.id,
        createdAt: state.completedAt,
        status,
        detail:
          detail ??
          (existingResult?.kind === "turnResult"
            ? existingResult.detail
            : undefined),
      });
    }
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
    if (item.type === "mcpToolCall") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "mcpToolCall",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "mcpToolCall" ? existing.createdAt : createdAt,
        status: activityStatus(item.status, turnStatus),
        server: item.server,
        tool: item.tool,
        appName: item.appContext?.appName ?? null,
        arguments: item.arguments,
        result: item.result,
        error: item.error?.message ?? null,
        durationMs: item.durationMs,
      });
      return;
    }
    if (item.type === "dynamicToolCall") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "dynamicToolCall",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "dynamicToolCall"
            ? existing.createdAt
            : createdAt,
        status: activityStatus(item.status, turnStatus),
        namespace: item.namespace,
        tool: item.tool,
        arguments: item.arguments,
        contentItems: item.contentItems,
        success: item.success,
        durationMs: item.durationMs,
      });
      return;
    }
    if (item.type === "webSearch") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "webSearch",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "webSearch" ? existing.createdAt : createdAt,
        status: nativeItemStatus(
          item as unknown as Record<string, unknown>,
          turnStatus,
          streaming,
        ),
        query: item.query,
        action: item.action,
      });
      return;
    }
    if (item.type === "collabAgentToolCall") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "collabAgentToolCall",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "collabAgentToolCall"
            ? existing.createdAt
            : createdAt,
        status: activityStatus(item.status, turnStatus),
        tool: item.tool,
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        prompt: item.prompt,
      });
      return;
    }
    if (item.type === "subAgentActivity") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "subAgentActivity",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "subAgentActivity"
            ? existing.createdAt
            : createdAt,
        status:
          item.kind === "interrupted"
            ? "interrupted"
            : nativeItemStatus(
                item as unknown as Record<string, unknown>,
                turnStatus,
                streaming,
              ),
        activityKind: item.kind,
        agentThreadId: item.agentThreadId,
        agentPath: item.agentPath,
      });
      return;
    }
    if (item.type === "imageGeneration") {
      const existingIndex = entryIndex.get(item.id);
      const existing =
        existingIndex === undefined ? undefined : entries[existingIndex];
      upsert({
        kind: "imageGeneration",
        id: item.id,
        turnId,
        createdAt:
          existing?.kind === "imageGeneration"
            ? existing.createdAt
            : createdAt,
        status: nativeItemStatus(
          item as unknown as Record<string, unknown>,
          turnStatus,
          streaming,
        ),
        revisedPrompt: item.revisedPrompt,
        ...(item.savedPath ? { savedPath: item.savedPath } : {}),
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
    state.completedAt = turn.completedAt;
    state.durationMs = turn.durationMs;
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
          detail: activeItemDetail(item),
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
      projectedThreadStatus = { type: "active", activeFlags: [] };
      const state = ensureTurn(
        turn.id,
        turn.startedAt ?? event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      state.status = "inProgress";
      state.startedAt = turn.startedAt ?? event.receivedAt;
      state.completedAt = null;
      state.durationMs = null;
      state.sequence = projectionSequence;
      for (const item of turn.items) {
        upsertItem(item, turn.id, state.startedAt, "inProgress", true);
      }
      continue;
    }

    if (notification.method === "thread/status/changed") {
      projectedThreadStatus = notification.params.status;
      continue;
    }

    if (notification.method === "error") {
      const { error, turnId, willRetry } = notification.params;
      if (!willRetry) {
        const state = ensureTurn(
          turnId,
          event.receivedAt,
          "inProgress",
          projectionSequence,
        );
        finishProjectedTurn(state, "failed", event.receivedAt, error.message);
        projectedThreadStatus = { type: "systemError" };
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
          detail: activeItemDetail(item),
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

    if (notification.method === "item/reasoning/textDelta") {
      const { itemId, turnId } = notification.params;
      const state = ensureTurn(
        turnId,
        event.receivedAt,
        "inProgress",
        projectionSequence,
      );
      const active = state.activeItems.get(itemId) ?? {
        id: itemId,
        type: "reasoning" as const,
        sequence: projectionSequence,
      };
      // Native reasoning text is private model state. Keep the item active
      // without projecting the delta into either conversation or Activity UI.
      active.sequence = projectionSequence;
      state.activeItems.set(itemId, active);
      continue;
    }

    if (
      notification.method === "item/plan/delta" ||
      notification.method === "item/reasoning/summaryTextDelta"
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
      if (turn.status === "failed") {
        projectedThreadStatus = { type: "systemError" };
      } else if (projectedThreadStatus?.type !== "systemError") {
        projectedThreadStatus = { type: "idle" };
      }
    }
  }

  const newestTurn = [...turns.values()].sort(
    (left, right) => right.sequence - left.sequence,
  )[0];
  if (newestTurn && projectedThreadStatus?.type === "systemError") {
    finishProjectedTurn(
      newestTurn,
      "failed",
      newestTurn.completedAt ?? newestTurn.startedAt,
    );
  } else if (
    newestTurn?.status === "inProgress" &&
    (projectedThreadStatus?.type === "idle" ||
      projectedThreadStatus?.type === "notLoaded")
  ) {
    // Thread status is authoritative for whether work is still active. This
    // fallback clears a stale spinner when a terminal turn notification was
    // missed; a replacement native snapshot supplies the exact final state.
    finishProjectedTurn(newestTurn, "completed", newestTurn.startedAt);
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

  return {
    entries,
    turns: [...turns.values()].map((turn) => ({
      turnId: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
    })),
    activeTurn,
  };
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
