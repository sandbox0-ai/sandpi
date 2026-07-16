import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceFile, WorkspaceGitFileChange } from "./types";
import {
  mergeWorkspaceGitFiles,
  userVisibleWorkspaceFiles,
} from "./workspace-files";

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

test("removes internal and hidden directories from native and Git-only trees", () => {
  const files: WorkspaceFile[] = [
    {
      id: "workspace",
      name: "workspace",
      path: "/workspace",
      kind: "folder",
      children: [
        {
          id: "internal",
          name: ".sandpi",
          path: "/workspace/.sandpi",
          kind: "folder",
          children: [
            {
              id: "rollout",
              name: "rollout.jsonl",
              path: "/workspace/.sandpi/codex/rollout.jsonl",
              kind: "file",
            },
          ],
        },
        {
          id: "similar",
          name: ".sandpi-other",
          path: "/workspace/.sandpi-other",
          kind: "folder",
        },
        {
          id: "notes",
          name: "notes.md",
          path: "/workspace/notes.md",
          kind: "file",
        },
      ],
    },
  ];
  const internalChange: WorkspaceGitFileChange = {
    ...deleted,
    path: "/workspace/.sandpi/codex/deleted.jsonl",
    relativePath: ".sandpi/codex/deleted.jsonl",
  };
  const renamedFromInternal: WorkspaceGitFileChange = {
    ...deleted,
    path: "/workspace/exported.jsonl",
    relativePath: "exported.jsonl",
    originalPath: "/workspace/.sandpi/codex/rollout.jsonl",
    kind: "renamed",
  };

  const visible = userVisibleWorkspaceFiles(files);
  assert.deepEqual(
    visible[0]?.children?.map((file) => file.path),
    ["/workspace/notes.md"],
  );
  const merged = mergeWorkspaceGitFiles(files, [
    internalChange,
    renamedFromInternal,
  ]);
  assert.deepEqual(
    merged[0]?.children?.map((file) => file.path),
    ["/workspace/notes.md"],
  );
});
