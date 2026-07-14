import { createId } from "@/lib/id";
import { toUnixTimestamp, type UnixTimestamp } from "@/lib/time";

import type {
  CodexComposerImage,
  CodexEventEnvelope,
  CodexFileUpdateChange,
  CodexHarnessState,
  CodexServerNotification,
  CodexThreadItem,
  CodexTurn,
  CodexUserInput,
} from "./types";

export interface CodexToolActivityView {
  id: string;
  label: string;
  detail: string;
  status: "completed" | "running" | "failed";
  duration?: string;
}

export interface CodexDiffView {
  file: string;
  additions: number;
  deletions: number;
  lines: string[];
}

export interface CodexMessageView {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: UnixTimestamp;
  attachments?: CodexComposerImage[];
  activities?: CodexToolActivityView[];
  diff?: CodexDiffView;
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

function asUnixTime(milliseconds: number, fallback: UnixTimestamp) {
  return Number.isFinite(milliseconds) ? milliseconds / 1_000 : fallback;
}

function eventTimestamp(event: CodexEventEnvelope, completedAtMs?: number) {
  return completedAtMs === undefined
    ? event.receivedAt
    : asUnixTime(completedAtMs, event.receivedAt);
}

function durationLabel(durationMs: number | null) {
  if (durationMs === null) {
    return undefined;
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${Math.round(durationMs / 100) / 10}s`;
}

function commandActivity(
  item: Extract<CodexThreadItem, { type: "commandExecution" }>,
): CodexToolActivityView {
  const status =
    item.status === "inProgress"
      ? "running"
      : item.status === "completed"
        ? "completed"
        : "failed";
  return {
    id: item.id,
    label:
      status === "completed"
        ? "Ran command"
        : status === "running"
          ? "Running command"
          : "Command failed",
    detail: item.command,
    status,
    duration: durationLabel(item.durationMs),
  };
}

function fileChangeActivity(
  item: Extract<CodexThreadItem, { type: "fileChange" }>,
): CodexToolActivityView {
  const status =
    item.status === "inProgress"
      ? "running"
      : item.status === "completed"
        ? "completed"
        : "failed";
  return {
    id: item.id,
    label: status === "completed" ? "Applied file changes" : "File change failed",
    detail: `${item.changes.length} ${item.changes.length === 1 ? "file" : "files"}`,
    status,
  };
}

function diffView(change: CodexFileUpdateChange): CodexDiffView {
  const lines = change.diff.split("\n");
  return {
    file: change.path,
    additions: lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length,
    deletions: lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length,
    lines,
  };
}

function userMessageView(
  item: Extract<CodexThreadItem, { type: "userMessage" }>,
  turnId: string,
  createdAt: UnixTimestamp,
): CodexMessageView {
  const attachments = item.content
    .filter((input): input is Extract<CodexUserInput, { type: "image" }> => input.type === "image")
    .map((input, index) => ({
      id: `${item.id}-image-${index}`,
      name: `pasted-image-${index + 1}`,
      mimeType: input.url.slice(5, input.url.indexOf(";")) || "image/*",
      sizeBytes: 0,
      previewUrl: input.url,
    }));
  return {
    id: item.id,
    turnId,
    role: "user",
    content: item.content
      .filter((input): input is Extract<CodexUserInput, { type: "text" }> => input.type === "text")
      .map((input) => input.text)
      .join("\n"),
    createdAt,
    attachments: attachments.length ? attachments : undefined,
  };
}

/**
 * Codex-specific projection from native app-server notifications into this Codex page's view
 * model. Other harnesses must implement their own reducers and must not consume this output.
 */
export function projectCodexConversation(events: CodexEventEnvelope[]): CodexMessageView[] {
  const messages: CodexMessageView[] = [];
  const activitiesByTurn = new Map<string, CodexToolActivityView[]>();
  const diffByTurn = new Map<string, CodexDiffView>();

  for (const event of events) {
    if (event.notification.method !== "item/completed") {
      continue;
    }
    const { item, turnId, completedAtMs } = event.notification.params;
    const createdAt = eventTimestamp(event, completedAtMs);

    if (item.type === "userMessage") {
      messages.push(userMessageView(item, turnId, createdAt));
      continue;
    }
    if (item.type === "commandExecution") {
      const activities = activitiesByTurn.get(turnId) ?? [];
      activities.push(commandActivity(item));
      activitiesByTurn.set(turnId, activities);
      continue;
    }
    if (item.type === "fileChange") {
      const activities = activitiesByTurn.get(turnId) ?? [];
      activities.push(fileChangeActivity(item));
      activitiesByTurn.set(turnId, activities);
      if (item.changes[0] && !diffByTurn.has(turnId)) {
        diffByTurn.set(turnId, diffView(item.changes[0]));
      }
      continue;
    }
    if (item.type === "agentMessage") {
      const activities = activitiesByTurn.get(turnId);
      messages.push({
        id: item.id,
        turnId,
        role: "assistant",
        content: item.text,
        createdAt,
        activities: activities?.length ? activities : undefined,
        diff: diffByTurn.get(turnId),
      });
      activitiesByTurn.delete(turnId);
      diffByTurn.delete(turnId);
    }
  }

  return messages;
}

function turn(id: string, status: CodexTurn["status"], items: CodexThreadItem[], atMs: number) {
  return {
    id,
    items,
    itemsView: "full" as const,
    status,
    error: null,
    startedAt: Math.floor(atMs / 1000),
    completedAt: status === "inProgress" ? null : Math.floor(atMs / 1000),
    durationMs: status === "inProgress" ? null : 1,
  } satisfies CodexTurn;
}

function envelope(
  state: Pick<CodexHarnessState, "harnessVersion" | "protocolVersion">,
  sequence: number,
  receivedAt: UnixTimestamp,
  notification: CodexServerNotification,
): CodexEventEnvelope {
  return {
    harness: "codex",
    harnessVersion: state.harnessVersion,
    protocolVersion: state.protocolVersion,
    sequence,
    receivedAt,
    notification,
  };
}

function completedItemEvents(
  state: Pick<CodexHarnessState, "harnessVersion" | "protocolVersion">,
  startSequence: number,
  receivedAt: UnixTimestamp,
  threadId: string,
  turnId: string,
  item: CodexThreadItem,
  completedAtMs: number,
): CodexEventEnvelope[] {
  return [
    envelope(state, startSequence, receivedAt, {
      method: "item/started",
      params: { item, threadId, turnId, startedAtMs: completedAtMs },
    }),
    envelope(state, startSequence + 1, receivedAt, {
      method: "item/completed",
      params: { item, threadId, turnId, completedAtMs },
    }),
  ];
}

export function createMockCodexTurnEvents(
  state: Pick<
    CodexHarnessState,
    "events" | "harnessVersion" | "protocolVersion" | "threadId"
  >,
  input: MockCodexTurnInput,
): CodexEventEnvelope[] {
  const completedAtMs = Number.isFinite(input.createdAt)
    ? input.createdAt * 1_000
    : Date.now();
  const turnId = createId("turn", 10);
  const userItem: CodexThreadItem = {
    type: "userMessage",
    id: createId("item", 10),
    clientId: null,
    content: [
      ...(input.content
        ? [{ type: "text" as const, text: input.content, text_elements: [] as [] }]
        : []),
      ...(input.images ?? []).map((image) => ({
        type: "image" as const,
        url: image.previewUrl,
        detail: "auto" as const,
      })),
    ],
  };
  const commandItems: CodexThreadItem[] = (input.commands ?? []).map((command) => ({
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
  const fileItem: CodexThreadItem[] = input.changes?.length
    ? [
        {
          type: "fileChange",
          id: createId("item", 10),
          changes: input.changes,
          status: "completed",
        },
      ]
    : [];
  const agentItem: CodexThreadItem = {
    type: "agentMessage",
    id: createId("item", 10),
    text: input.assistantText,
    phase: "final_answer",
    memoryCitation: null,
  };
  const items = [userItem, ...commandItems, ...fileItem, agentItem];
  let sequence = state.events.at(-1)?.sequence ?? 0;
  const events: CodexEventEnvelope[] = [
    envelope(state, ++sequence, input.createdAt, {
      method: "turn/started",
      params: { threadId: state.threadId, turn: turn(turnId, "inProgress", [], completedAtMs) },
    }),
  ];

  for (const item of items) {
    const itemEvents = completedItemEvents(
      state,
      sequence + 1,
      input.createdAt,
      state.threadId,
      turnId,
      item,
      completedAtMs,
    );
    events.push(...itemEvents);
    sequence += itemEvents.length;
  }
  events.push(
    envelope(state, ++sequence, input.createdAt, {
      method: "turn/completed",
      params: {
        threadId: state.threadId,
        turn: turn(turnId, "completed", items, completedAtMs),
      },
    }),
  );
  return events;
}

export function createMockCodexHarnessState(
  threadId: string,
  modelId: string,
  initialTurn?: MockCodexTurnInput,
): CodexHarnessState {
  const state: CodexHarnessState = {
    protocol: "codex-app-server",
    threadId,
    modelId,
    harnessVersion: "mock-codex-cli",
    protocolVersion: "v2",
    events: [],
  };
  const receivedAt = initialTurn?.createdAt ?? toUnixTimestamp(new Date());
  state.events.push(
    envelope(state, 1, receivedAt, {
      method: "thread/started",
      params: { thread: { id: threadId } },
    }),
  );
  if (initialTurn) {
    state.events.push(...createMockCodexTurnEvents(state, initialTurn));
  }
  return state;
}
