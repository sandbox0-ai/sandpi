import assert from "node:assert/strict";
import test from "node:test";

import {
  codexAgentThreadName,
  codexAgentThreadRows,
} from "./agent-threads";
import type { CodexAgentThreads, CodexThread } from "./types";

function thread(
  id: string,
  parentThreadId?: string,
  createdAt = 1,
): CodexThread {
  return {
    id,
    parentThreadId,
    createdAt,
    status: { type: "notLoaded" },
    turns: [],
  };
}

test("orders native Agent Threads by their parent relation", () => {
  const tree: CodexAgentThreads = {
    root: thread("root"),
    descendants: [
      thread("grandchild", "child-a", 3),
      thread("child-b", "root", 2),
      thread("child-a", "root", 1),
    ],
  };

  assert.deepEqual(
    codexAgentThreadRows(tree).map(({ thread: value, depth, root }) => ({
      id: value.id,
      depth,
      root,
    })),
    [
      { id: "root", depth: 0, root: true },
      { id: "child-a", depth: 1, root: false },
      { id: "grandchild", depth: 2, root: false },
      { id: "child-b", depth: 1, root: false },
    ],
  );
});

test("uses native nickname, role, preview and id fallbacks for Agent names", () => {
  assert.equal(
    codexAgentThreadName({
      ...thread("one"),
      agentNickname: "Scout",
      agentRole: "explorer",
    }),
    "Scout",
  );
  assert.equal(
    codexAgentThreadName({ ...thread("two"), agentRole: "reviewer" }),
    "reviewer",
  );
  assert.equal(
    codexAgentThreadName({ ...thread("three"), preview: "Inspect auth\nlater" }),
    "Inspect auth",
  );
  assert.equal(codexAgentThreadName(thread("thread-12345678")), "Agent 12345678");
});
