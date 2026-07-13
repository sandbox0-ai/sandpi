/**
 * Codex is the only MVP implementation. The other identifiers reserve the Environment-level
 * integration boundary; they must not appear as a per-Session switch before their native
 * harness adapters are implemented.
 */
export type HarnessId = "codex" | "claude-code" | "opencode" | "pi";

export type SessionStatus = "running" | "waiting" | "paused" | "completed";

export interface NativeHarnessNotification {
  method: string;
  params: unknown;
}

/**
 * Sandpi's durable transport envelope preserves ordering and replay metadata only. The native
 * notification stays opaque to the shared runtime and is interpreted exclusively by the UI
 * module for `harness`. Do not add normalized message, tool-call or approval fields here.
 */
export interface HarnessEventEnvelope<
  THarness extends HarnessId = HarnessId,
  TNotification extends NativeHarnessNotification = NativeHarnessNotification,
> {
  harness: THarness;
  harnessVersion: string;
  protocolVersion: string;
  sequence: number;
  receivedAt: string;
  notification: TNotification;
}

export interface HarnessAccount {
  harness: HarnessId;
  label: string;
  status: "connected" | "not-connected" | "coming-soon";
  account?: string;
  lastVerified?: string;
}

export interface NetworkPolicy {
  mode: "restricted" | "allow-all" | "block-all";
  allowedDomains: string[];
  logDeniedRequests: boolean;
}

export interface EnvironmentFunction {
  id: string;
  name: string;
  description: string;
  kind: "webhook" | "manual" | "cron";
  status: "active" | "disabled" | "coming-soon";
  lastRun?: string;
}

export interface Environment {
  id: string;
  name: string;
  description: string;
  color: string;
  status: "ready" | "updating";
  revision: number;
  templateId: string;
  rootfsSnapshotId: string;
  workspaceVolumeId: string;
  /**
   * Opaque revision of Environment-scoped harness authentication in the secret plane.
   * Credential material must stay outside rootfs and Workspace Volume snapshots so a Session
   * or Turn fork cannot copy provider credentials or restore a rotated refresh token.
   */
  credentialRevision: number;
  codingAgent: HarnessAccount;
  networkPolicy: NetworkPolicy;
  functions: EnvironmentFunction[];
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
  modifiedAt?: string;
  content?: string;
  children?: WorkspaceFile[];
}

export interface AuditEvent {
  id: string;
  source: "sandbox0" | "supervisor";
  category: "lifecycle" | "network" | "session";
  action: string;
  detail: string;
  outcome: "allowed" | "blocked" | "success";
  timestamp: string;
}

export interface MetricPoint {
  at: string;
  value: number;
}

export interface SessionMetrics {
  cpuPercent: MetricPoint[];
  memoryMiB: MetricPoint[];
  currentCpuPercent: number;
  currentMemoryMiB: number;
  memoryLimitMiB: number;
}

export interface SessionOrigin {
  kind: "environment" | "session" | "turn";
  label: string;
  sourceSessionId?: string;
  /** Harness-native item at the Turn branch boundary, when the harness exposes one. */
  sourceNativeItemId?: string;
}

/**
 * Persistence boundary for the future backend:
 * - Session fork branches Sandbox rootfs plus the current Workspace Volume.
 * - Each completed Turn owns a Workspace Volume snapshot; Turn fork/edit/rollback never
 *   branch or restore the Session rootfs.
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
  /**
   * Native conversation state. Shared Sandpi code may store, clone and transport it, but must
   * never inspect it or convert it into a universal message/tool schema.
   */
  harnessState: THarnessState;
  createdAt: string;
  updatedAt: string;
  hardExpiresAt: string;
  sandboxId: string;
  supervisorSessionId: string;
  workspaceRoot: string;
  workspaceVolumeId: string;
  environmentRevision: number;
  origin?: SessionOrigin;
  files: WorkspaceFile[];
  auditEvents: AuditEvent[];
  metrics: SessionMetrics;
}

export interface SandpiBootstrap {
  environments: Environment[];
  sessions: CodingSession[];
  preferences: SandpiPreferences;
  selectedEnvironmentId: string;
  selectedSessionId: string;
}
