import type { UnixTimestamp } from "./time";

/**
 * Codex is the only MVP implementation. The other identifiers reserve the Environment-level
 * integration boundary; they must not appear as a per-Session switch before their native
 * harness adapters are implemented.
 */
export type HarnessId = "codex" | "claude-code" | "opencode" | "pi";

export type SessionStatus =
  "running" | "waiting" | "paused" | "completed" | "failed";

export interface SandpiUser {
  id: string;
  name: string;
  email: string;
  avatarInitials: string;
}

/**
 * Public deployment metadata only. Auth provider credentials and Sandbox0 API Host/API Key
 * are server-side deployment configuration and must never be serialized into bootstrap data.
 */
export interface SandpiDeploymentSummary {
  mode: "cloud" | "self-hosted";
  identity: {
    protocol: "builtin" | "oidc";
    provider: "builtin-admin" | "sandpi-auth0" | "deployment-oidc";
    label: string;
    managedBy: "sandpi" | "deployment";
  };
  runtime: {
    provider: "sandbox0";
    status: "configured" | "mock" | "unconfigured";
    configurationScope: "deployment";
  };
}

export interface NativeHarnessNotification {
  method: string;
  params: unknown;
}

/**
 * Bounded live-transport envelope. Sandpi never persists it as conversation
 * history; a reconnect starts from the harness-native Session snapshot.
 */
export interface HarnessEventEnvelope<
  THarness extends HarnessId = HarnessId,
  TNotification extends NativeHarnessNotification = NativeHarnessNotification,
> {
  harness: THarness;
  harnessVersion: string;
  protocolVersion: string;
  sequence: number;
  receivedAt: UnixTimestamp;
  notification: TNotification;
}

export interface HarnessAccount {
  harness: HarnessId;
  label: string;
  status: "connected" | "not-connected" | "coming-soon";
  account?: string;
  lastVerified?: UnixTimestamp;
}

export interface NetworkPolicy {
  mode: "allow-all" | "block-all";
  domainExceptions: string[];
}

export type EnvironmentSandboxState =
  "pending" | "provisioning" | "running" | "paused" | "terminated" | "failed";

export interface EnvironmentWorkspaceBackupPolicy {
  /** Zero disables scheduled backups; manual backups remain available. */
  intervalSeconds: number;
  /** Maximum number of Sandpi-owned Workspace backups retained. */
  retentionCount: number;
  nextBackupAt?: UnixTimestamp;
  lastBackupAt?: UnixTimestamp;
  lastError?: string;
}

export interface EnvironmentWorkspaceBackup {
  id: string;
  environmentId: string;
  name: string;
  sizeBytes: number;
  kind: "automatic" | "manual";
  createdAt: UnixTimestamp;
}

export type EnvironmentScheduleTiming =
  | {
      kind: "once";
      runAt: UnixTimestamp;
    }
  | {
      kind: "cron";
      expression: string;
      timeZone: string;
    };

export type EnvironmentScheduleTarget =
  | { kind: "newSession" }
  | { kind: "session"; sessionId: string };

export type EnvironmentScheduleRunStatus =
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * A durable user-authored Automation definition. Its prompt is not a copy of
 * native conversation history; each accepted run submits it as one native Turn.
 */
export interface EnvironmentSchedule {
  id: string;
  environmentId: string;
  name: string;
  prompt: string;
  timing: EnvironmentScheduleTiming;
  target: EnvironmentScheduleTarget;
  overlapPolicy: "skip";
  enabled: boolean;
  title?: string;
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
  nextRunAt?: UnixTimestamp;
  lastScheduledFor?: UnixTimestamp;
  lastRunStatus?: EnvironmentScheduleRunStatus;
  lastError?: string;
  createdAt: UnixTimestamp;
  updatedAt: UnixTimestamp;
}

export interface EnvironmentScheduleRun {
  id: string;
  scheduleId: string;
  scheduledFor: UnixTimestamp;
  status: EnvironmentScheduleRunStatus;
  sessionId?: string;
  nativeTurnId?: string;
  error?: string;
  startedAt?: UnixTimestamp;
  finishedAt?: UnixTimestamp;
  createdAt: UnixTimestamp;
  updatedAt: UnixTimestamp;
}

