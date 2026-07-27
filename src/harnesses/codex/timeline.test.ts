import assert from "node:assert/strict";
import test from "node:test";

import { toUnixTimestamp } from "@/lib/time";

import {
  createMockCodexHarnessState,
  createMockCodexThread,
  createMockCodexTurn,
  projectCodexConversation,
  projectCodexTimeline,
  shouldRefreshCodexNativeSnapshot,
} from "./events";
import { groupCodexTimelineByTurn } from "./timeline";
import {
  CODEX_SESSION_NOTIFICATION_METHODS,
  CODEX_TRANSCRIPT_NOTIFICATION_METHODS,
} from "./types";
import type {
  CodexEventEnvelope,
  CodexServerNotification,
  CodexThreadItem,
  CodexTurn,
} from "./types";

const timestamp = (value: string) => toUnixTimestamp(new Date(value));

function liveTurn(
  id: string,
  status: CodexTurn["status"] = "inProgress",
  items: CodexThreadItem[] = [],
): CodexTurn {
  return {
    id,
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: timestamp("2026-07-12T01:00:00Z"),
    completedAt:
      status === "inProgress" ? null : timestamp("2026-07-12T01:01:00Z"),
    durationMs: status === "inProgress" ? null : 60_000,
  };
}

function nativeEvent(
  sequence: number,
  notification: CodexServerNotification,
): CodexEventEnvelope {
  return {
    harness: "codex",
    harnessVersion: "test",
    protocolVersion: "v2",
    sequence,
    receivedAt: timestamp("2026-07-12T01:00:00Z") + sequence,
    notification,
  };
}

function mcpToolCall(
  id: string,
  status: Extract<CodexThreadItem, { type: "mcpToolCall" }>["status"],
): Extract<CodexThreadItem, { type: "mcpToolCall" }> {
  return {
    type: "mcpToolCall",
    id,
    server: "github",
    tool: "search_code",
    status,
    arguments: { query: "projectCodexTimeline" },
    appContext: {
      connectorId: "github",
      linkId: null,
      resourceUri: null,
      appName: "GitHub",
      templateId: null,
      actionName: "Search code",
    },
    pluginId: null,
    result:
      status === "completed"
        ? {
            content: [{ type: "text", text: "1 match" }],
            structuredContent: null,
            _meta: null,
          }
        : null,
    error: status === "failed" ? { message: "Search failed" } : null,
    durationMs: status === "inProgress" ? null : 420,
  };
}

const firstTurn = createMockCodexTurn({
  content: "first",
  assistantText: "first reply",
  createdAt: timestamp("2026-07-12T00:00:00Z"),
});
const secondTurn = createMockCodexTurn({
  content: "second",
  assistantText: "second reply",
  createdAt: timestamp("2026-07-12T00:01:00Z"),
});
const nativeThread = createMockCodexThread("thread-test", [
  firstTurn,
  secondTurn,
]);

test("projects a native thread/read snapshot without DTO event history", () => {
  assert.deepEqual(
    projectCodexConversation(nativeThread).map((message) => message.content),
    ["first", "first reply", "second", "second reply"],
  );
  const state = createMockCodexHarnessState(
    nativeThread.id,
    "gpt-5.2-codex",
  );
  assert.equal("events" in state, false);
  assert.equal(state.historyRevision, 0);
});

test("projects local images without treating tool mentions as files", () => {
  const turn = createMockCodexTurn({
    content: "Compare README.md",
    assistantText: "Done",
    createdAt: timestamp("2026-07-12T00:00:00Z"),
  });
  turn.items[0] = {
    type: "userMessage",
    id: "user-with-references",
    clientId: "client-with-references",
    content: [
      {
        type: "text",
        text: "Compare README.md",
        text_elements: [],
      },
      {
        type: "mention",
        name: "Demo App",
        path: "app://demo-app",
      },
      {
        type: "localImage",
        path: "/workspace/.sandpi/uploads/upload-1/diagram.png",
      },
    ],
  };

  const [message] = projectCodexConversation(
    createMockCodexThread("thread-with-references", [turn]),
  );
  assert.equal(message?.clientId, "client-with-references");
  assert.deepEqual(message?.localImages, [
    {
      id: "user-with-references-local-image-2",
      name: "diagram.png",
      path: "/workspace/.sandpi/uploads/upload-1/diagram.png",
      kind: "localImage",
      source: "upload",
    },
  ]);
});

