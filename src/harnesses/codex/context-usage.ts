import type {
  CodexThreadTokenUsage,
  CodexTokenUsageBreakdown,
} from "@/harnesses/codex/types";

const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

type JsonObject = Record<string, unknown>;

function objectRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function tokenCount(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function nullableTokenCount(value: unknown) {
  if (value === null) return null;
  return tokenCount(value) ?? undefined;
}

function nativeBreakdown(value: unknown): CodexTokenUsageBreakdown | null {
  const record = objectRecord(value);
  if (!record) return null;
  const inputTokens = tokenCount(record.inputTokens);
  const cachedInputTokens = tokenCount(record.cachedInputTokens);
  const cacheWriteInputTokens =
    record.cacheWriteInputTokens === undefined
      ? 0
      : tokenCount(record.cacheWriteInputTokens);
  const outputTokens = tokenCount(record.outputTokens);
  const reasoningOutputTokens = tokenCount(record.reasoningOutputTokens);
  const totalTokens = tokenCount(record.totalTokens);
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function rolloutBreakdown(value: unknown): CodexTokenUsageBreakdown | null {
  const record = objectRecord(value);
  if (!record) return null;
  return nativeBreakdown({
    inputTokens: record.input_tokens,
    cachedInputTokens: record.cached_input_tokens,
    cacheWriteInputTokens: record.cache_write_input_tokens ?? 0,
    outputTokens: record.output_tokens,
    reasoningOutputTokens: record.reasoning_output_tokens,
    totalTokens: record.total_tokens,
  });
}

export function normalizeCodexThreadTokenUsage(
  value: unknown,
): CodexThreadTokenUsage | null {
  const record = objectRecord(value);
  if (!record) return null;
  const total = nativeBreakdown(record.total);
  const last = nativeBreakdown(record.last);
  const modelContextWindow = nullableTokenCount(record.modelContextWindow);
  if (!total || !last || modelContextWindow === undefined) return null;
  return { total, last, modelContextWindow };
}

/** Convert the persisted `token_count.info` shape into app-server v2 naming. */
export function codexThreadTokenUsageFromRolloutInfo(
  value: unknown,
): CodexThreadTokenUsage | null {
  const info = objectRecord(value);
  if (!info) return null;
  const total = rolloutBreakdown(info.total_token_usage);
  const last = rolloutBreakdown(info.last_token_usage);
  const modelContextWindow = nullableTokenCount(info.model_context_window);
  if (!total || !last || modelContextWindow === undefined) return null;
  return { total, last, modelContextWindow };
}

/**
 * Match Codex's user-controllable context calculation. The fixed baseline
 * covers prompts and tools that the user cannot reclaim.
 */
export function codexContextUsedPercent(
  usage: CodexThreadTokenUsage | null | undefined,
): number | null {
  if (!usage || usage.modelContextWindow === null) return null;
  if (usage.modelContextWindow <= CODEX_CONTEXT_BASELINE_TOKENS) return 100;

  const effectiveWindow =
    usage.modelContextWindow - CODEX_CONTEXT_BASELINE_TOKENS;
  const used = Math.max(
    usage.last.totalTokens - CODEX_CONTEXT_BASELINE_TOKENS,
    0,
  );
  const remaining = Math.max(effectiveWindow - used, 0);
  const remainingPercent = Math.round(
    Math.min(100, Math.max(0, (remaining / effectiveWindow) * 100)),
  );
  return 100 - remainingPercent;
}
