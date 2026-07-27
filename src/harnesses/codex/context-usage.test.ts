import assert from "node:assert/strict";
import test from "node:test";

import {
  codexContextUsedPercent,
  codexThreadTokenUsageFromRolloutInfo,
  normalizeCodexThreadTokenUsage,
} from "./context-usage";

function breakdown(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  };
}

test("matches Codex's baseline-adjusted context usage percentage", () => {
  assert.equal(
    codexContextUsedPercent({
      total: breakdown(12_000),
      last: breakdown(12_000),
      modelContextWindow: 100_000,
    }),
    0,
  );
  assert.equal(
    codexContextUsedPercent({
      // Cumulative usage can exceed the window after compaction; Codex uses
      // only the latest context usage for this percentage.
      total: breakdown(500_000),
      last: breakdown(56_000),
      modelContextWindow: 100_000,
    }),
    50,
  );
  assert.equal(
    codexContextUsedPercent({
      total: breakdown(120_000),
      last: breakdown(120_000),
      modelContextWindow: 100_000,
    }),
    100,
  );
});

test("normalizes native app-server token usage defensively", () => {
  assert.deepEqual(
    normalizeCodexThreadTokenUsage({
      total: breakdown(35_000),
      last: breakdown(25_000),
      modelContextWindow: 200_000,
    }),
    {
      total: breakdown(35_000),
      last: breakdown(25_000),
      modelContextWindow: 200_000,
    },
  );
  assert.equal(
    normalizeCodexThreadTokenUsage({
      total: breakdown(35_000),
      last: { ...breakdown(25_000), totalTokens: -1 },
      modelContextWindow: 200_000,
    }),
    null,
  );
  assert.deepEqual(
    normalizeCodexThreadTokenUsage({
      total: breakdown(35_000),
      last: breakdown(25_000),
      modelContextWindow: null,
    }),
    {
      total: breakdown(35_000),
      last: breakdown(25_000),
      modelContextWindow: null,
    },
  );
  assert.equal(
    codexContextUsedPercent({
      total: breakdown(35_000),
      last: breakdown(25_000),
      modelContextWindow: null,
    }),
    null,
  );
});

test("restores the native token usage shape from a rollout token_count event", () => {
  const usage = codexThreadTokenUsageFromRolloutInfo({
    total_token_usage: {
      input_tokens: 30_000,
      cached_input_tokens: 4_000,
      cache_write_input_tokens: 500,
      output_tokens: 3_000,
      reasoning_output_tokens: 2_000,
      total_tokens: 35_000,
    },
    last_token_usage: {
      input_tokens: 20_000,
      cached_input_tokens: 4_000,
      output_tokens: 3_000,
      reasoning_output_tokens: 2_000,
      total_tokens: 25_000,
    },
    model_context_window: 200_000,
  });

  assert.deepEqual(usage, {
    total: {
      inputTokens: 30_000,
      cachedInputTokens: 4_000,
      cacheWriteInputTokens: 500,
      outputTokens: 3_000,
      reasoningOutputTokens: 2_000,
      totalTokens: 35_000,
    },
    last: {
      inputTokens: 20_000,
      cachedInputTokens: 4_000,
      cacheWriteInputTokens: 0,
      outputTokens: 3_000,
      reasoningOutputTokens: 2_000,
      totalTokens: 25_000,
    },
    modelContextWindow: 200_000,
  });
});