test("groups completed Codex work behind its prompt and final answer", () => {
  const completedTurn: CodexTurn = {
    id: "turn-with-activity",
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: timestamp("2026-07-12T02:00:00Z"),
    completedAt: timestamp("2026-07-12T02:00:12Z"),
    durationMs: 12_000,
    items: [
      {
        type: "userMessage",
        id: "activity-user",
        clientId: null,
        content: [{ type: "text", text: "Inspect the project", text_elements: [] }],
      },
      {
        type: "agentMessage",
        id: "activity-commentary",
        text: "I am checking the files.",
        phase: "commentary",
        memoryCitation: null,
      },
      {
        type: "commandExecution",
        id: "activity-command",
        command: "rg --files",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [
          { type: "listFiles", command: "rg --files", path: "/workspace" },
        ],
        aggregatedOutput: "app/page.tsx\n",
        exitCode: 0,
        durationMs: 80,
      },
      {
        type: "agentMessage",
        id: "activity-final",
        text: "The project is ready.",
        phase: "final_answer",
        memoryCitation: null,
      },
    ],
  };

  const [group] = groupCodexTimelineByTurn(
    projectCodexTimeline(
      createMockCodexThread("thread-with-activity", [completedTurn]),
    ),
  );
  assert.ok(group);
  assert.deepEqual(
    group.blocks.map((block) =>
      block.kind === "message"
        ? `message:${block.entry.role}:${block.entry.content}`
        : block.kind === "activity"
          ? `activity:${block.entries.map((entry) => entry.kind).join(",")}`
          : `result:${block.entry.status}`,
    ),
    [
      "message:user:Inspect the project",
      "activity:message,command",
      "message:assistant:The project is ready.",
    ],
  );
  assert.equal(group.turn?.durationMs, 12_000);
});

test("keeps a phase-less live answer outside completed tool activity", () => {
  const turnId = "turn-with-live-phase-less-answer";
  const startedAt = timestamp("2026-07-12T02:00:00Z");
  const userMessage: CodexThreadItem = {
    type: "userMessage",
    id: "live-answer-user",
    clientId: "client-live-answer-user",
    content: [
      {
        type: "text",
        text: "Inspect the project",
        text_elements: [],
      },
    ],
  };
  const completedCommand: CodexThreadItem = {
    type: "commandExecution",
    id: "live-answer-command",
    command: "rg --files",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [
      { type: "listFiles", command: "rg --files", path: "/workspace" },
    ],
    aggregatedOutput: "app/page.tsx\n",
    exitCode: 0,
    durationMs: 80,
  };
  const streamingAnswer: CodexThreadItem = {
    type: "agentMessage",
    id: "live-answer-message",
    text: "",
    phase: null,
    memoryCitation: null,
  };
  const projection = projectCodexTimeline(undefined, [
    nativeEvent(1, {
      method: "turn/started",
      params: {
        threadId: "thread-with-live-phase-less-answer",
        turn: liveTurn(turnId, "inProgress", [
          userMessage,
          completedCommand,
        ]),
      },
    }),
    nativeEvent(2, {
      method: "item/started",
      params: {
        threadId: "thread-with-live-phase-less-answer",
        turnId,
        item: streamingAnswer,
        startedAtMs: startedAt * 1_000,
      },
    }),
    nativeEvent(3, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-with-live-phase-less-answer",
        turnId,
        itemId: streamingAnswer.id,
        delta: "## Result\n\n- ready",
      },
    }),
  ]);
  const liveMessage = projection.entries.find(
    (entry) => entry.id === streamingAnswer.id,
  );
  assert.ok(liveMessage?.kind === "message");
  assert.equal(liveMessage.phase, undefined);
  assert.equal(liveMessage.streaming, true);

  const [group] = groupCodexTimelineByTurn(projection);
  assert.ok(group);
  assert.deepEqual(
    group.blocks.map((block) =>
      block.kind === "message"
        ? `message:${block.entry.role}:${block.entry.id}`
        : block.kind,
    ),
    [
      `message:user:${userMessage.id}`,
      "activity",
      `message:assistant:${streamingAnswer.id}`,
    ],
  );
  const activity = group.blocks[1];
  assert.ok(activity?.kind === "activity");
  assert.deepEqual(
    activity.entries.map((entry) => entry.id),
    [completedCommand.id],
  );
});

