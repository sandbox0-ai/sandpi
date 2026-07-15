import type {
  Environment,
  NetworkPolicy,
  SessionAuditFeed,
  SessionMetrics,
  WorkspaceFile,
  WorkspaceGitState,
  WorkspaceIdeFile,
} from "@/lib/types";
import type { SessionMetricRangeSeconds } from "@/lib/session-metrics";
import type { UnixTimestamp } from "@/lib/time";

export interface ProvisionedEnvironment {
  workspaceVolumeId: string;
  rootfsSnapshotId?: string;
}

export type HarnessStateLayout = "rootfs_v1" | "workspace_v2" | "migrating";

export interface ProvisionedSession {
  sandboxId: string;
  workspaceVolumeId: string;
  supervisorSessionId: string;
  attemptId: string;
  runtimeGeneration: number;
  nativeCredentialTargetPath: string;
  /** New runtime allocations always keep native harness state in the Volume. */
  harnessStateLayout: "workspace_v2";
}

export const CODEX_SESSION_CREDENTIAL_PATH = "/dev/shm/sandpi-codex-auth.json";

export interface RuntimeSessionRecord {
  id: string;
  sandboxId: string;
  workspaceVolumeId: string;
  supervisorSessionId: string;
  terminalSessionId?: string;
  supervisorCursor: number;
  /** Opaque coding-agent native Session id; Codex names it a thread id. */
  nativeSessionId?: string;
  harnessStateLayout: HarnessStateLayout;
  modelId?: string;
  attemptId?: string;
  runtimeGeneration?: number;
}

export interface RuntimeProvisionSessionInput {
  sessionId: string;
  environment: Environment;
  /**
   * Native Codex credential file, decrypted immediately before provisioning.
   * Runtime implementations must place it in ephemeral storage that is not part
   * of the sandbox rootfs or workspace volume snapshot boundary.
   */
  codexAuthJson: string;
  /**
   * Durable allocation journal callback. Runtime implementations invoke it
   * after every external resource allocation so a restarted Sandpi server can
   * finish cleanup even when provisioning never returns.
   */
  onResourcesAllocated?: (
    resources: Partial<ProvisionedSession>,
  ) => Promise<void>;
}

export interface RuntimeForkSessionInput extends RuntimeProvisionSessionInput {
  source: RuntimeSessionRecord;
}

export interface RuntimeForkTurnInput extends RuntimeProvisionSessionInput {
  workspaceSnapshotId: string;
}

export interface VolumeCheckpoint {
  snapshotId: string;
}

export interface RestoredWorkspaceRuntime {
  attemptId: string;
  runtimeGeneration: number;
}

export interface RecoveredCodexRuntime {
  supervisorSessionId: string;
  attemptId: string;
  runtimeGeneration: number;
  sandboxRestarted: boolean;
}

export interface MigratedCodexNativeState extends RecoveredCodexRuntime {
  harnessStateLayout: "workspace_v2";
  /** Exact rootfs evidence captured after the legacy Supervisor was stopped. */
  sourceHadRollout: boolean;
}

export interface CodexAuthRuntime {
  sandboxId: string;
  supervisorSessionId: string;
  attemptId: string;
  runtimeGeneration: number;
}

