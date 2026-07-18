import assert from "node:assert/strict";
import test from "node:test";

import { toUnixTimestamp } from "@/lib/time";

import {
  createMockCodexThread,
  createMockCodexTurn,
  projectCodexTimeline,
} from "./events";
import {
  selectCodexSessionActivity,
  summarizeCodexSessionActivity,
} from "./session-activity";
import type {
  CodexRolloutActivityFeed,
  CodexRolloutToolActivity,
} from "./rollout-activity";
import type { CodexTurn } from "./types";

const startedAt = toUnixTimestamp(new Date("2026-07-18T08:00:00Z"));

const nativeActivityTurn: CodexTurn = {
  id: "turn-native-activity",
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt,
  completedAt: startedAt + 12,
  durationMs: 12_000,
  items: [
    {
      type: "userMessage",
      id: "activity-user",
      clientId: null,
      content: [
        {
          type: "text",
          text: "Inspect the repository and check the release.",
          text_elements: [],
        },
      ],
    },
    {
      type: "plan",
      id: "activity-plan",
      text: "Inspect locally, then query the release provider.",
    },
    {
      type: "commandExecution",
      id: "activity-command",
      command: "git status --short",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "git status --short" }],
      aggregatedOutput: "",
      exitCode: 0,
      durationMs: 32,
    },
    {
      type: "fileChange",
      id: "activity-file",
      status: "completed",
      changes: [
        {
          path: "/workspace/README.md",
          kind: { type: "update", move_path: null },
          diff: "-old\n+new",
        },
      ],
    },
    {
      type: "mcpToolCall",
      id: "activity-mcp",
      server: "github",
      tool: "get_release",
      status: "completed",
      arguments: { owner: "sandbox0-ai", repo: "sandpi" },
      appContext: null,
      pluginId: null,
      result: {
        content: [{ type: "text", text: "v1.2.3" }],
        structuredContent: { tag: "v1.2.3" },
        _meta: null,
      },
      error: null,
      durationMs: 240,
    },
    {
      type: "dynamicToolCall",
      id: "activity-dynamic",
      namespace: "release",
      tool: "verify",
      arguments: { tag: "v1.2.3" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "verified" }],
      success: true,
      durationMs: 110,
    },
    {
      type: "webSearch",
      id: "activity-web",
      query: "sandpi v1.2.3",
      action: {
        type: "openPage",
        url: "https://example.com/releases/v1.2.3",
      },
    },
    {
      type: "collabAgentToolCall",
      id: "activity-collab",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "thread-parent",
      receiverThreadIds: ["thread-child"],
      prompt: "Review the release metadata.",
      model: null,
      reasoningEffort: null,
      agentsStates: { "thread-child": { status: "completed" } },
    },
    {
      type: "subAgentActivity",
      id: "activity-subagent",
      kind: "interacted",
      agentThreadId: "thread-child",
      agentPath: "/root/release-review",
    },
    {
      type: "imageGeneration",
      id: "activity-image",
      status: "completed",
      revisedPrompt: "Release architecture diagram",
      result: "base64-image-result-is-not-rendered",
      savedPath: "/workspace/release.png",
    },
    {
      type: "agentMessage",
      id: "activity-final",
      text: "The release is valid.",
      phase: "final_answer",
      memoryCitation: null,
    },
  ],
};

const projection = projectCodexTimeline(
  createMockCodexThread("thread-native-activity", [nativeActivityTurn]),
);

function rolloutTool(
  index: number,
  input: Partial<CodexRolloutToolActivity> = {},
): CodexRolloutToolActivity {
  return {
    kind: "rolloutToolCall",
    id: `rollout:turn-native-activity:function:call-${index}`,
    turnId: nativeActivityTurn.id,
    createdAt: startedAt + index / 100,
    completedAt: startedAt + index / 100 + 0.001,
    durationMs: 1,
    status: "completed",
    callId: `call-${index}`,
    callType: "function_call",
    name: "wait",
    namespace: null,
    nativeStatus: null,
    callPayload: {
      type: "function_call",
      call_id: `call-${index}`,
      name: "wait",
      arguments: "{}",
    },
    outputs: [
      {
        outputType: "function_call_output",
        createdAt: startedAt + index / 100 + 0.001,
        nativeStatus: null,
        payload: {
          type: "function_call_output",
          call_id: `call-${index}`,
          output: "done",
        },
      },
    ],
    codeModeTools: [],
    payloadTruncated: false,
    ...input,
  };
}

function rolloutFeed(
  records: CodexRolloutToolActivity[],
): CodexRolloutActivityFeed {
  return {
    source: "codex-rollout",
    availability: "available",
    records,
    error: null,
  };
}

test("summarizes Codex Session Activity with Codex-owned categories", () => {
  assert.deepEqual(summarizeCodexSessionActivity(projection), {
    total: 9,
    external: 4,
    commands: 1,
    files: 1,
    agents: 2,
    system: 1,
  });
});

test("filters native Codex activity without including conversation messages", () => {
  const [all] = selectCodexSessionActivity(projection);
  assert.ok(all);
  assert.equal(all.turnId, nativeActivityTurn.id);
  assert.equal(
    all.prompt,
    "Inspect the repository and check the release.",
  );
  assert.equal(all.entries.length, 9);

  const [external] = selectCodexSessionActivity(projection, "external");
  assert.deepEqual(
    external?.entries.map((entry) => entry.kind),
    ["mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration"],
  );

  const [agents] = selectCodexSessionActivity(projection, "agents");
  assert.deepEqual(
    agents?.entries.map((entry) => entry.kind),
    ["collabAgentToolCall", "subAgentActivity"],
  );

  const [system] = selectCodexSessionActivity(projection, "system");
  assert.deepEqual(
    system?.entries.map((entry) =>
      entry.kind === "nativeItem" ? entry.itemType : entry.kind,
    ),
    ["plan"],
  );
});