test("preserves steering messages between native activity blocks", () => {
  const steeredTurn: CodexTurn = {
    id: "turn-with-steering",
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: timestamp("2026-07-12T02:00:00Z"),
    completedAt: timestamp("2026-07-12T02:00:12Z"),
    durationMs: 12_000,
    items: [
      {
        type: "userMessage",
        id: "steering-user-one",
        clientId: "client-user-one",
        content: [{ type: "text", text: "Inspect first", text_elements: [] }],
      },
      {
        type: "commandExecution",
        id: "steering-command-one",
        command: "rg --files",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [
          { type: "listFiles", command: "rg --files", path: "/workspace" },
        ],
        aggregatedOutput: "app/page.tsx\n",
        exitCode: 0,
        durationMs: 80,
      },
      {
        type: "userMessage",
        id: "steering-user-two",
        clientId: "client-user-two",
        content: [{ type: "text", text: "Focus on tests", text_elements: [] }],
      },
      {
        type: "commandExecution",
        id: "steering-command-two",
        command: "npm test",
        cwd: "/workspace",
        processId: null,
        source: "agent",
        status: "completed",
        commandActions: [
          { type: "unknown", command: "npm test" },
        ],
        aggregatedOutput: "ok\n",
        exitCode: 0,
        durationMs: 500,
      },
      {
        type: "agentMessage",
        id: "steering-final",
        text: "The tests pass.",
        phase: "final_answer",
        memoryCitation: null,
      },
    ],
  };

  const [group] = groupCodexTimelineByTurn(
    projectCodexTimeline(
      createMockCodexThread("thread-with-steering", [steeredTurn]),
    ),
  );
  assert.ok(group);
  assert.deepEqual(
    group.blocks.map((block) =>
      block.kind === "message"
        ? `${block.entry.role}:${block.entry.content}`
        : block.kind,
    ),
    [
      "user:Inspect first",
      "activity",
      "user:Focus on tests",
      "activity",
      "assistant:The tests pass.",
    ],
  );
  const firstMessage = group.blocks[0];
  assert.ok(firstMessage?.kind === "message");
  assert.equal(firstMessage.entry.clientId, "client-user-one");
});

test("keeps a live tool attached to its work block after a steering message", () => {
  const turnId = "turn-with-live-tool-before-steering";
  const startedAt = timestamp("2026-07-12T02:00:00Z");
  const [group] = groupCodexTimelineByTurn({
    entries: [
      {
        kind: "message",
        id: "live-user-one",
        clientId: "client-live-user-one",
        turnId,
        role: "user",
        content: "Inspect the project",
        createdAt: startedAt,
      },
      {
        kind: "command",
        id: "live-command",
        turnId,
        createdAt: startedAt,
        status: "running",
        command: "npm test",
        cwd: "/workspace",
        output: "",
        outputTruncated: false,
        exitCode: null,
        durationMs: null,
        exploration: false,
        waitingForProcess: false,
      },
      {
        kind: "message",
        id: "live-user-two",
        clientId: "client-live-user-two",
        turnId,
        role: "user",
        content: "Also check lint",
        createdAt: startedAt + 1,
      },
    ],
    turns: [
      {
        turnId,
        status: "inProgress",
        startedAt,
        completedAt: null,
        durationMs: null,
      },
    ],
    activeTurn: {
      turnId,
      startedAt,
      state: "runningCommand",
      detail: "npm test",
    },
  });

  assert.ok(group);
  assert.equal(group.blocks.length, 3);
  const activity = group.blocks.find((block) => block.kind === "activity");
  assert.ok(activity?.kind === "activity");
  assert.equal(group.activeActivityBlockId, activity.id);
  assert.deepEqual(
    activity.entries.map((entry) => entry.id),
    ["live-command"],
  );
});

