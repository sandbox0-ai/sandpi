import type { UnixTimestamp } from "./time";

/**
 * Codex is the only MVP implementation. The other identifiers reserve the Environment-level
 * integration boundary; they must not appear as a per-Session switch before their native
 * harness adapters are implemented.
 */
export type HarnessId = "codex" | "claude-code" | "opencode" | "pi";

export type SessionStatus =
  "running" | "waiting" | "paused" | "completed" | "failed";

export type TeamRole = "owner" | "admin" | "member";

export type SandpiPlanId = "free" | "pro" | "max";

export interface SandpiUser {
  id: string;
  name: string;
  email: string;
  avatarInitials: string;
}

export interface MeteredQuota {
  used: number;
  limit: number;
  unit: "minute" | "session" | "gibibyte";
}

export interface WeeklyExecutionQuota extends MeteredQuota {
  unit: "minute";
  window: "weekly";
  resetsAt: UnixTimestamp;
}

export interface SandpiPlan {
  id: SandpiPlanId;
  name: string;
  execution: {
    weeklyLimitMinutes: number;
    concurrentSessionLimit: number;
  };
  storage: {
    snapshotLimitGiB: number;
  };
}

/**
 * A Plan belongs to one Team Membership, not to the global User or the Team itself. The Team
 * reached through `membership.teamId` sponsors this assignment and receives its cost on the
 * consolidated Team bill. The effective limits are snapshotted here so existing assignments
 * remain stable when the public Plan catalog is revised.
 */
export interface MembershipPlanAssignment {
  id: string;
  planId: SandpiPlanId;
  status: "active" | "pending" | "suspended";
  currentPeriodStartsAt: UnixTimestamp;
  currentPeriodEndsAt: UnixTimestamp;
  quotas: {
    weeklyExecution: WeeklyExecutionQuota;
    concurrentSessions: MeteredQuota & { unit: "session" };
    snapshotStorage: MeteredQuota & { unit: "gibibyte" };
  };
}

export interface TeamMembership {
  id: string;
  teamId: string;
  user: SandpiUser;
  role: TeamRole;
  status: "active" | "invited";
  planAssignment: MembershipPlanAssignment;
  joinedAt: UnixTimestamp;
}

/**
 * Payment and invoice owner for all Membership Plan assignments sponsored by a Team. A billing
 * account deliberately has no Plan: one Team may fund a different Free, Pro or Max assignment
 * for every member.
 */
export interface TeamBillingAccount {
  id: string;
  status: "public-beta" | "active" | "past-due" | "deployment-managed";
  billingCadence: "monthly";
  billingEmail: string;
  currentPeriodStartsAt: UnixTimestamp;
  currentPeriodEndsAt: UnixTimestamp;
}

/**
 * Team is Sandpi's only tenant and billing-attribution boundary. Every User must retain at
 * least one Team Membership; signup creates a one-member Team with a Free Plan assignment.
 */
export interface Team {
  id: string;
  name: string;
  slug: string;
  color: string;
  /** Server-derived list summary, never the membership source of truth. */
  memberCount: number;
  billingAccount: TeamBillingAccount;
  createdAt: UnixTimestamp;
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

export interface Environment {
  id: string;
  /** Immutable Sandpi tenant ownership; never inferred from the Sandbox0 API key. */
  teamId: string;
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
  notifications: {
    sessionCompleted: boolean;
    needsAttention: boolean;
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
 * Server projections must never include `/workspace/.sandpi` or descendants;
 * clients apply the shared path policy again only as defense in depth.
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

export interface WorkspaceIdeFile {
  path: string;
  name: string;
  /** Content revision used for optimistic, cross-client Workspace writes. */
  revision: string;
  encoding: "base64";
  content: string;
  kind: "binary" | "text";
  bom?: "utf8";
  editable: boolean;
  readOnlyReason?: "binary" | "deleted";
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

type SdkSandboxAuditEvent = SandboxObservabilityEvents["events"][number];

/**
 * JSON-safe transport projection of sdk-js' canonical signed Sandbox0 event.
 * sdk-js converts timestamps to Date instances; Sandpi converts only those two
 * fields to Unix seconds at its server/client boundary and preserves every other
 * canonical field, including unknown attributes, without normalization.
 *
 * Supervisor and native harness events never belong in this feed. They have
 * separate replay contracts and must not be presented as signed Sandbox0 audit.
 */
export type EnvironmentAuditEvent = Omit<
  SdkSandboxAuditEvent,
  "occurredAt" | "ingestedAt"
> & {
  occurredAt: UnixTimestamp;
  ingestedAt: UnixTimestamp;
};

/** Pagination metadata is part of the SDK response and must survive API transport. */
export type EnvironmentAuditFeed = Omit<
  SandboxObservabilityEvents,
  "events"
> & {
  events: EnvironmentAuditEvent[];
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
  title: string;
  status: SessionStatus;
  /** User-facing unread activity; independent from runtime status. */
  unread: boolean;
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
  teams: Team[];
  /** Exactly one entry per Team available to the viewer. */
  viewerMemberships: TeamMembership[];
  /** Team-visible Memberships used by Team administration surfaces. */
  teamMemberships: TeamMembership[];
  plans: SandpiPlan[];
  deployment: SandpiDeploymentSummary;
  environments: Environment[];
  sessions: CodingSession[];
  preferences: SandpiPreferences;
  selectedTeamId: string;
  selectedEnvironmentId: string;
  selectedSessionId: string;
}
import type { SandboxObservabilityEvents } from "sandbox0";
