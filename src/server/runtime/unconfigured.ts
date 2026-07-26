import { HttpError } from "@/server/http-error";
import type { RuntimeAdapter } from "./types";

function unavailable(): never {
  throw new HttpError(
    503,
    "sandbox0_not_configured",
    "This Sandpi deployment has not configured Sandbox0.",
  );
}

export class UnconfiguredRuntime implements RuntimeAdapter {
  readonly mode = "unconfigured" as const;

  provisionEnvironment = unavailable;
  deleteEnvironmentResources = async () => undefined;
  updateEnvironmentNetworkPolicy = unavailable;
  getEnvironmentCredentialSource = unavailable;
  createEnvironmentCredentialSource = unavailable;
  updateEnvironmentCredentialSource = unavailable;
  deleteEnvironmentCredentialSource = unavailable;
  updateEnvironmentMemory = unavailable;
  ensureEnvironmentMcpOAuthCallbackService = unavailable;
  createEnvironmentWorkspaceBackup = unavailable;
  deleteEnvironmentWorkspaceBackup = unavailable;
  restoreEnvironmentWorkspaceBackup = unavailable;
  applyEnvironmentLifecyclePolicy = unavailable;
  pauseEnvironment = unavailable;
  ensureEnvironmentRuntimeAccess = unavailable;
  ensureCodexEnvironmentRuntime = unavailable;
  provisionCodexAuth = unavailable;
  deleteCodexAuthResources = async () => undefined;
  writeCodexAuthMessage = unavailable;
  listCodexAuthEvents = unavailable;
  readCodexAuthJson = unavailable;
  installCodexEnvironmentCredential = unavailable;
  readCodexEnvironmentCredential = unavailable;
  writeCodexMessage = unavailable;
  watchCodexEvents = unavailable;
  readCodexRollout = unavailable;
  listFiles = unavailable;
  searchFiles = unavailable;
  writeCodexComposerUpload = unavailable;
  readFile = unavailable;
  getWorkspaceGitState = unavailable;
  readWorkspaceIdeFile = unavailable;
  writeWorkspaceIdeFile = unavailable;
  createWorkspaceIdeEntry = unavailable;
  renameWorkspaceIdeEntry = unavailable;
  deleteWorkspaceIdeEntry = unavailable;
  watchWorkspaceFiles = unavailable;
  getMetrics = unavailable;
  openTerminal = unavailable;
}
