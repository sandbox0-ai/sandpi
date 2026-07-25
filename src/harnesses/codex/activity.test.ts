import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CodexCommandActivity,
  CodexNativeToolActivity,
  CodexTurnActivity,
} from "./activity";
import type {
  CodexCommandActivityView,
  CodexMcpToolCallActivityView,
} from "./events";

const runningCommand: CodexCommandActivityView = {
  kind: "command",
  id: "command-running",
  turnId: "turn-running",
  createdAt: 1_000,
  status: "running",
  command: "npm test",
  cwd: "/workspace",
  output: "",
  outputTruncated: false,
  exitCode: null,
  durationMs: null,
  exploration: false,
  waitingForProcess: false,
};

function renderRunningCommand(
  overrides: Partial<CodexCommandActivityView> = {},
) {
  return renderToStaticMarkup(
    createElement(CodexCommandActivity, {
      activity: { ...runningCommand, ...overrides },
      compact: true,
      language: "en",
    }),
  );
}

function runningMcpTool(
  argumentsValue: unknown,
): CodexMcpToolCallActivityView {
  return {
    kind: "mcpToolCall",
    id: "mcp-running",
    turnId: "turn-running",
    createdAt: 1_000,
    status: "running",
    server: "github",
    tool: "search_code",
    appName: "GitHub",
    arguments: argumentsValue,
    result: null,
    error: null,
    durationMs: null,
  };
}

test("renders a childless running Turn as status instead of an empty disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(CodexTurnActivity, {
      activeTurn: {
        turnId: "turn-running",
        startedAt: 1_000,
        state: "thinking",
      },
      language: "en",
      now: 1_002_000,
    }),
  );

  assert.match(html, /codex-turn-activity-static/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /Thinking/);
});

test("does not make a running command expandable for its working directory alone", () => {
  const html = renderRunningCommand();

  assert.doesNotMatch(html, /<details/);
  assert.match(html, /npm test/);
  assert.doesNotMatch(html, /Working directory/);
});

test("opens live command output directly and closes it after completion", () => {
  const runningHtml = renderRunningCommand({ output: "test 1 passed\n" });
  const completedHtml = renderRunningCommand({
    status: "completed",
    output: "test 1 passed\n",
    durationMs: 420,
  });

  assert.match(runningHtml, /<details[^>]* open=""/);
  assert.match(runningHtml, /test 1 passed/);
  assert.doesNotMatch(completedHtml, /<details[^>]* open=""/);
});

test("shows meaningful live MCP arguments without a nested disclosure", () => {
  const html = renderToStaticMarkup(
    createElement(CodexNativeToolActivity, {
      activity: runningMcpTool({ query: "repo:sandbox0/sandpi" }),
      compact: true,
      language: "en",
    }),
  );

  assert.equal(html.match(/<details/g)?.length, 1);
  assert.match(html, /<details[^>]* open=""/);
  assert.match(html, /repo:sandbox0\/sandpi/);
  assert.match(html, /arguments/);
});

test("does not expose an empty live MCP arguments disclosure", () => {
  const compactHtml = renderToStaticMarkup(
    createElement(CodexNativeToolActivity, {
      activity: runningMcpTool({}),
      compact: true,
      language: "en",
    }),
  );
  const conversationHtml = renderToStaticMarkup(
    createElement(CodexNativeToolActivity, {
      activity: runningMcpTool({}),
      language: "en",
    }),
  );

  assert.doesNotMatch(compactHtml, /<details/);
  assert.doesNotMatch(conversationHtml, /<details/);
  assert.match(compactHtml, /GitHub · search_code/);
});
