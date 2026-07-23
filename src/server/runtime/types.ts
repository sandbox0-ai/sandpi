import type {
  Environment,
  NetworkPolicy,
  RuntimeMetrics,
  WorkspaceDirectoryListing,
  WorkspaceFileSearchResult,
  WorkspaceGitState,
  WorkspaceIdeFile,
} from "@/lib/types";
import type { UnixTimestamp } from "@/lib/time";
import type {
  CodexDecoderState,
  SupervisorOutputEvent,
} from "@/server/harnesses/codex/jsonl";
import type { Sandbox } from "sandbox0";

export const CODEX_ENVIRONMENT_CREDENTIAL_PATH =
  "/dev/shm/sandpi-codex-auth.json";
export const CODEX_MCP_OAUTH_CALLBACK_PORT = 43_419;
/** Codex appends a server-specific identifier below this callback base path. */
export const CODEX_MCP_OAUTH_CALLBACK_BASE_PATH = "/callback";

export type Sandbox0NetworkPolicy = Parameters<
  Sandbox["updateNetworkPolicy"]
>[0];
export type Sandbox0AppService = Parameters<
  Sandbox["updateServices"]
>[0][number];
export type Sandbox0AppServiceView = Awaited<
  ReturnType<Sandbox["getServices"]>
>["services"][number];

export interface RuntimeMcpOAuthCallbackService {
  port: number;
  publicUrl: string;
}

export interface ProvisionedEnvironment {
  sandboxId: string;
  workspaceVolumeId: string;
  rootfsSnapshotId?: string;
}

export interface EnvironmentRuntimeRecord {
  /** Environment id; all product Sessions in it share these coordinates. */
  id: string;
  sandboxId: string;
  workspaceVolumeId: string;
  supervisorSessionId?: string;
  terminalSessionId?: string;
  attemptId?: string;
  runtimeGeneration: number;
  decoder: CodexDecoderState;
}

export interface RuntimeWorkspaceBackupSnapshot {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface RuntimeProvisionEnvironmentInput {
  environment: Environment;
  /** Existing Volume is reused when reconciliation resumes after a crash. */
  onResourcesAllocated?: (
    resources: Partial<ProvisionedEnvironment>,
  ) => Promise<void>;
}

export interface RecoveredCodexEnvironmentRuntime {
  supervisorSessionId: string;
  attemptId: string;
  runtimeGeneration: number;
  sandboxRestarted: boolean;
}

export interface RuntimeMetricWindow {
  startedAt: Date;
  endedAt: Date;
}

export interface CodexAuthRuntime {
  sandboxId: string;
  supervisorSessionId: string;
  attemptId: string;
  runtimeGeneration: number;
}

export interface RuntimeAdapter {
  readonly mode: "sandbox0" | "unconfigured";
  provisionEnvironment(
    input: RuntimeProvisionEnvironmentInput,
  ): Promise<ProvisionedEnvironment>;
  deleteEnvironmentResources(
    resources: Partial<ProvisionedEnvironment>,
  ): Promise<void>;
  updateEnvironmentNetworkPolicy(
    runtime: EnvironmentRuntimeRecord,
    policy: NetworkPolicy,
  ): Promise<void>;
  updateEnvironmentMemory(
    runtime: EnvironmentRuntimeRecord,
    memoryMiB: number,
  ): Promise<void>;
  ensureEnvironmentMcpOAuthCallbackService(
    runtime: EnvironmentRuntimeRecord,
    input: { port: number },
  ): Promise<RuntimeMcpOAuthCallbackService>;
  createEnvironmentWorkspaceBackup(
    runtime: EnvironmentRuntimeRecord,
    input: { name: string; description: string },
  ): Promise<RuntimeWorkspaceBackupSnapshot>;
  deleteEnvironmentWorkspaceBackup(
    runtime: EnvironmentRuntimeRecord,
    snapshotId: string,
  ): Promise<void>;
  restoreEnvironmentWorkspaceBackup(
    runtime: EnvironmentRuntimeRecord,
    snapshotId: string,
  ): Promise<void>;
  applyEnvironmentLifecyclePolicy(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<void>;
  pauseEnvironment(
    runtime: EnvironmentRuntimeRecord,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Restores the harness-neutral Environment runtime surface after a
   * Workspace or Terminal operation proves that native access is unavailable.
   * Callers must not use this as a warm-path health probe.
   */
  ensureEnvironmentRuntimeAccess(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<void>;
  ensureCodexEnvironmentRuntime(
    runtime: EnvironmentRuntimeRecord,
    authJson: string,
  ): Promise<RecoveredCodexEnvironmentRuntime>;
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
  ): Promise<{
    events: unknown[];
    cursor: { earliest: number; latest: number };
  }>;
  readCodexAuthJson(runtime: CodexAuthRuntime): Promise<string>;
  installCodexEnvironmentCredential(
    runtime: EnvironmentRuntimeRecord,
    authJson: string,
  ): Promise<void>;
  readCodexEnvironmentCredential(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<string>;
  writeCodexMessage(
    runtime: EnvironmentRuntimeRecord,
    message: unknown,
    stableInputId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  watchCodexEvents(
    runtime: EnvironmentRuntimeRecord,
    after?: number,
    signal?: AbortSignal,
  ): Promise<RuntimeCodexEventStreamHandle>;
  /**
   * Read one native Codex rollout after validating that it belongs to the
   * requested Thread. This internal path is never exposed through Workspace
   * file APIs.
   */
  readCodexRollout(
    runtime: EnvironmentRuntimeRecord,
    path: string,
    nativeSessionId: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  listFiles(
    runtime: EnvironmentRuntimeRecord,
    path: string,
  ): Promise<WorkspaceDirectoryListing>;
  /** Searches the shared Workspace independently of any coding-agent harness. */
  searchFiles(
    runtime: EnvironmentRuntimeRecord,
    query: string,
  ): Promise<WorkspaceFileSearchResult[]>;
  writeCodexComposerUpload(
    runtime: EnvironmentRuntimeRecord,
    path: string,
    content: Uint8Array,
  ): Promise<void>;
  readFile(
    runtime: EnvironmentRuntimeRecord,
    path: string,
  ): Promise<Uint8Array>;
  getWorkspaceGitState(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<WorkspaceGitState>;
  readWorkspaceIdeFile(
    runtime: EnvironmentRuntimeRecord,
    path: string,
  ): Promise<WorkspaceIdeFile>;
  writeWorkspaceIdeFile(
    runtime: EnvironmentRuntimeRecord,
    path: string,
    content: Uint8Array,
    baseRevision: string,
  ): Promise<WorkspaceIdeFile>;
  watchWorkspaceFiles(
    runtime: EnvironmentRuntimeRecord,
  ): Promise<RuntimeWorkspaceWatchHandle>;
  getMetrics(
    runtime: EnvironmentRuntimeRecord,
    window: RuntimeMetricWindow,
  ): Promise<RuntimeMetrics>;
  openTerminal(
    runtime: EnvironmentRuntimeRecord,
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

export interface RuntimeCodexEventStreamHandle {
  /** Retained events after the requested cursor followed by live events. */
  events: AsyncIterable<SupervisorOutputEvent>;
  close(): void | Promise<void>;
}

export interface RuntimeAdapterFactoryOptions {
  apiHost?: string;
  apiKey?: string;
}

export type Sandbox0NetworkPolicyInput = NetworkPolicy;
