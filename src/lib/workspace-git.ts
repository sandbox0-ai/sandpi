import type {
  WorkspaceGitFileChange,
  WorkspaceGitRepository,
  WorkspaceGitState,
} from "./types";

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
  let selected: WorkspaceGitRepository | undefined;
  for (const repository of repositories) {
    if (
      containsPath(repository, filePath) &&
      (!selected || repository.root.length > selected.root.length)
    ) {
      selected = repository;
    }
  }
  return selected;
}

/**
 * Flattens per-repository status without leaking a parent repository's nested
 * repository placeholder into the file tree.
 */
export function workspaceGitChanges(
  state: WorkspaceGitState | undefined,
): WorkspaceGitFileChange[] {
  const repositories = state?.repositories ?? [];
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
