import assert from "node:assert/strict";
import test from "node:test";

import {
  codexTokenUsagePoints,
  parseCodexTokenUsageView,
} from "./token-usage";

const usage = {
  summary: {
    lifetimeTokens: 100,
    peakDailyTokens: 20,
    longestRunningTurnSec: 5,
    currentStreakDays: 2,
    longestStreakDays: 3,
  },
  dailyUsageBuckets: [
    { startDate: "2026-07-19", tokens: 10 },
    { startDate: "2026-07-20", tokens: 20 },
    { startDate: "2026-07-20", tokens: 5 },
    { startDate: "2026-02-31", tokens: 999 },
    { startDate: "invalid", tokens: 999 },
  ],
};

test("parses Codex usage view aliases without silently accepting invalid input", () => {
  assert.equal(parseCodexTokenUsageView(""), "daily");
  assert.equal(parseCodexTokenUsageView("week"), "weekly");
  assert.equal(parseCodexTokenUsageView("cumulative"), "cumulative");
  assert.equal(parseCodexTokenUsageView("month"), undefined);
});

test("deduplicates daily buckets and groups weekly activity from Sunday", () => {
  assert.deepEqual(codexTokenUsagePoints(usage, "daily"), [
    { label: "2026-07-19", value: 10 },
    { label: "2026-07-20", value: 25 },
  ]);
  assert.deepEqual(codexTokenUsagePoints(usage, "weekly"), [
    { label: "2026-07-19", value: 35 },
  ]);
});

test("accumulates activity within the displayed weekly window", () => {
  assert.deepEqual(codexTokenUsagePoints(usage, "cumulative"), [
    { label: "2026-07-19", value: 35 },
  ]);
});