test("a replacement snapshot does not inherit a prior live suffix", () => {
  const oldTurnId = "turn-old-live";
  const oldSuffix = [
    nativeEvent(1, {
      method: "turn/started",
      params: { threadId: nativeThread.id, turn: liveTurn(oldTurnId) },
    }),
    nativeEvent(2, {
      method: "item/agentMessage/delta",
      params: {
        threadId: nativeThread.id,
        turnId: oldTurnId,
        itemId: "old-stream",
        delta: "stale live text",
      },
    }),
  ];
  assert.ok(
    projectCodexConversation(nativeThread, oldSuffix).some(
      (message) => message.content === "stale live text",
    ),
  );

  const replacement = createMockCodexThread("thread-replacement", [firstTurn]);
  assert.deepEqual(
    projectCodexConversation(replacement).map((message) => message.content),
    ["first", "first reply"],
  );
});

test("updates one running command row from the in-memory native suffix", () => {
  const turnId = "turn-live";
  const command: Extract<CodexThreadItem, { type: "commandExecution" }> = {
    type: "commandExecution",
    id: "exec-live",
    command: "/bin/bash -lc 'npm install'",
    cwd: "/workspace",
    processId: "42",
    source: "unifiedExecStartup",
    status: "inProgress",
    commandActions: [{ type: "unknown", command: "npm install" }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  const events = [
    nativeEvent(1, {
      method: "turn/started",
      params: { threadId: nativeThread.id, turn: liveTurn(turnId) },
    }),
    nativeEvent(2, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: command,
        startedAtMs: Date.parse("2026-07-12T01:00:02Z"),
      },
    }),
    nativeEvent(3, {
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: nativeThread.id,
        turnId,
        itemId: command.id,
        delta: "installing\n",
      },
    }),
  ];

  const running = projectCodexTimeline(nativeThread, [...events, events[2]]);
  const activity = running.entries.find((entry) => entry.kind === "command");
  assert.ok(activity?.kind === "command");
  assert.equal(activity.status, "running");
  assert.equal(activity.output, "installing\n");
  assert.equal(
    running.entries.filter((entry) => entry.id === command.id).length,
    1,
  );
  assert.equal(running.activeTurn?.state, "runningCommand");

  const waiting = projectCodexTimeline(nativeThread, [
    ...events,
    nativeEvent(4, {
      method: "item/commandExecution/terminalInteraction",
      params: {
        threadId: nativeThread.id,
        turnId,
        itemId: command.id,
        processId: "42",
        stdin: "",
      },
    }),
  ]);
  assert.equal(waiting.activeTurn?.state, "waitingForCommand");

  const completedCommand = {
    ...command,
    status: "completed" as const,
    aggregatedOutput: "installing\ndone\n",
    exitCode: 0,
    durationMs: 5_200,
  };
  const completedTurn = liveTurn(turnId, "completed", [completedCommand]);
  const completed = projectCodexTimeline(nativeThread, [
    ...events,
    nativeEvent(5, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: completedCommand,
        completedAtMs: Date.parse("2026-07-12T01:00:05Z"),
      },
    }),
    nativeEvent(6, {
      method: "turn/completed",
      params: { threadId: nativeThread.id, turn: completedTurn },
    }),
  ]);
  const finalized = completed.entries.find(
    (entry) => entry.id === command.id,
  );
  assert.ok(finalized?.kind === "command");
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.output, "installing\ndone\n");
  assert.equal(completed.activeTurn, undefined);
});

