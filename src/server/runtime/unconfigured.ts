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
  deleteSessionResources = async () => undefined;
  createVolumeCheckpoint = unavailable;
  findVolumeCheckpoint = unavailable;
  deleteVolumeCheckpoint = async () => undefined;
  restoreVolumeCheckpoint = unavailable;
  provisionCodexAuth = unavailable;
  deleteCodexAuthResources = async () => undefined;
  writeCodexAuthMessage = unavailable;
  listCodexAuthEvents = unavailable;
  readCodexAuthJson = unavailable;
  installCodexSessionCredential = unavailable;
  readCodexSessionCredential = unavailable;
  recoverCodexRuntime = unavailable;
  migrateCodexNativeState = unavailable;
  cleanupLegacyCodexNativeState = async () => undefined;
  writeCodexMessage = unavailable;
  stageCodexMessage = unavailable;
  hasStagedCodexMessage = unavailable;
  dispatchStagedCodexMessage = unavailable;
  discardStagedCodexMessage = async () => undefined;
  listCodexEvents = unavailable;
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
