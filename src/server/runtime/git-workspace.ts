import path from "node:path";

import type {
  WorkspaceGitChangeKind,
  WorkspaceGitFileChange,
  WorkspaceGitState,
  WorkspaceLineChange,
} from "@/lib/types";

function absoluteWorkspacePath(root: string, relativePath: string) {
  const absolute = path.posix.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error("Git returned a path outside its Workspace root.");
  }
  return absolute;
}

function changeKind(
  indexStatus: string,
  worktreeStatus: string,
  recordType: string,
): WorkspaceGitChangeKind {
  if (recordType === "?" || indexStatus === "?" || worktreeStatus === "?") {
    return "untracked";
  }
  if (
    recordType === "u" ||
    indexStatus === "U" ||
    worktreeStatus === "U" ||
    (indexStatus === "A" && worktreeStatus === "A") ||
    (indexStatus === "D" && worktreeStatus === "D")
  ) {
    return "conflicted";
  }
  const statuses = `${indexStatus}${worktreeStatus}`;
  if (statuses.includes("D")) return "deleted";
  if (statuses.includes("R")) return "renamed";
  if (statuses.includes("C")) return "copied";
  if (statuses.includes("A")) return "added";
  return "modified";
}

function fileChange(input: {
  root: string;
  relativePath: string;
  originalRelativePath?: string;
  recordType: string;
  indexStatus: string;
  worktreeStatus: string;
}): WorkspaceGitFileChange {
  const untracked = input.recordType === "?";
  return {
    path: absoluteWorkspacePath(input.root, input.relativePath),
    relativePath: input.relativePath,
    originalPath: input.originalRelativePath
      ? absoluteWorkspacePath(input.root, input.originalRelativePath)
      : undefined,
    kind: changeKind(
      input.indexStatus,
      input.worktreeStatus,
      input.recordType,
    ),
    indexStatus: input.indexStatus,
    worktreeStatus: input.worktreeStatus,
    staged: !untracked && input.indexStatus !== ".",
    unstaged: untracked || input.worktreeStatus !== ".",
  };
}

function recordPath(record: string, prefixFields: number) {
  let cursor = 0;
  for (let index = 0; index < prefixFields; index += 1) {
    cursor = record.indexOf(" ", cursor);
    if (cursor < 0) return "";
    cursor += 1;
  }
  return record.slice(cursor);
}

/** Parse Git porcelain v2's NUL-delimited contract without losing path spaces. */
export function parseGitStatus(
  output: string,
  root = "/workspace",
): WorkspaceGitState {
  const state: WorkspaceGitState = {
    isRepository: true,
    root,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      state.head = value === "(initial)" ? undefined : value;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      state.branch = value === "(detached)" ? "detached HEAD" : value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      state.upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = record.match(/\+(\d+)\s+-(\d+)/);
      state.ahead = Number(match?.[1] ?? 0);
      state.behind = Number(match?.[2] ?? 0);
      continue;
    }

    const recordType = record[0] ?? "";
    if (recordType === "?") {
      const relativePath = record.slice(2);
      state.files.push(
        fileChange({
          root,
          relativePath,
          recordType,
          indexStatus: "?",
          worktreeStatus: "?",
        }),
      );
      continue;
    }
    if (recordType === "1" || recordType === "2" || recordType === "u") {
      const status = record.slice(2, 4);
      const prefixFields = recordType === "1" ? 8 : recordType === "2" ? 9 : 10;
      const relativePath = recordPath(record, prefixFields);
      const originalRelativePath =
        recordType === "2" ? records[(index += 1)] : undefined;
      if (!relativePath) continue;
      state.files.push(
        fileChange({
          root,
          relativePath,
          originalRelativePath,
          recordType,
          indexStatus: status[0] ?? ".",
          worktreeStatus: status[1] ?? ".",
        }),
      );
    }
  }
  state.files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return state;
}

function mergeChange(
  changes: Map<string, WorkspaceLineChange>,
  next: WorkspaceLineChange,
) {
  const key = `${next.line}:${next.placement ?? "line"}`;
  const current = changes.get(key);
  if (!current) {
    changes.set(key, next);
    return;
  }
  const priority = { deleted: 0, modified: 1, added: 2 } as const;
  changes.set(key, {
    ...current,
    kind: priority[next.kind] > priority[current.kind] ? next.kind : current.kind,
    staged: current.staged || next.staged,
    unstaged: current.unstaged || next.unstaged,
    deletedLines: Math.max(current.deletedLines ?? 0, next.deletedLines ?? 0) || undefined,
  });
}

/** Project zero-context Git hunks onto the current file's visible line numbers. */
export function lineChangesFromDiff(
  diff: string,
  source: "staged" | "unstaged",
): WorkspaceLineChange[] {
  const changes = new Map<string, WorkspaceLineChange>();
  const hunkPattern = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of diff.matchAll(hunkPattern)) {
    const oldCount = Number(match[1] ?? 1);
    const newStart = Number(match[2]);
    const newCount = Number(match[3] ?? 1);
    const flags = {
      staged: source === "staged",
      unstaged: source === "unstaged",
    };
    if (newCount === 0) {
      mergeChange(changes, {
        line: Math.max(1, newStart),
        kind: "deleted",
        deletedLines: oldCount,
        placement: newStart === 0 ? "before" : "after",
        ...flags,
      });
      continue;
    }
    for (let offset = 0; offset < newCount; offset += 1) {
      mergeChange(changes, {
        line: Math.max(1, newStart + offset),
        kind: offset < oldCount ? "modified" : "added",
        ...flags,
      });
    }
    if (oldCount > newCount) {
      mergeChange(changes, {
        line: Math.max(1, newStart + newCount - 1),
        kind: "deleted",
        deletedLines: oldCount - newCount,
        placement: "after",
        ...flags,
      });
    }
  }
  return [...changes.values()].sort(
    (left, right) => left.line - right.line,
  );
}

export function mergeLineChanges(
  ...groups: WorkspaceLineChange[][]
): WorkspaceLineChange[] {
  const changes = new Map<string, WorkspaceLineChange>();
  for (const group of groups) {
    for (const change of group) mergeChange(changes, change);
  }
  return [...changes.values()].sort((left, right) => left.line - right.line);
}

export function wholeFileLineChanges(
  lineCount: number,
  kind: "added" | "modified" | "deleted",
  source: "staged" | "unstaged",
) {
  return Array.from({ length: Math.max(lineCount, 1) }, (_, index) => ({
    line: index + 1,
    kind,
    staged: source === "staged",
    unstaged: source === "unstaged",
  })) satisfies WorkspaceLineChange[];
}