test("shows live file patches and lets the completed native item replace them", () => {
  const turnId = "turn-files";
  const firstChange = {
    path: "/workspace/app/page.tsx",
    kind: { type: "update" as const, move_path: null },
    diff: "-old\n+new",
  };
  const secondChange = {
    path: "/workspace/app/theme.css",
    kind: { type: "add" as const },
    diff: "+body {}",
  };
  const events = [
    nativeEvent(10, {
      method: "turn/started",
      params: { threadId: nativeThread.id, turn: liveTurn(turnId) },
    }),
    nativeEvent(11, {
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: nativeThread.id,
        turnId,
        itemId: "files-live",
        changes: [firstChange, secondChange],
      },
    }),
  ];
  const applying = projectCodexTimeline(nativeThread, events);
  const liveFiles = applying.entries.find(
    (entry) => entry.id === "files-live",
  );
  assert.ok(liveFiles?.kind === "fileChange");
  assert.equal(liveFiles.status, "running");
  assert.equal(liveFiles.changes.length, 2);
  assert.equal(applying.activeTurn?.state, "editingFiles");

  const completedItem: Extract<CodexThreadItem, { type: "fileChange" }> = {
    type: "fileChange",
    id: "files-live",
    changes: [firstChange],
    status: "completed",
  };
  const done = projectCodexTimeline(nativeThread, [
    ...events,
    nativeEvent(12, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: completedItem,
        completedAtMs: Date.parse("2026-07-12T01:00:12Z"),
      },
    }),
  ]);
  const completedFiles = done.entries.find(
    (entry) => entry.id === "files-live",
  );
  assert.ok(completedFiles?.kind === "fileChange");
  assert.equal(completedFiles.status, "completed");
  assert.deepEqual(
    completedFiles.changes.map((change) => change.file),
    [firstChange.path],
  );
});

test("keeps a live MCP call native while its completion replaces the same row", () => {
  const turnId = "turn-mcp";
  const started = mcpToolCall("mcp-live", "inProgress");
  const events = [
    nativeEvent(20, {
      method: "turn/started",
      params: { threadId: nativeThread.id, turn: liveTurn(turnId) },
    }),
    nativeEvent(21, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: started,
        startedAtMs: Date.parse("2026-07-12T01:00:20Z"),
      },
    }),
  ];
  const running = projectCodexTimeline(nativeThread, events);
  const runningMcp = running.entries.find((entry) => entry.id === started.id);
  assert.ok(runningMcp?.kind === "mcpToolCall");
  assert.equal(runningMcp.status, "running");
  assert.deepEqual(runningMcp.arguments, {
    query: "projectCodexTimeline",
  });

  const completedItem = mcpToolCall(started.id, "completed");
  const completed = projectCodexTimeline(nativeThread, [
    ...events,
    nativeEvent(22, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: completedItem,
        completedAtMs: Date.parse("2026-07-12T01:00:22Z"),
      },
    }),
  ]);
  const completedMcp = completed.entries.find(
    (entry) => entry.id === started.id,
  );
  assert.ok(completedMcp?.kind === "mcpToolCall");
  assert.equal(completedMcp.status, "completed");
  assert.equal(completedMcp.durationMs, 420);
  assert.deepEqual(completedMcp.result, completedItem.result);
  assert.equal(
    completed.entries.filter((entry) => entry.id === started.id).length,
    1,
  );
});

test("renders interruption from native thread/read without a synthetic recovery", () => {
  const interrupted = liveTurn("turn-interrupted", "interrupted", [
    {
      type: "commandExecution",
      id: "command-interrupted",
      command: "npm install",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: "",
      exitCode: null,
      durationMs: null,
    },
  ]);
  const projected = projectCodexTimeline(
    createMockCodexThread("thread-interrupted", [interrupted]),
  );
  assert.equal(projected.activeTurn, undefined);
  assert.equal(projected.entries[0]?.kind, "command");
  assert.equal(
    projected.entries[0]?.kind === "command"
      ? projected.entries[0].status
      : undefined,
    "interrupted",
  );
  assert.equal(projected.entries[1]?.kind, "turnResult");
});

test("projects one completed inline review without its interrupted delegate", () => {
  const review =
    "The build succeeds, but project creation does not persist the name.";
  const reviewTurn = liveTurn("turn-review", "completed", [
    {
      type: "enteredReviewMode",
      id: "review-entered",
      review: "current changes",
    },
    {
      type: "exitedReviewMode",
      id: "review-exited",
      review,
    },
  ]);
  reviewTurn.startedAt = null;
  const delegate = liveTurn("turn-review-delegate", "interrupted", [
    {
      type: "userMessage",
      id: "review-prompt-one",
      clientId: null,
      content: [
        {
          type: "text",
          text: "Review the current code changes.",
          text_elements: [],
        },
      ],
    },
    {
      type: "userMessage",
      id: "review-prompt-two",
      clientId: null,
      content: [
        {
          type: "text",
          text: "Review the current code changes.",
          text_elements: [],
        },
      ],
    },
    {
      type: "agentMessage",
      id: "review-delegate-result",
      text: review,
      phase: null,
      memoryCitation: null,
    },
  ]);
  delegate.completedAt = null;
  delegate.durationMs = null;

  const projected = projectCodexTimeline(
    createMockCodexThread("thread-inline-review", [reviewTurn, delegate]),
  );

  assert.deepEqual(
    projected.turns.map((turn) => turn.turnId),
    ["turn-review"],
  );
  assert.equal(projected.activeTurn, undefined);
  assert.deepEqual(
    projected.entries.map((entry) => entry.kind),
    ["message"],
  );
  const result = projected.entries[0];
  assert.equal(result?.kind === "message" ? result.role : undefined, "assistant");
  assert.equal(result?.kind === "message" ? result.content : undefined, review);
});