test("preserves Codex-native external tool details in the activity projection", () => {
  const [external] = selectCodexSessionActivity(projection, "external");
  const mcp = external?.entries.find((entry) => entry.kind === "mcpToolCall");
  assert.ok(mcp?.kind === "mcpToolCall");
  assert.deepEqual(mcp.arguments, {
    owner: "sandbox0-ai",
    repo: "sandpi",
  });
  assert.deepEqual(mcp.result, {
    content: [{ type: "text", text: "v1.2.3" }],
    structuredContent: { tag: "v1.2.3" },
    _meta: null,
  });
});

test("keeps native Turn ordinals stable when earlier Turns do not match a filter", () => {
  const earlierTurn = createMockCodexTurn({
    content: "Summarize the local files.",
    assistantText: "Done.",
    createdAt: startedAt - 60,
  });
  const twoTurnProjection = projectCodexTimeline(
    createMockCodexThread("thread-stable-ordinals", [
      earlierTurn,
      nativeActivityTurn,
    ]),
  );

  const [external] = selectCodexSessionActivity(
    twoTurnProjection,
    "external",
  );
  assert.equal(external?.ordinal, 2);
  assert.equal(external?.turnId, nativeActivityTurn.id);
});

test("merges durable rollout calls without normalizing them into conversation items", () => {
  const activity = rolloutFeed([
    rolloutTool(1, {
      callType: "custom_tool_call",
      name: "exec",
      codeModeTools: ["exec_command"],
    }),
    rolloutTool(2, {
      callType: "custom_tool_call",
      name: "exec",
      codeModeTools: ["apply_patch"],
    }),
  ]);

  assert.deepEqual(summarizeCodexSessionActivity(projection, activity), {
    total: 11,
    external: 4,
    commands: 2,
    files: 2,
    agents: 2,
    system: 1,
  });
  const [turn] = selectCodexSessionActivity(projection, "all", activity);
  assert.equal(turn?.entries.length, 11);
  assert.equal(
    turn?.entries.filter((entry) => entry.kind === "rolloutToolCall").length,
    2,
  );
});

test("restores the real 30-call rollout shape alongside its modeled file change", () => {
  const thread = createMockCodexThread("thread-real-rollout-shape", [
    {
      ...nativeActivityTurn,
      items: nativeActivityTurn.items.filter(
        (item) =>
          item.type === "userMessage" ||
          item.type === "fileChange" ||
          item.type === "agentMessage",
      ),
    },
  ]);
  const fileProjection = projectCodexTimeline(thread);
  const records = [
    ...Array.from({ length: 18 }, (_, index) =>
      rolloutTool(index, {
        name: "exec",
        callType: "custom_tool_call",
        codeModeTools: ["exec_command"],
      }),
    ),
    rolloutTool(18, {
      name: "exec",
      callType: "custom_tool_call",
      codeModeTools: ["apply_patch"],
    }),
    rolloutTool(19, {
      name: "exec",
      callType: "custom_tool_call",
      codeModeTools: ["write_stdin"],
    }),
    ...Array.from({ length: 10 }, (_, index) =>
      rolloutTool(index + 20, { name: "wait" }),
    ),
  ];
  const activity = rolloutFeed(records);

  assert.deepEqual(summarizeCodexSessionActivity(fileProjection, activity), {
    total: 31,
    external: 0,
    commands: 29,
    files: 2,
    agents: 0,
    system: 0,
  });
  assert.equal(
    selectCodexSessionActivity(fileProjection, "all", activity)[0]?.entries
      .length,
    31,
  );
});

test("categorizes namespaced Codex code-mode tools without cross-harness normalization", () => {
  const activity = rolloutFeed([
    rolloutTool(1, { codeModeTools: ["web.run"] }),
    rolloutTool(2, { codeModeTools: ["image_gen.imagegen"] }),
    rolloutTool(3, { codeModeTools: ["collaboration.spawn_agent"] }),
    rolloutTool(4, { codeModeTools: ["functions.exec_command"] }),
    rolloutTool(5, {
      codeModeTools: ["exec_command", "mcp__docs__search"],
    }),
  ]);
  const emptyProjection = projectCodexTimeline(
    createMockCodexThread("thread-code-mode-categories", [
      createMockCodexTurn({
        content: "Use native Codex tools.",
        assistantText: "Done.",
        createdAt: startedAt,
      }),
    ]),
  );
  const turnId = emptyProjection.turns[0]!.turnId;
  for (const record of activity.records) record.turnId = turnId;

  assert.deepEqual(summarizeCodexSessionActivity(emptyProjection, activity), {
    total: 5,
    external: 3,
    commands: 2,
    files: 0,
    agents: 1,
    system: 0,
  });
});

test("deduplicates rollout calls only when the same Turn has an exact native id", () => {
  const sameId = rolloutTool(1, {
    callId: "activity-command",
    id: "rollout:turn-native-activity:function:activity-command",
  });
  const otherTurn = rolloutTool(2, {
    turnId: "turn-other",
    callId: "activity-command",
    id: "rollout:turn-other:function:activity-command",
  });
  const activity = rolloutFeed([sameId, otherTurn]);

  assert.equal(
    summarizeCodexSessionActivity(projection, activity).total,
    10,
  );
  assert.deepEqual(
    selectCodexSessionActivity(projection, "all", activity).map((turn) => [
      turn.turnId,
      turn.entries.length,
    ]),
    [
      [nativeActivityTurn.id, 9],
      ["turn-other", 1],
    ],
  );
});
