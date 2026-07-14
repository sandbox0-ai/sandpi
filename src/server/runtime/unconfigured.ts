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
  provisionSession = unavailable;
  forkSession = unavailable;
  forkTurn = unavailable;
  deleteCodexThreadImport = async () => undefined;
  deleteSessionResources = async () => undefined;
  createWorkspaceCheckpoint = unavailable;
  deleteWorkspaceCheckpoint = async () => undefined;
  restoreWorkspaceCheckpoint = unavailable;
  provisionCodexAuth = unavailable;
  deleteCodexAuthResources = async () => undefined;
  writeCodexAuthMessage = unavailable;
  listCodexAuthEvents = unavailable;
  readCodexAuthJson = unavailable;
  installCodexSessionCredential = unavailable;
  readCodexSessionCredential = unavailable;
  writeCodexMessage = unavailable;
  listCodexEvents = unavailable;
  listFiles = unavailable;
  readFile = unavailable;
  getWorkspaceGitState = unavailable;
  readWorkspaceIdeFile = unavailable;
  watchWorkspaceFiles = unavailable;
  getAudit = unavailable;
  getMetrics = unavailable;
  openTerminal = unavailable;
}