test("keeps the inline review delegate private in the live suffix", () => {
  const review = "One prioritized review finding.";
  const mainTurnId = "turn-review-live";
  const delegateTurnId = "turn-review-live-delegate";
  const entered: CodexThreadItem = {
    type: "enteredReviewMode",
    id: "review-live-entered",
    review: "current changes",
  };
  const exited: CodexThreadItem = {
    type: "exitedReviewMode",
    id: "review-live-exited",
    review,
  };
  const reviewMessage: CodexThreadItem = {
    type: "agentMessage",
    id: "review_rollout_assistant",
    text: review,
    phase: null,
    memoryCitation: null,
  };
  const events = [
    nativeEvent(80, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId: mainTurnId,
        item: entered,
        startedAtMs: Date.parse("2026-07-12T01:00:20Z"),
      },
    }),
    nativeEvent(81, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId: mainTurnId,
        item: entered,
        completedAtMs: Date.parse("2026-07-12T01:00:21Z"),
      },
    }),
    nativeEvent(82, {
      method: "turn/started",
      params: {
        threadId: nativeThread.id,
        turn: liveTurn(delegateTurnId),
      },
    }),
    nativeEvent(83, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId: mainTurnId,
        item: exited,
        startedAtMs: Date.parse("2026-07-12T01:00:40Z"),
      },
    }),
    nativeEvent(84, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId: mainTurnId,
        item: exited,
        completedAtMs: Date.parse("2026-07-12T01:00:41Z"),
      },
    }),
    nativeEvent(85, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId: mainTurnId,
        item: reviewMessage,
        startedAtMs: Date.parse("2026-07-12T01:00:41Z"),
      },
    }),
    nativeEvent(86, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId: mainTurnId,
        item: reviewMessage,
        completedAtMs: Date.parse("2026-07-12T01:00:42Z"),
      },
    }),
    nativeEvent(87, {
      method: "turn/completed",
      params: {
        threadId: nativeThread.id,
        turn: liveTurn(mainTurnId, "completed"),
      },
    }),
  ];

  const projected = projectCodexTimeline(
    createMockCodexThread(nativeThread.id, []),
    events,
  );

  assert.equal(projected.activeTurn, undefined);
  assert.equal(
    projected.turns.some((turn) => turn.turnId === delegateTurnId),
    false,
  );
  assert.deepEqual(
    projected.entries.map((entry) => entry.kind),
    ["message"],
  );
  assert.equal(
    projected.entries[0]?.kind === "message"
      ? projected.entries[0].content
      : undefined,
    review,
  );
});

test("projects a legacy completed Turn as failed when its Thread has a system error", () => {
  const failedTurn = liveTurn("turn-system-error", "completed", [
    {
      type: "userMessage",
      id: "user-system-error",
      clientId: "client-system-error",
      content: [
        { type: "text", text: "Continue", text_elements: [] },
      ],
    },
  ]);
  const thread = createMockCodexThread("thread-system-error", [failedTurn]);
  thread.status = { type: "systemError" };

  const projected = projectCodexTimeline(thread);

  assert.equal(projected.activeTurn, undefined);
  assert.equal(projected.turns[0]?.status, "failed");
  assert.deepEqual(
    projected.entries.map((entry) => entry.kind),
    ["message", "turnResult"],
  );
  assert.equal(
    projected.entries[1]?.kind === "turnResult"
      ? projected.entries[1].status
      : undefined,
    "failed",
  );
});

