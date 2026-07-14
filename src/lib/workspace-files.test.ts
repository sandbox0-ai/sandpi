import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceFile, WorkspaceGitFileChange } from "./types";
import { mergeWorkspaceGitFiles } from "./workspace-files";

const deleted: WorkspaceGitFileChange = {
  path: "/workspace/src/deleted.ts",
  relativePath: "src/deleted.ts",
  kind: "deleted",
  indexStatus: ".",
  worktreeStatus: "D",
  staged: false,
  unstaged: true,
};

test("adds Git-only deleted files to the Workspace tree without mutating input", () => {
  const files: WorkspaceFile[] = [
    {
      id: "workspace",
      name: "workspace",
      path: "/workspace",
      kind: "folder",
      children: [],
    },
  ];

  const merged = mergeWorkspaceGitFiles(files, [deleted]);
  assert.deepEqual(merged[0]?.children, [
    {
      id: "git:/workspace/src",
      name: "src",
      path: "/workspace/src",
      kind: "folder",
      children: [
        {
          id: "git:/workspace/src/deleted.ts",
          name: "deleted.ts",
          path: "/workspace/src/deleted.ts",
          kind: "file",
        },
      ],
    },
  ]);
  assert.deepEqual(files[0]?.children, []);
});

test("does not duplicate a changed file already returned by Sandbox0", () => {
  const existing: WorkspaceFile = {
    id: "deleted",
    name: "deleted.ts",
    path: deleted.path,
    kind: "file",
  };
  const files: WorkspaceFile[] = [
    {
      id: "workspace",
      name: "workspace",
      path: "/workspace",
      kind: "folder",
      children: [
        {
          id: "src",
          name: "src",
          path: "/workspace/src",
          kind: "folder",
          children: [existing],
        },
      ],
    },
  ];

  const merged = mergeWorkspaceGitFiles(files, [deleted]);
  assert.equal(merged[0]?.children?.[0]?.children?.length, 1);
});
