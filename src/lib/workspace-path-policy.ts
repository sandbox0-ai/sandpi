export const WORKSPACE_ROOT = "/workspace";
export const WORKSPACE_INTERNAL_ROOT = `${WORKSPACE_ROOT}/.sandpi`;
const WORKSPACE_IGNORED_DIRECTORY_NAMES = new Set(["node_modules"]);

/**
 * Browser-safe POSIX normalization for paths crossing Sandpi's Workspace UI
 * contract. The server remains the security boundary and applies the same
 * internal-root predicate after its own canonical path resolution.
 */
export function normalizeWorkspacePath(candidate: string) {
  if (!candidate || candidate.includes("\0")) return undefined;
  const source = candidate.startsWith("/")
    ? candidate
    : `${WORKSPACE_ROOT}/${candidate}`;
  const components: string[] = [];
  for (const component of source.split("/")) {
    if (!component || component === ".") continue;
    if (component === "..") {
      components.pop();
      continue;
    }
    components.push(component);
  }
  const normalized = `/${components.join("/")}`;
  return normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`)
    ? normalized
    : undefined;
}

/** Exact Sandpi-owned state root; `.sandpi-other` and nested project folders remain user files. */
export function isWorkspaceInternalPath(candidate: string) {
  const normalized = normalizeWorkspacePath(candidate);
  return (
    normalized === WORKSPACE_INTERNAL_ROOT ||
    normalized?.startsWith(`${WORKSPACE_INTERNAL_ROOT}/`) === true
  );
}

/** Returns the canonical path only when it is valid for user-facing Workspace surfaces. */
export function userVisibleWorkspacePath(candidate: string) {
  const normalized = normalizeWorkspacePath(candidate);
  return normalized && !isWorkspaceInternalPath(normalized)
    ? normalized
    : undefined;
}

/** Parent directories that must be loaded to reveal a file in the lazy Workspace tree. */
export function workspaceFileParentDirectories(candidate: string) {
  const normalized = userVisibleWorkspacePath(candidate);
  if (!normalized || normalized === WORKSPACE_ROOT) return [];
  const components = normalized
    .slice(`${WORKSPACE_ROOT}/`.length)
    .split("/")
    .slice(0, -1);
  return components.map(
    (_, index) =>
      `${WORKSPACE_ROOT}/${components.slice(0, index + 1).join("/")}`,
  );
}

/**
 * Shared file-tree visibility rule. Dot-directories and generated dependency
 * trees are hidden, while root-level dot-files such as `.env` remain visible.
 */
export function isWorkspaceIdePathHidden(
  candidate: string,
  leafIsDirectory = false,
) {
  const normalized = userVisibleWorkspacePath(candidate);
  if (!normalized) return true;
  const parts = normalized.slice(`${WORKSPACE_ROOT}/`.length).split("/");
  const directoryParts = leafIsDirectory ? parts : parts.slice(0, -1);
  return directoryParts.some(
    (component) =>
      component.startsWith(".") ||
      WORKSPACE_IGNORED_DIRECTORY_NAMES.has(component),
  );
}
