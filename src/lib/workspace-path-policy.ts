export const WORKSPACE_ROOT = "/workspace";
export const WORKSPACE_INTERNAL_ROOT = `${WORKSPACE_ROOT}/.sandpi`;

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