export interface RuntimeAdapter {
  readonly mode: "sandbox0" | "unconfigured";
  provisionEnvironment(): Promise<ProvisionedEnvironment>;
  deleteEnvironmentResources(resources: ProvisionedEnvironment): Promise<void>;
  provisionSession(input: RuntimeProvisionSessionInput): Promise<ProvisionedSession>;
  forkSession(input: RuntimeForkSessionInput): Promise<ProvisionedSession>;
  forkTurn(input: RuntimeForkTurnInput): Promise<ProvisionedSession>;
  deleteSessionResources(resources: Partial<ProvisionedSession>): Promise<void>;
  createVolumeCheckpoint(
    runtime: RuntimeSessionRecord,
    label: string,
  ): Promise<VolumeCheckpoint>;
  findVolumeCheckpoint(
    runtime: RuntimeSessionRecord,
    label: string,
  ): Promise<VolumeCheckpoint | undefined>;
  deleteVolumeCheckpoint(
    runtime: RuntimeSessionRecord,
    snapshotId: string,
  ): Promise<void>;
  restoreVolumeCheckpoint(
    runtime: RuntimeSessionRecord,
    snapshotId: string,
  ): Promise<RestoredWorkspaceRuntime>;
  provisionCodexAuth(
    environment: Environment,
    flowId: string,
  ): Promise<CodexAuthRuntime>;
  deleteCodexAuthResources(resources: Partial<CodexAuthRuntime>): Promise<void>;
  writeCodexAuthMessage(
    runtime: CodexAuthRuntime,
    message: unknown,
    stableInputId?: string,
  ): Promise<void>;
  listCodexAuthEvents(
    runtime: CodexAuthRuntime,
    after?: number,
  ): Promise<{ events: unknown[]; cursor: { earliest: number; latest: number } }>;
  readCodexAuthJson(runtime: CodexAuthRuntime): Promise<string>;
  installCodexSessionCredential(
    runtime: RuntimeSessionRecord,
    authJson: string,
  ): Promise<void>;
  readCodexSessionCredential(runtime: RuntimeSessionRecord): Promise<string>;
  recoverCodexRuntime(
    runtime: RuntimeSessionRecord,
    authJson: string,
  ): Promise<RecoveredCodexRuntime>;
  migrateCodexNativeState(
    runtime: RuntimeSessionRecord,
    authJson: string,
  ): Promise<MigratedCodexNativeState>;
  /** Called only after the service durably commits workspace_v2 coordinates. */
  cleanupLegacyCodexNativeState(runtime: RuntimeSessionRecord): Promise<void>;
  writeCodexMessage(
    runtime: RuntimeSessionRecord,
    message: unknown,
    stableInputId?: string,
  ): Promise<void>;
  /** Stages an exact native RPC frame in the Session rootfs, outside snapshots. */
  stageCodexMessage(
    runtime: RuntimeSessionRecord,
    message: unknown,
    stableInputId: string,
  ): Promise<void>;
  hasStagedCodexMessage(
    runtime: RuntimeSessionRecord,
    stableInputId: string,
  ): Promise<boolean>;
  dispatchStagedCodexMessage(
    runtime: RuntimeSessionRecord,
    stableInputId: string,
  ): Promise<void>;
  discardStagedCodexMessage(
    runtime: RuntimeSessionRecord,
    stableInputId: string,
  ): Promise<void>;
  listCodexEvents(
    runtime: RuntimeSessionRecord,
    after?: number,
  ): Promise<{ events: unknown[]; cursor: { earliest: number; latest: number } }>;
  listFiles(runtime: RuntimeSessionRecord, path: string): Promise<WorkspaceFile[]>;
  readFile(runtime: RuntimeSessionRecord, path: string): Promise<Uint8Array>;
  getWorkspaceGitState(runtime: RuntimeSessionRecord): Promise<WorkspaceGitState>;
  readWorkspaceIdeFile(
    runtime: RuntimeSessionRecord,
    path: string,
  ): Promise<WorkspaceIdeFile>;
  writeWorkspaceIdeFile(
    runtime: RuntimeSessionRecord,
    path: string,
    content: Uint8Array,
    baseRevision: string,
  ): Promise<WorkspaceIdeFile>;
  watchWorkspaceFiles(
    runtime: RuntimeSessionRecord,
  ): Promise<RuntimeWorkspaceWatchHandle>;
  getAudit(runtime: RuntimeSessionRecord): Promise<SessionAuditFeed>;
  getMetrics(
    runtime: RuntimeSessionRecord,
    rangeSeconds: SessionMetricRangeSeconds,
  ): Promise<SessionMetrics>;
  openTerminal(
    runtime: RuntimeSessionRecord,
    after?: number,
    expectedTerminalSessionId?: string,
  ): Promise<RuntimeTerminalHandle>;
}

export interface RuntimeTerminalMessage {
  type: "ack" | "error" | "event";
  requestId?: string;
  error?: string;
  event?: {
    seq: number;
    attemptId?: string;
    stream?: string;
    dataBase64?: string;
    type: string;
    occurredAt: UnixTimestamp;
  };
}

export interface RuntimeTerminalHandle {
  sessionId: string;
  attemptId: string;
  /** Effective Supervisor cursor used for this attachment. */
  replayAfter: number;
  /** Journal head captured before attaching the live event stream. */
  replayUntil: number;
  /** The retained journal no longer continues the browser's prior screen. */
  replayReset: boolean;
  messages: AsyncIterable<RuntimeTerminalMessage>;
  send(message: {
    type: "input" | "resize" | "signal";
    requestId: string;
    data?: Uint8Array;
    rows?: number;
    cols?: number;
    signal?: string;
  }): void;
  close(): void;
}

export interface RuntimeWorkspaceWatchMessage {
  event: string;
  path: string;
}

export interface RuntimeWorkspaceWatchHandle {
  messages: AsyncIterable<RuntimeWorkspaceWatchMessage>;
  close(): void;
}

export interface RuntimeAdapterFactoryOptions {
  apiHost?: string;
  apiKey?: string;
}

export type Sandbox0NetworkPolicyInput = NetworkPolicy;
