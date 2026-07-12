export type HarnessId = "codex" | "claude-code" | "opencode" | "pi";

export type SessionStatus = "running" | "waiting" | "paused" | "completed";

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

export interface ToolActivity {
  id: string;
  label: string;
  detail: string;
  status: "completed" | "running" | "failed";
  duration?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  activities?: ToolActivity[];
  diff?: {
    file: string;
    additions: number;
    deletions: number;
    lines: string[];
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

export interface CodingSession {
  id: string;
  environmentId: string;
  title: string;
  status: SessionStatus;
  pinned: boolean;
  archived: boolean;
  harness: HarnessId;
  harnessLabel: string;
  modelLabel: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  hardExpiresAt: string;
  sandboxId: string;
  supervisorSessionId: string;
  workspaceVolumeId: string;
  environmentRevision: number;
  messages: ChatMessage[];
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
