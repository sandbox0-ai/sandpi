import type {
  WorkspaceGitFileChange,
  WorkspaceGitRepository,
  WorkspaceGitState,
} from "./types";
import {
  isWorkspaceInternalPath,
  isWorkspaceIdePathHidden,
  userVisibleWorkspacePath,
} from "./workspace-path-policy";

function containsPath(repository: WorkspaceGitRepository, filePath: string) {
  return (
    filePath === repository.root || filePath.startsWith(`${repository.root}/`)
  );
}

/** Returns the innermost working tree that owns a Workspace path. */
export function repositoryForWorkspacePath(
  repositories: readonly WorkspaceGitRepository[],
  filePath: string,
) {
  const visibleFilePath = userVisibleWorkspacePath(filePath);
  if (
    !visibleFilePath ||
    isWorkspaceInternalPath(visibleFilePath) ||
    isWorkspaceIdePathHidden(visibleFilePath)
  ) {
    return undefined;
  }
  let selected: WorkspaceGitRepository | undefined;
  for (const repository of repositories) {
    const visibleRoot = userVisibleWorkspacePath(repository.root);
    if (
      !visibleRoot ||
      isWorkspaceInternalPath(visibleRoot) ||
      isWorkspaceIdePathHidden(visibleRoot, true)
    ) {
      continue;
    }
    if (
      containsPath({ ...repository, root: visibleRoot }, visibleFilePath) &&
      (!selected || visibleRoot.length > selected.root.length)
    ) {
      selected = { ...repository, root: visibleRoot };
    }
  }
  return selected;
}

/** Client-side defense for Git data returned by old servers or test fixtures. */
export function userVisibleWorkspaceGitState(
  state: WorkspaceGitState | undefined,
): WorkspaceGitState {
  return {
    repositories: (state?.repositories ?? []).flatMap((repository) => {
      const root = userVisibleWorkspacePath(repository.root);
      if (
        !root ||
        isWorkspaceInternalPath(root) ||
        isWorkspaceIdePathHidden(root, true)
      ) {
        return [];
      }
      const files = repository.files.flatMap((change) => {
        const filePath = userVisibleWorkspacePath(change.path);
        const originalPath = change.originalPath
          ? userVisibleWorkspacePath(change.originalPath)
          : undefined;
        if (
          !filePath ||
          isWorkspaceInternalPath(filePath) ||
          isWorkspaceIdePathHidden(filePath) ||
          (filePath !== root && !filePath.startsWith(`${root}/`)) ||
          (change.originalPath &&
            (!originalPath ||
              isWorkspaceInternalPath(originalPath) ||
              isWorkspaceIdePathHidden(originalPath) ||
              (originalPath !== root && !originalPath.startsWith(`${root}/`))))
        ) {
          return [];
        }
        return [
          {
            ...change,
            path: filePath,
            relativePath:
              filePath === root ? "" : filePath.slice(`${root}/`.length),
            ...(change.originalPath ? { originalPath } : {}),
          },
        ];
      });
      return [{ ...repository, root, files }];
    }),
  };
}

/**
 * Flattens per-repository status without leaking a parent repository's nested
 * repository placeholder into the file tree.
 */
export function workspaceGitChanges(
  state: WorkspaceGitState | undefined,
): WorkspaceGitFileChange[] {
  const repositories = userVisibleWorkspaceGitState(state).repositories;
  return repositories.flatMap((repository) =>
    repository.files.filter(
      (change) =>
        repositoryForWorkspacePath(repositories, change.path)?.root ===
        repository.root,
    ),
  );
}

export function workspaceRepositoryLabel(root: string) {
  if (root === "/workspace") return "workspace";
  return root.startsWith("/workspace/")
    ? root.slice("/workspace/".length)
    : root;
}
