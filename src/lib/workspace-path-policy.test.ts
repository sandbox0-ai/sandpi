import assert from "node:assert/strict";
import test from "node:test";

import {
  isWorkspaceIdePathHidden,
  isWorkspaceInternalPath,
  normalizeWorkspacePath,
  userVisibleWorkspacePath,
  workspaceFileParentDirectories,
  WORKSPACE_INTERNAL_ROOT,
} from "./workspace-path-policy";

test("protects only the Sandpi-owned Workspace root and its descendants", () => {
  assert.equal(isWorkspaceInternalPath(WORKSPACE_INTERNAL_ROOT), true);
  assert.equal(isWorkspaceInternalPath("/workspace/.sandpi/codex/session.jsonl"), true);
  assert.equal(isWorkspaceInternalPath(".sandpi/codex/session.jsonl"), true);
  assert.equal(isWorkspaceInternalPath("/workspace/src/../.sandpi/state"), true);

  assert.equal(isWorkspaceInternalPath("/workspace/.sandpi-other/state"), false);
  assert.equal(isWorkspaceInternalPath("/workspace/project/.sandpi/state"), false);
  assert.equal(isWorkspaceInternalPath("/workspace/src/index.ts"), false);
});

test("hides directories without hiding root-level dot-files", () => {
  assert.equal(isWorkspaceIdePathHidden("/workspace/.codex", true), true);
  assert.equal(isWorkspaceIdePathHidden("/workspace/.codex/state.sqlite"), true);
  assert.equal(isWorkspaceIdePathHidden("/workspace/node_modules/pkg/index.js"), true);
  assert.equal(isWorkspaceIdePathHidden("/workspace/.env"), false);
  assert.equal(isWorkspaceIdePathHidden("/workspace/src/.env"), false);
  assert.equal(isWorkspaceIdePathHidden("/workspace/src/index.ts"), false);
});

test("normalizes user-facing Workspace paths without admitting paths outside Workspace", () => {
  assert.equal(normalizeWorkspacePath("src/./index.ts"), "/workspace/src/index.ts");
  assert.equal(
    userVisibleWorkspacePath("/workspace/src/../README.md"),
    "/workspace/README.md",
  );
  assert.equal(userVisibleWorkspacePath("/workspace/.sandpi/state"), undefined);
  assert.equal(userVisibleWorkspacePath("../../etc/passwd"), undefined);
  assert.equal(userVisibleWorkspacePath("/etc/passwd"), undefined);
  assert.equal(userVisibleWorkspacePath("/workspace/.sandpi-other"), "/workspace/.sandpi-other");
  assert.equal(userVisibleWorkspacePath("/workspace/project/.sandpi"), "/workspace/project/.sandpi");
});

test("returns the lazy tree directories needed to reveal a Workspace file", () => {
  assert.deepEqual(
    workspaceFileParentDirectories("/workspace/app/globals.css"),
    ["/workspace/app"],
  );
  assert.deepEqual(
    workspaceFileParentDirectories("/workspace/packages/web/src/page.tsx"),
    [
      "/workspace/packages",
      "/workspace/packages/web",
      "/workspace/packages/web/src",
    ],
  );
  assert.deepEqual(
    workspaceFileParentDirectories("/workspace/package.json"),
    [],
  );
  assert.deepEqual(
    workspaceFileParentDirectories("/workspace/.sandpi/state"),
    [],
  );
});
