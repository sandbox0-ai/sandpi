import type { WorkspaceFile, WorkspaceGitFileChange } from "./types";

function cloneFile(file: WorkspaceFile): WorkspaceFile {
  return {
    ...file,
    children: file.children?.map(cloneFile),
  };
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
  const merged = files.map(cloneFile);
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
    if (
      entries.has(change.path) ||
      !change.path.startsWith("/workspace/")
    ) {
      continue;
    }
    const parts = change.path.slice("/workspace/".length).split("/");
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
    if (!validParent || !name || entries.has(change.path)) continue;
    parent.children ??= [];
    const file: WorkspaceFile = {
      id: `git:${change.path}`,
      name,
      path: change.path,
      kind: "file",
    };
    parent.children.push(file);
    entries.set(change.path, file);
  }

  sortFiles(merged);
  return merged;
}
