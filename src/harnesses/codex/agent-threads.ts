import type { CodexAgentThreads, CodexThread } from "./types";

export interface CodexAgentThreadRow {
  thread: CodexThread;
  depth: number;
  root: boolean;
}

function compareThreads(left: CodexThread, right: CodexThread) {
  const createdDifference = (left.createdAt ?? 0) - (right.createdAt ?? 0);
  return createdDifference || left.id.localeCompare(right.id);
}

/** Flatten the native parent graph into a stable tree suitable for a picker. */
export function codexAgentThreadRows(
  tree: CodexAgentThreads,
): CodexAgentThreadRow[] {
  const children = new Map<string, CodexThread[]>();
  for (const thread of tree.descendants) {
    const parentId = thread.parentThreadId ?? tree.root.id;
    const siblings = children.get(parentId) ?? [];
    siblings.push(thread);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(compareThreads);
  }

  const rows: CodexAgentThreadRow[] = [
    { thread: tree.root, depth: 0, root: true },
  ];
  const visited = new Set([tree.root.id]);
  const appendChildren = (parentId: string, depth: number) => {
    for (const thread of children.get(parentId) ?? []) {
      if (visited.has(thread.id)) continue;
      visited.add(thread.id);
      rows.push({ thread, depth, root: false });
      appendChildren(thread.id, depth + 1);
    }
  };
  appendChildren(tree.root.id, 1);

  // The server validates ancestry. Keep malformed mocked or older responses
  // visible instead of silently losing them in the browser.
  for (const thread of [...tree.descendants].sort(compareThreads)) {
    if (!visited.has(thread.id)) {
      rows.push({ thread, depth: 1, root: false });
    }
  }
  return rows;
}

export function codexAgentThreadName(thread: CodexThread, root = false) {
  if (root) return thread.name?.trim() || "Main";
  return (
    thread.agentNickname?.trim() ||
    thread.name?.trim() ||
    thread.agentRole?.trim() ||
    thread.preview?.trim().split("\n", 1)[0]?.slice(0, 72) ||
    `Agent ${thread.id.slice(-8)}`
  );
}
