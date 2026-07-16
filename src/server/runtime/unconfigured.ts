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
  configureEnvironmentLifecycle = unavailable;
  pauseEnvironment = unavailable;
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
  listFiles = unavailable;
  readFile = unavailable;
  getWorkspaceGitState = unavailable;
  readWorkspaceIdeFile = unavailable;
  writeWorkspaceIdeFile = unavailable;
  watchWorkspaceFiles = unavailable;
  getAudit = unavailable;
  getMetrics = unavailable;
  openTerminal = unavailable;
}
