/**
 * Codex-native Environment extension models. Other harnesses must expose their
 * own settings contracts instead of translating into these Codex concepts.
 */

export type CodexSkillScope = "user" | "repo" | "system" | "admin";

export interface CodexSkillDependency {
  type: string;
  value: string;
  description?: string;
  transport?: string;
  command?: string;
  url?: string;
}

export interface CodexEnvironmentSkill {
  name: string;
  displayName?: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: CodexSkillScope;
  enabled: boolean;
  dependencies: CodexSkillDependency[];
}

export interface CodexSkillError {
  path: string;
  message: string;
}

export interface CodexSkillsInventory {
  cwd: string;
  skills: CodexEnvironmentSkill[];
  errors: CodexSkillError[];
}

export type CodexMcpTransport = "stdio" | "streamable-http";
export type CodexMcpApprovalMode = "auto" | "prompt" | "writes" | "approve";
export type CodexMcpAuthStatus =
  | "unsupported"
  | "notLoggedIn"
  | "bearerToken"
  | "oAuth"
  | "unknown";
export type CodexMcpRuntimeStatus =
  | "connected"
  | "authentication-required"
  | "unavailable"
  | "disabled";

export interface CodexMcpServer {
  name: string;
  transport: CodexMcpTransport;
  command?: string;
  args: string[];
  url?: string;
  enabled: boolean;
  required: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  defaultToolsApprovalMode?: CodexMcpApprovalMode;
  enabledTools: string[];
  disabledTools: string[];
  /** True when the definition is owned by the Environment's Codex user config. */
  managed: boolean;
  authStatus: CodexMcpAuthStatus;
  runtimeStatus: CodexMcpRuntimeStatus;
  serverTitle?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
}

export interface CodexMcpInventory {
  servers: CodexMcpServer[];
}

export interface CodexMcpServerInput {
  transport: CodexMcpTransport;
  command?: string;
  args: string[];
  url?: string;
  enabled: boolean;
  required: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  defaultToolsApprovalMode?: CodexMcpApprovalMode;
  enabledTools: string[];
  disabledTools: string[];
}
