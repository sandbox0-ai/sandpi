import type { WorkspaceFile, WorkspaceGitFileChange } from "./types";
import { userVisibleWorkspacePath } from "./workspace-path-policy";

function cloneVisibleFile(file: WorkspaceFile): WorkspaceFile | undefined {
  const filePath = userVisibleWorkspacePath(file.path);
  if (!filePath) return undefined;
  return {
    ...file,
    path: filePath,
    children: file.children
      ?.map(cloneVisibleFile)
      .filter((child): child is WorkspaceFile => child !== undefined),
  };
}

/** Client-side defense for snapshots produced by old servers or test fixtures. */
export function userVisibleWorkspaceFiles(files: WorkspaceFile[]) {
  return files
    .map(cloneVisibleFile)
    .filter((file): file is WorkspaceFile => file !== undefined);
}

function sortFiles(files: WorkspaceFile[]) {
  files.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const file of files) {
    if (file.children) sortFiles(file.children);
  }
}

/**
 * Git can report a deleted file that no longer exists in Sandbox0's file tree.
 * Keep those entries in the single Workspace tree so removing a separate source
 * control pane never makes an uncommitted change unreachable.
 */
export function mergeWorkspaceGitFiles(
  files: WorkspaceFile[],
  changes: WorkspaceGitFileChange[],
): WorkspaceFile[] {
  const merged = userVisibleWorkspaceFiles(files);
  const entries = new Map<string, WorkspaceFile>();

  const index = (items: WorkspaceFile[]) => {
    for (const item of items) {
      entries.set(item.path, item);
      if (item.children) index(item.children);
    }
  };
  index(merged);

  let workspace = entries.get("/workspace");
  if (!workspace) {
    workspace = {
      id: "workspace",
      name: "workspace",
      path: "/workspace",
      kind: "folder",
      children: [],
    };
    merged.unshift(workspace);
    entries.set(workspace.path, workspace);
  }

  for (const change of changes) {
    const changePath = userVisibleWorkspacePath(change.path);
    const originalPath = change.originalPath
      ? userVisibleWorkspacePath(change.originalPath)
      : undefined;
    if (
      !changePath ||
      (change.originalPath && !originalPath) ||
      entries.has(changePath) ||
      !changePath.startsWith("/workspace/")
    ) {
      continue;
    }
    const parts = changePath.slice("/workspace/".length).split("/");
    let parent = workspace;
    let parentPath = "/workspace";
    let validParent = true;

    for (const part of parts.slice(0, -1)) {
      const folderPath = `${parentPath}/${part}`;
      const existing = entries.get(folderPath);
      if (existing) {
        if (existing.kind !== "folder") {
          validParent = false;
          break;
        }
        parent = existing;
        parentPath = folderPath;
        continue;
      }
      const folder: WorkspaceFile = {
        id: `git:${folderPath}`,
        name: part,
        path: folderPath,
        kind: "folder",
        children: [],
      };
      parent.children ??= [];
      parent.children.push(folder);
      entries.set(folderPath, folder);
      parent = folder;
      parentPath = folderPath;
    }

    const name = parts.at(-1);
    if (!validParent || !name || entries.has(changePath)) continue;
    parent.children ??= [];
    const file: WorkspaceFile = {
      id: `git:${changePath}`,
      name,
      path: changePath,
      kind: "file",
    };
    parent.children.push(file);
    entries.set(changePath, file);
  }

  sortFiles(merged);
  return merged;
}
