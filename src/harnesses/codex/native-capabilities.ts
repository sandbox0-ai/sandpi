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

export interface CodexProjectGuidanceSource {
  /** Environment-native path reported by Codex for this Thread snapshot. */
  path: string;
  /** User-visible Workspace path when the source can be opened in Sandpi. */
  workspacePath: string | null;
}

export interface CodexProjectGuidance {
  cwd: string;
  instructionSources: CodexProjectGuidanceSource[];
}

/**
 * Projects thread/start, thread/resume and thread/fork response metadata
 * without rediscovering AGENTS.md or copying its contents into Sandpi state.
 */
export function codexProjectGuidanceFromNativeResult(
  value: unknown,
  fallbackCwd = "/workspace",
): CodexProjectGuidance {
  const result = nativeRecord(value);
  const cwd = nativePath(result?.cwd) ?? fallbackCwd;
  const instructionSources = Array.isArray(result?.instructionSources)
    ? result.instructionSources.flatMap((source) => {
        const sourcePath = nativePath(source);
        return sourcePath
          ? [
              {
                path: sourcePath,
                workspacePath: userVisibleInstructionSource(sourcePath),
              },
            ]
          : [];
      })
    : [];
  return { cwd, instructionSources };
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

function nativeRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nativePath(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0")
    ? value
    : undefined;
}

function userVisibleInstructionSource(sourcePath: string) {
  const prefix = "/workspace/";
  if (!sourcePath.startsWith(prefix)) return null;
  const segments = sourcePath.slice(prefix.length).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments[0] === ".sandpi"
  ) {
    return null;
  }
  return sourcePath;
}