export interface Environment {
  id: string;
  /** Immutable user ownership; never inferred from the Sandbox0 API key. */
  ownerId: string;
  /** Environment-wide idle timeout in seconds; zero disables automatic pause. */
  idlePauseTimeoutSeconds: number;
  /** Desired memory limit for the one shared Environment Sandbox, in MiB. */
  sandboxMemoryMiB: number;
  /** Native SandboxVolume snapshot policy and its durable scheduler state. */
  workspaceBackup: EnvironmentWorkspaceBackupPolicy;
  name: string;
  description: string;
  color: string;
  /**
   * `updating` means the Environment's one shared Sandbox/Workspace is being
   * provisioned. `error` is recoverable and is kept distinct so clients do not
   * display an endless ready spinner after Sandbox0 rejects provisioning.
   */
  status: "ready" | "updating" | "error";
  revision: number;
  templateId: string;
  rootfsSnapshotId: string;
  workspaceVolumeId: string;
  /** Shared execution coordinates. Sessions never own separate Sandboxes. */
  sandboxId: string;
  /**
   * Read-only projection of Sandbox0 lifecycle state. It is intentionally
   * separate from Session status, which describes native coding-agent Turns.
   */
  sandboxState: EnvironmentSandboxState;
  supervisorSessionId: string;
  workspaceRoot: "/workspace";
  provisioningError?: string;
  /** Opaque revision of Environment-scoped harness authentication. */
  credentialRevision: number;
  codingAgent: HarnessAccount;
  networkPolicy: NetworkPolicy;
}

export interface SandpiPreferences {
  general: {
    language: "en" | "zh-CN";
    timeZone: string;
    sendShortcut: "enter" | "mod-enter";
  };
  appearance: {
    theme: "system" | "light" | "dark";
    density: "comfortable" | "compact";
  };
}

export interface WorkspaceFile {
  id: string;
  name: string;
  path: string;
  kind: "file" | "folder";
  language?: string;
  size?: string;
  modifiedAt?: UnixTimestamp;
  content?: string;
  /** Present only after this folder's direct children have been loaded. */
  children?: WorkspaceFile[];
}

/** One harness-neutral match from the Environment Workspace. */
export interface WorkspaceFileSearchResult {
  name: string;
  path: string;
  kind: "file" | "folder";
}

/**
 * One shallow directory page from the Environment Workspace. Folder entries
 * intentionally omit `children`; every client loads them only when expanded.
 */
export interface WorkspaceDirectoryListing {
  path: string;
  entries: WorkspaceFile[];
  refreshedAt: UnixTimestamp;
}

export type WorkspaceGitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface WorkspaceGitFileChange {
  path: string;
  relativePath: string;
  originalPath?: string;
  kind: WorkspaceGitChangeKind;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
}

export interface WorkspaceGitRepository {
  root: string;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: WorkspaceGitFileChange[];
}

export interface WorkspaceGitState {
  /**
   * Git working trees discovered below /workspace. Sandpi never creates or
   * chooses a repository for the user; an empty array is a valid Workspace.
   */
  repositories: WorkspaceGitRepository[];
}

/**
 * Cross-client Web IDE contract. Web, iOS, Android and HarmonyOS clients consume
 * this snapshot and treat WorkspaceIdeEvent as an invalidation signal; clients
 * must not connect to a Sandbox0 file endpoint or infer Git state themselves.
 * `/workspace/.sandpi` is visible and readable but remains Sandpi-managed and
 * read-only. Clients apply the shared path policy again as defense in depth.
 */
export interface WorkspaceIdeSnapshot {
  /** Initial shallow tree: `/workspace` and its direct children only. */
  files: WorkspaceFile[];
  git: WorkspaceGitState;
  refreshedAt: UnixTimestamp;
}

export interface WorkspaceLineChange {
  line: number;
  kind: "added" | "modified" | "deleted";
  staged: boolean;
  unstaged: boolean;
  deletedLines?: number;
  placement?: "before" | "after";
}

export interface WorkspaceIdeFilePreview {
  kind: "audio" | "image" | "pdf" | "video";
  /** Server-verified media type; clients must not infer it from the filename. */
  mimeType: string;
}

export interface WorkspaceIdeFile {
  path: string;
  name: string;
  /** Content revision used for optimistic, cross-client Workspace writes. */
  revision: string;
  encoding: "base64";
  content: string;
  kind: "binary" | "text";
  /** Read-only browser preview for a recognized binary document or media file. */
  preview?: WorkspaceIdeFilePreview;
  bom?: "utf8";
  editable: boolean;
  readOnlyReason?: "binary" | "deleted" | "sandpi-managed";
  size?: string;
  modifiedAt?: UnixTimestamp;
  git?: WorkspaceGitFileChange;
  lineChanges: WorkspaceLineChange[];
}