test("ends live work on a non-retrying Codex error notification", () => {
  const turnId = "turn-live-system-error";
  const command: Extract<CodexThreadItem, { type: "commandExecution" }> = {
    type: "commandExecution",
    id: "command-live-system-error",
    command: "run security check",
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: "",
    exitCode: null,
    durationMs: null,
  };
  const events = [
    nativeEvent(70, {
      method: "turn/started",
      params: { threadId: nativeThread.id, turn: liveTurn(turnId) },
    }),
    nativeEvent(71, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: command,
        startedAtMs: Date.parse("2026-07-12T01:01:11Z"),
      },
    }),
  ];

  const retrying = projectCodexTimeline(nativeThread, [
    ...events,
    nativeEvent(72, {
      method: "error",
      params: {
        threadId: nativeThread.id,
        turnId,
        willRetry: true,
        error: {
          message: "Temporary upstream failure",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    }),
  ]);
  assert.equal(retrying.activeTurn?.turnId, turnId);

  const failed = projectCodexTimeline(nativeThread, [
    ...events,
    nativeEvent(73, {
      method: "error",
      params: {
        threadId: nativeThread.id,
        turnId,
        willRetry: false,
        error: {
          message: "The Codex request failed",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    }),
  ]);
  assert.equal(failed.activeTurn, undefined);
  const failedCommand = failed.entries.find(
    (entry) => entry.id === command.id,
  );
  assert.equal(
    failedCommand?.kind === "command" ? failedCommand.status : undefined,
    "failed",
  );
  const result = failed.entries.find(
    (entry) => entry.kind === "turnResult" && entry.turnId === turnId,
  );
  assert.equal(result?.kind === "turnResult" ? result.detail : undefined, "The Codex request failed");
});

test("a new Turn clears a previous Thread system-error projection", () => {
  const previous = liveTurn("turn-previous-error", "completed");
  const thread = createMockCodexThread("thread-retried", [previous]);
  thread.status = { type: "systemError" };
  const next = liveTurn("turn-after-error");

  const projected = projectCodexTimeline(thread, [
    nativeEvent(80, {
      method: "turn/started",
      params: { threadId: thread.id, turn: next },
    }),
  ]);

  assert.equal(projected.activeTurn?.turnId, next.id);
  assert.equal(
    projected.entries.some((entry) => entry.kind === "turnResult"),
    false,
  );
});

test("renders modeled tools natively and unknown ThreadItems as Codex fallbacks", () => {
  const nativeTool = mcpToolCall("mcp-tool-1", "completed");
  const futureTool = {
    type: "futureToolCall",
    id: "future-tool-1",
    status: "completed",
    description: "A future Codex-native tool",
  } as unknown as CodexThreadItem;
  const reasoning: Extract<CodexThreadItem, { type: "reasoning" }> = {
    type: "reasoning",
    id: "reasoning-1",
    summary: ["Checked the repository structure"],
    content: ["private chain of thought must stay hidden"],
  };
  const projected = projectCodexTimeline(
    createMockCodexThread("thread-native-fallback", [
      liveTurn("turn-native-fallback", "completed", [
        nativeTool,
        futureTool,
        reasoning,
      ]),
    ]),
  );

  const toolActivity = projected.entries.find(
    (entry) => entry.id === "mcp-tool-1",
  );
  assert.ok(toolActivity?.kind === "mcpToolCall");
  assert.equal(toolActivity.status, "completed");
  assert.equal(toolActivity.appName, "GitHub");
  assert.deepEqual(toolActivity.result, nativeTool.result);

  const futureActivity = projected.entries.find(
    (entry) => entry.id === "future-tool-1",
  );
  assert.ok(futureActivity?.kind === "nativeItem");
  assert.equal(futureActivity.itemType, "futureToolCall");
  assert.equal(futureActivity.detail, "A future Codex-native tool");

  const reasoningActivity = projected.entries.find(
    (entry) => entry.id === "reasoning-1",
  );
  assert.ok(reasoningActivity?.kind === "nativeItem");
  assert.equal(reasoningActivity.detail, "Checked the repository structure");
  assert.equal(reasoningActivity.detail?.includes("private chain"), false);
});

test("never projects private live reasoning text into Codex activity", () => {
  const turnId = "turn-live-reasoning";
  const reasoning: Extract<CodexThreadItem, { type: "reasoning" }> = {
    type: "reasoning",
    id: "reasoning-live",
    summary: [],
    content: [],
  };
  const projected = projectCodexTimeline(nativeThread, [
    nativeEvent(30, {
      method: "turn/started",
      params: { threadId: nativeThread.id, turn: liveTurn(turnId) },
    }),
    nativeEvent(31, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: reasoning,
        startedAtMs: Date.parse("2026-07-12T01:00:30Z"),
      },
    }),
    nativeEvent(32, {
      method: "item/reasoning/textDelta",
      params: {
        threadId: nativeThread.id,
        turnId,
        itemId: reasoning.id,
        delta: "private chain of thought",
        contentIndex: 0,
      },
    }),
    nativeEvent(33, {
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: nativeThread.id,
        turnId,
        itemId: reasoning.id,
        delta: "Checked the public API",
        summaryIndex: 0,
      },
    }),
    nativeEvent(34, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: reasoning,
        completedAtMs: Date.parse("2026-07-12T01:00:34Z"),
      },
    }),
  ]);

  const activity = projected.entries.find(
    (entry) => entry.id === reasoning.id,
  );
  assert.ok(activity?.kind === "nativeItem");
  assert.equal(activity.status, "completed");
  assert.equal(activity.detail, "Checked the public API");
  assert.equal(activity.detail.includes("private chain"), false);
  assert.equal(projected.activeTurn?.detail, undefined);
});

