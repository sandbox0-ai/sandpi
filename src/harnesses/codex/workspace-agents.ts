import {
  ApiError,
  apiFetch,
  type ApiEnvelope,
} from "@/lib/api-client";
import type {
  WorkspaceDirectoryListing,
  WorkspaceFile,
} from "@/lib/types";

const WORKSPACE_ROOT = "/workspace";
export const WORKSPACE_AGENTS_PATH = `${WORKSPACE_ROOT}/AGENTS.md`;

/**
 * Returns the root AGENTS.md path, creating an empty file when needed.
 * A second directory read resolves a concurrent create without hiding other
 * Workspace failures.
 */
export async function ensureWorkspaceAgentsFile(environmentId: string) {
  const existing = await readWorkspaceAgentsEntry(environmentId);
  if (existing) return requireAgentsFile(existing);

  try {
    const response = await apiFetch<ApiEnvelope<WorkspaceFile>>(
      `/api/v1/environments/${encodeURIComponent(environmentId)}/ide/entries`,
      {
        method: "POST",
        body: JSON.stringify({
          parentPath: WORKSPACE_ROOT,
          name: "AGENTS.md",
          kind: "file",
        }),
      },
    );
    return requireAgentsFile(response.data);
  } catch (error) {
    if (error instanceof ApiError && error.code === "workspace_entry_exists") {
      const raced = await readWorkspaceAgentsEntry(environmentId);
      if (raced) return requireAgentsFile(raced);
    }
    throw error;
  }
}

async function readWorkspaceAgentsEntry(environmentId: string) {
  const query = new URLSearchParams({ path: WORKSPACE_ROOT });
  const response = await apiFetch<ApiEnvelope<WorkspaceDirectoryListing>>(
    `/api/v1/environments/${encodeURIComponent(environmentId)}/files?${query.toString()}`,
  );
  return response.data.entries.find(
    (entry) => entry.path === WORKSPACE_AGENTS_PATH,
  );
}

function requireAgentsFile(entry: WorkspaceFile) {
  if (
    entry.path !== WORKSPACE_AGENTS_PATH ||
    entry.name !== "AGENTS.md" ||
    entry.kind !== "file"
  ) {
    throw new Error("/workspace/AGENTS.md must be a file.");
  }
  return WORKSPACE_AGENTS_PATH;
}
