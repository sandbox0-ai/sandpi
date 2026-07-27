/**
 * Browser projections of native Codex v2 responses. Keep these aligned with
 * the Sandbox0-pinned @openai/codex 0.144.1 protocol; they normalize native
 * values but must not introduce alternate harness behavior.
 */
export type CodexPersonality = "friendly" | "pragmatic" | "none";
export type CodexPersonalitySelection = Exclude<CodexPersonality, "none">;

export interface CodexPersonalitySettings {
  personality: CodexPersonality;
  supported: boolean;
}

export interface CodexTokenUsageSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

export interface CodexTokenUsageDailyBucket {
  startDate: string;
  tokens: number;
}

export interface CodexTokenUsage {
  summary: CodexTokenUsageSummary;
  dailyUsageBuckets: CodexTokenUsageDailyBucket[];
}

export interface CodexBackgroundTerminal {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
}

export interface CodexBackgroundTerminals {
  terminals: CodexBackgroundTerminal[];
}

export interface CodexMemoriesSettings {
  featureEnabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
}

export function codexMemoriesFeatureToggleSettings(
  featureEnabled: boolean,
): CodexMemoriesSettings {
  return {
    featureEnabled,
    useMemories: featureEnabled,
    generateMemories: featureEnabled,
  };
}

export type CodexHookTrustStatus =
  | "trusted"
  | "untrusted"
  | "modified"
  | "managed";

export interface CodexHook {
  key: string;
  eventName: string;
  handlerType: string;
  isManaged: boolean;
  matcher: string | null;
  command: string | null;
  timeoutSec: number;
  statusMessage: string | null;
  sourcePath: string;
  source: string;
  pluginId: string | null;
  displayOrder: number;
  enabled: boolean;
  currentHash: string;
  trustStatus: CodexHookTrustStatus;
}

export interface CodexHookIssue {
  path?: string;
  message: string;
}

export interface CodexHooksInventory {
  cwd: string;
  hooks: CodexHook[];
  warnings: string[];
  errors: CodexHookIssue[];
}