test("omits reasoning lifecycle rows that have no public summary", () => {
  const turnId = "turn-private-reasoning-only";
  const reasoning: Extract<CodexThreadItem, { type: "reasoning" }> = {
    type: "reasoning",
    id: "reasoning-private-only",
    summary: [],
    content: [],
  };
  const projected = projectCodexTimeline(nativeThread, [
    nativeEvent(40, {
      method: "turn/started",
      params: { threadId: nativeThread.id, turn: liveTurn(turnId) },
    }),
    nativeEvent(41, {
      method: "item/started",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: reasoning,
        startedAtMs: Date.parse("2026-07-12T01:00:40Z"),
      },
    }),
    nativeEvent(42, {
      method: "item/reasoning/textDelta",
      params: {
        threadId: nativeThread.id,
        turnId,
        itemId: reasoning.id,
        delta: "private chain of thought",
        contentIndex: 0,
      },
    }),
    nativeEvent(43, {
      method: "item/completed",
      params: {
        threadId: nativeThread.id,
        turnId,
        item: reasoning,
        completedAtMs: Date.parse("2026-07-12T01:00:43Z"),
      },
    }),
  ]);

  assert.equal(
    projected.entries.some((entry) => entry.id === reasoning.id),
    false,
  );
});

test("keeps every modeled plan and reasoning notification in the live suffix", () => {
  assert.equal(
    CODEX_TRANSCRIPT_NOTIFICATION_METHODS.includes("thread/status/changed"),
    true,
  );
  assert.equal(CODEX_TRANSCRIPT_NOTIFICATION_METHODS.includes("error"), true);
  assert.equal(CODEX_TRANSCRIPT_NOTIFICATION_METHODS.includes("item/plan/delta"), true);
  assert.equal(
    CODEX_TRANSCRIPT_NOTIFICATION_METHODS.includes(
      "item/reasoning/summaryPartAdded",
    ),
    true,
  );
  assert.equal(
    CODEX_TRANSCRIPT_NOTIFICATION_METHODS.includes("item/reasoning/textDelta"),
    true,
  );
  assert.equal(
    CODEX_SESSION_NOTIFICATION_METHODS.includes(
      "thread/tokenUsage/updated",
    ),
    true,
  );
});

test("refreshes the native snapshot at the bounded live suffix limit", () => {
  assert.equal(shouldRefreshCodexNativeSnapshot(255), false);
  assert.equal(shouldRefreshCodexNativeSnapshot(256), true);
  assert.equal(shouldRefreshCodexNativeSnapshot(10_000), true);
});
