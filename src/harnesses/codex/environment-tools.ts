/**
 * Codex-native Environment extension models. Other harnesses must expose their
 * own settings contracts instead of translating into these Codex concepts.
 */

import type { UnixTimestamp } from "@/lib/time";

export type CodexAccountPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

export interface CodexAccountSummary {
  type: "chatgpt" | "unknown";
  email?: string;
  planType?: CodexAccountPlanType;
  lastVerified?: UnixTimestamp;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: UnixTimestamp;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexSpendControlSnapshot {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: UnixTimestamp;
}

export interface CodexRateLimitSnapshot {
  id?: string;
  name?: string;
  planType?: CodexAccountPlanType;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  credits?: CodexCreditsSnapshot;
  individualLimit?: CodexSpendControlSnapshot;
  reached: boolean;
}

export interface CodexRateLimitResetCredits {
  availableCount: number;
}

export type CodexRateLimitResetOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed";

export interface CodexRateLimitResetResult {
  outcome: CodexRateLimitResetOutcome;
}

export interface CodexAccountRateLimits {
  limits: CodexRateLimitSnapshot[];
  resetCredits?: CodexRateLimitResetCredits;
  fetchedAt: UnixTimestamp;
}

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
  /** True when the definition is owned by the Environment's Codex user config. */
  managed: boolean;
  runtimeStatus: CodexMcpRuntimeStatus;
  serverTitle?: string;
  toolCount: number;
  resourceCount: number;
}

export interface CodexMcpInventory {
  servers: CodexMcpServer[];
}

export interface CodexMcpOAuthLogin {
  name: string;
  authorizationUrl: string;
  expiresAt: UnixTimestamp;
}