export interface WorkspaceIdeWriteRequest {
  encoding: "base64";
  content: string;
  baseRevision: string;
}

export interface WorkspaceIdeCreateEntryRequest {
  parentPath: string;
  name: string;
  kind: "file" | "folder";
}

export interface WorkspaceIdeRenameEntryRequest {
  path: string;
  name: string;
}

export type WorkspaceIdeEvent =
  | { type: "ready"; at: UnixTimestamp }
  | {
      type: "change";
      event: string;
      path: string;
      at: UnixTimestamp;
    }
  | {
      type: "error";
      error: string;
      code?: "workspace_watch_unavailable";
      at: UnixTimestamp;
    };

export interface MetricPoint {
  at: UnixTimestamp;
  value: number;
}

export interface MetricSegment {
  points: MetricPoint[];
}

/**
 * JSON-safe projection of an sdk-js runtime metric series. Keep `segments` intact: Sandbox0
 * starts a new segment after a runtime restart or collector reset, and clients must never draw
 * a line across that boundary.
 */
export interface RuntimeMetricSeries {
  metric:
    | "sandbox.cpu.utilization"
    | "sandbox.memory.working_set"
    | "sandbox.network.io";
  unit: "ratio" | "bytes" | "bytes_per_second";
  statistic: "average" | "rate";
  /** Effective Sandbox0 aggregation bucket width for this projected series. */
  stepSeconds: number;
  dimensions?: Record<string, string>;
  segments: MetricSegment[];
}

/** Runtime-native metric payload before Sandpi adds lifecycle context. */
export interface RuntimeMetrics {
  cpuUtilization: RuntimeMetricSeries;
  memoryWorkingSet: RuntimeMetricSeries;
  memoryLimitBytes: number;
  /** `sandbox.network.io` queried as a rate and split by its `direction` dimension. */
  networkReceive: RuntimeMetricSeries;
  networkTransmit: RuntimeMetricSeries;
}

/** Best-effort latest Sandbox resource ratios for compact live UI surfaces. */
export interface EnvironmentResourceMetrics {
  cpuUtilization: number | null;
  memoryUtilization: number | null;
}

export interface EnvironmentMetricWindow {
  startedAt: UnixTimestamp;
  endedAt: UnixTimestamp;
}

/** Historical Sandpi-owned idle pause; an absent end means it is still active. */
export interface EnvironmentPauseInterval {
  startedAt: UnixTimestamp;
  endedAt?: UnixTimestamp;
  reason: "idle";
}

export interface EnvironmentMetrics extends RuntimeMetrics {
  window: EnvironmentMetricWindow;
  pauseIntervals: EnvironmentPauseInterval[];
}

export interface SessionOrigin {
  kind: "environment" | "session" | "turn";
  label: string;
  sourceSessionId?: string;
  /** Harness-native item at the Turn branch boundary, when the harness exposes one. */
  sourceNativeItemId?: string;
}

/**
 * Product Session metadata. The coding-agent native Session is the only
 * durable conversation history; `harnessState` contains an opaque reference,
 * never copied messages or tool events.
 */
export interface CodingSession<
  THarness extends HarnessId = HarnessId,
  THarnessState = unknown,
> {
  id: string;
  environmentId: string;
  /** Immutable creator retained for audit and attribution. */
  owner: SandpiUser | null;
  title: string;
  status: SessionStatus;
  /** User-facing unread activity; independent from runtime status. */
  unread: boolean;
  /** Whether the current viewer has personally pinned this Session. */
  pinned: boolean;
  archived: boolean;
  harness: THarness;
  harnessLabel: string;
  /** Opaque native Session reference and non-conversation harness metadata. */
  harnessState: THarnessState;
  createdAt: UnixTimestamp;
  updatedAt: UnixTimestamp;
  environmentRevision: number;
  origin?: SessionOrigin;
}

export interface SandpiBootstrap {
  viewer: SandpiUser;
  deployment: SandpiDeploymentSummary;
  environments: Environment[];
  sessions: CodingSession[];
  preferences: SandpiPreferences;
  selectedEnvironmentId: string;
  selectedSessionId: string;
}
