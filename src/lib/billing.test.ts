import assert from "node:assert/strict";
import test from "node:test";

import {
  formatUsageResetTime,
  runtimeUsageDisplay,
  type SandpiAccountPlan,
  type SandpiUsageSummary,
} from "./billing";

const usage = {
  periodStartsAt: Date.parse("2026-07-25T00:00:00.000Z") / 1_000,
  periodEndsAt: Date.parse("2026-08-01T00:00:00.000Z") / 1_000,
  confirmedMiBMilliseconds: 0,
  projectedMiBMilliseconds: 0,
  usedMiBMilliseconds: 0,
  limitMiBMilliseconds: 0,
  remainingMiBMilliseconds: 0,
  usedGiBHours: 1,
  limitGiBHours: 4,
  percentUsed: 25,
  exhausted: false,
} satisfies SandpiUsageSummary;

test("presents the Free GiB-hour allowance as fixed-memory runtime hours", () => {
  const plan = {
    id: "free",
    name: "Free",
    annualPriceUsd: 0,
    environmentLimit: 1,
    memoryConfigurable: false,
    runtimeQuotaGiBHours: 4,
    quotaPeriod: "account-month",
  } satisfies SandpiAccountPlan;

  assert.deepEqual(runtimeUsageDisplay(plan, usage), {
    used: 0.5,
    limit: 2,
    unit: "hours",
  });
});

test("keeps configurable-memory plans in GiB-hours", () => {
  const plan = {
    id: "plus",
    name: "Plus",
    annualPriceUsd: 99,
    environmentLimit: 3,
    memoryConfigurable: true,
    runtimeQuotaGiBHours: 125,
    quotaPeriod: "fixed-week",
  } satisfies SandpiAccountPlan;

  assert.deepEqual(runtimeUsageDisplay(plan, usage), {
    used: 1,
    limit: 4,
    unit: "gib-hours",
  });
});

test("formats quota reset time in the configured user time zone", () => {
  assert.equal(
    formatUsageResetTime(
      usage.periodEndsAt,
      "en",
      "Asia/Shanghai",
    ),
    "Aug 1, 2026, 8:00 AM",
  );
});
