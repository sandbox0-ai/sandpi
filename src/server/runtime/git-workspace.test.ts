import assert from "node:assert/strict";
import test from "node:test";

import {
  gitRepositoryRootsFromMarkers,
  lineChangesFromDiff,
  mergeLineChanges,
  parseGitStatus,
  wholeFileLineChanges,
} from "./git-workspace";

test("discovers root, nested and worktree Git markers without choosing one", () => {
  assert.deepEqual(
    gitRepositoryRootsFromMarkers(
      [
        "/workspace/.git",
        "/workspace/apps/web/.git",
        "/workspace/packages/linked/.git",
        "/workspace/apps/web/.git",
        "/outside/.git",
        "",
      ].join("\0"),
    ),
    ["/workspace", "/workspace/apps/web", "/workspace/packages/linked"],
  );
});

test("parses porcelain v2 branch, staged, unstaged, rename and untracked state", () => {
  const output = [
    "# branch.oid abc123",
    "# branch.head feature/live-ide",
    "# branch.upstream origin/feature/live-ide",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaa bbb src/with space.ts",
    "1 A. N... 000000 100644 100644 000 bbb src/new.ts",
    "2 R. N... 100644 100644 100644 aaa bbb R100 src/renamed.ts",
    "src/old.ts",
    "? notes/todo.md",
    "",
  ].join("\0");

  const result = parseGitStatus(output);
  assert.equal(result.branch, "feature/live-ide");
  assert.equal(result.upstream, "origin/feature/live-ide");
  assert.equal(result.ahead, 2);
  assert.equal(result.behind, 1);
  assert.deepEqual(
    result.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      staged: file.staged,
      unstaged: file.unstaged,
      originalPath: file.originalPath,
    })),
    [
      {
        path: "/workspace/notes/todo.md",
        kind: "untracked",
        staged: false,
        unstaged: true,
        originalPath: undefined,
      },
      {
        path: "/workspace/src/new.ts",
        kind: "added",
        staged: true,
        unstaged: false,
        originalPath: undefined,
      },
      {
        path: "/workspace/src/renamed.ts",
        kind: "renamed",
        staged: true,
        unstaged: false,
        originalPath: "/workspace/src/old.ts",
      },
      {
        path: "/workspace/src/with space.ts",
        kind: "modified",
        staged: false,
        unstaged: true,
        originalPath: undefined,
      },
    ],
  );
});

test("maps zero-context hunks to visible additions, modifications and deletions", () => {
  const changes = lineChangesFromDiff(
    [
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "@@ -8,3 +10,2 @@",
      "-old",
      "+new",
      "@@ -20,2 +21,0 @@",
    ].join("\n"),
    "unstaged",
  );

  assert.deepEqual(changes, [
    { line: 1, kind: "added", staged: false, unstaged: true },
    { line: 2, kind: "added", staged: false, unstaged: true },
    { line: 10, kind: "modified", staged: false, unstaged: true },
    { line: 11, kind: "modified", staged: false, unstaged: true },
    {
      line: 11,
      kind: "deleted",
      staged: false,
      unstaged: true,
      deletedLines: 1,
      placement: "after",
    },
    {
      line: 21,
      kind: "deleted",
      staged: false,
      unstaged: true,
      deletedLines: 2,
      placement: "after",
    },
  ]);
});

test("merges staged and working-tree markers without losing either source", () => {
  assert.deepEqual(
    mergeLineChanges(
      wholeFileLineChanges(1, "added", "staged"),
      wholeFileLineChanges(1, "modified", "unstaged"),
    ),
    [
      {
        line: 1,
        kind: "added",
        staged: true,
        unstaged: true,
        deletedLines: undefined,
      },
    ],
  );
});

test("distinguishes replacement lines from extra inserted lines in one hunk", () => {
  assert.deepEqual(
    lineChangesFromDiff("@@ -4,1 +4,3 @@\n-old\n+new\n+extra\n+more", "staged"),
    [
      { line: 4, kind: "modified", staged: true, unstaged: false },
      { line: 5, kind: "added", staged: true, unstaged: false },
      { line: 6, kind: "added", staged: true, unstaged: false },
    ],
  );
});
