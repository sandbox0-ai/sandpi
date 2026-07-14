import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceGitRepository } from "./types";
import {
  repositoryForWorkspacePath,
  workspaceGitChanges,
  workspaceRepositoryLabel,
} from "./workspace-git";

function repository(
  root: string,
  files: WorkspaceGitRepository["files"] = [],
): WorkspaceGitRepository {
  return { root, ahead: 0, behind: 0, files };
}

test("selects the innermost repository without assuming /workspace is Git", () => {
  const repositories = [
    repository("/workspace"),
    repository("/workspace/apps/web"),
  ];
  assert.equal(
    repositoryForWorkspacePath(
      repositories,
      "/workspace/apps/web/src/page.tsx",
    )?.root,
    "/workspace/apps/web",
  );
  assert.equal(
    repositoryForWorkspacePath(repositories, "/workspace/notes.txt")?.root,
    "/workspace",
  );
  assert.equal(
    repositoryForWorkspacePath(
      [repository("/workspace/apps/web")],
      "/workspace/notes.txt",
    ),
    undefined,
  );
});

test("drops a parent repository placeholder for a nested repository", () => {
  const parentPlaceholder = {
    path: "/workspace/apps/web",
    relativePath: "apps/web",
    kind: "untracked" as const,
    indexStatus: "?",
    worktreeStatus: "?",
    staged: false,
    unstaged: true,
  };
  const nestedChange = {
    path: "/workspace/apps/web/src/page.tsx",
    relativePath: "src/page.tsx",
    kind: "modified" as const,
    indexStatus: ".",
    worktreeStatus: "M",
    staged: false,
    unstaged: true,
  };
  assert.deepEqual(
    workspaceGitChanges({
      repositories: [
        repository("/workspace", [parentPlaceholder]),
        repository("/workspace/apps/web", [nestedChange]),
      ],
    }),
    [nestedChange],
  );
});

test("formats repository roots relative to the Workspace mount", () => {
  assert.equal(workspaceRepositoryLabel("/workspace"), "workspace");
  assert.equal(workspaceRepositoryLabel("/workspace/apps/web"), "apps/web");
});
