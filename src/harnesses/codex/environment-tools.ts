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
export type CodexMcpCredentialState =
  | "public"
  | "key-missing"
  | "key-configured"
  | "oauth-required"
  | "oauth-authorized"
  | "reauth-required"
  | "unknown";
export type CodexMcpReadiness =
  | "unknown"
  | "checking"
  | "ready"
  | "failed"
  | "disabled"
  | "stale";
export type CodexMcpRemoteAuthMethod = "none" | "oauth" | "bearer" | "header";
export type CodexMcpCredentialMutation = "keep" | "replace" | "remove";

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
  /** Legacy combined status. New clients should use credentialState + readiness. */
  runtimeStatus: CodexMcpRuntimeStatus;
  credentialState?: CodexMcpCredentialState;
  readiness?: CodexMcpReadiness;
  /** Distinguishes a successfully initialized zero-tool server from no response. */
  hasServerInfo?: boolean;
  startupError?: string;
  presetId?: string;
  authMode?: CodexMcpRemoteAuthMethod;
  scopes?: string[];
  serverTitle?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
}

export interface CodexMcpInventory {
  servers: CodexMcpServer[];
  /** The one persisted non-terminal Environment OAuth flow, when present. */
  activeOAuthFlow?: CodexMcpOAuthFlow;
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
  scopes?: string[];
  enabledTools: string[];
  disabledTools: string[];
}

export interface CodexMcpCredentialInput {
  method: Extract<CodexMcpRemoteAuthMethod, "bearer" | "header">;
  secret: string;
  headerName?: string;
  valueTemplate?: string;
  presetId?: string;
}

export type CodexMcpOAuthFlowStatus =
  | "starting"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export interface CodexMcpOAuthFlow {
  id: string;
  serverName: string;
  status: CodexMcpOAuthFlowStatus;
  authorizationUrl?: string;
  expiresAt?: string;
  error?: string;
}

export interface CodexMcpOAuthLoginInput {
  presetId?: string;
  scopes?: string[];
}
