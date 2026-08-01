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

  getEnvironmentSandboxState = unavailable;
  getEnvironmentSandboxUsageProjection = unavailable;
  supportsUsageWindows = () => false;
  listUsageWindows = unavailable;
  provisionEnvironment = unavailable;
  deleteEnvironmentResources = async () => undefined;
  deleteRetiredEnvironmentSandboxes = async () => undefined;
  updateEnvironmentNetworkPolicy = unavailable;
  getEnvironmentCredentialSource = unavailable;
  createEnvironmentCredentialSource = unavailable;
  updateEnvironmentCredentialSource = unavailable;
  deleteEnvironmentCredentialSource = unavailable;
  updateEnvironmentMemory = unavailable;
  ensureEnvironmentMcpOAuthCallbackService = unavailable;
  updateEnvironmentBrowserControl = unavailable;
  ensureEnvironmentBrowserService = unavailable;
  ensureEnvironmentBrowserSession = unavailable;
  openEnvironmentBrowserUrl = unavailable;
  resizeEnvironmentBrowserViewport = unavailable;
  createEnvironmentWorkspaceBackup = unavailable;
  deleteEnvironmentWorkspaceBackup = unavailable;
  restoreEnvironmentWorkspaceBackup = unavailable;
  applyEnvironmentLifecyclePolicy = unavailable;
  pauseEnvironment = unavailable;
  resumeEnvironment = unavailable;
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
  listPersistentWorkspaceFiles = unavailable;
  searchFiles = unavailable;
  writeCodexComposerUpload = unavailable;
  replaceCodexEnvironmentSkill = unavailable;
  deleteCodexEnvironmentSkill = unavailable;
  readFile = unavailable;
  readPersistentWorkspaceFile = unavailable;
  getWorkspaceGitState = unavailable;
  readWorkspaceIdeFile = unavailable;
  readPersistentWorkspaceIdeFile = unavailable;
  writeWorkspaceIdeFile = unavailable;
  createWorkspaceIdeEntry = unavailable;
  renameWorkspaceIdeEntry = unavailable;
  deleteWorkspaceIdeEntry = unavailable;
  watchWorkspaceFiles = unavailable;
  getMetrics = unavailable;
  getResourceMetrics = unavailable;
  openTerminal = unavailable;
}
