import assert from "node:assert/strict";
import test from "node:test";

import {
  accountMonthPeriod,
  fixedWeekPeriod,
  isPaidPlanDowngrade,
  MIB_MILLISECONDS_PER_GIB_HOUR,
  PLAN_DEFINITIONS,
  subscriptionHasPaidEntitlement,
} from "./plans";

test("defines exact runtime quota conversions", () => {
  assert.equal(MIB_MILLISECONDS_PER_GIB_HOUR, 3_686_400_000);
  assert.equal(
    PLAN_DEFINITIONS.plus.runtimeQuotaMiBMilliseconds,
    460_800_000_000,
  );
  assert.equal(
    PLAN_DEFINITIONS.pro.runtimeQuotaMiBMilliseconds,
    921_600_000_000,
  );
  assert.equal(
    PLAN_DEFINITIONS.ultra.runtimeQuotaMiBMilliseconds,
    2_304_000_000_000,
  );
});

test("defines annual paid plan prices and Environment limits", () => {
  const paidPlans = [
    PLAN_DEFINITIONS.plus,
    PLAN_DEFINITIONS.pro,
    PLAN_DEFINITIONS.ultra,
  ];
  assert.deepEqual(
    paidPlans.map((plan) => [
      plan.annualPriceUsd,
      plan.environmentLimit,
    ]),
    [
      [99, 3],
      [199, 10],
      [499, 25],
    ],
  );
});

test("orders upgrades and downgrades across every paid plan", () => {
  assert.equal(isPaidPlanDowngrade("ultra", "pro"), true);
  assert.equal(isPaidPlanDowngrade("ultra", "plus"), true);
  assert.equal(isPaidPlanDowngrade("pro", "plus"), true);
  assert.equal(isPaidPlanDowngrade("plus", "pro"), false);
  assert.equal(isPaidPlanDowngrade("plus", "ultra"), false);
  assert.equal(isPaidPlanDowngrade("pro", "ultra"), false);
});

test("anchors free periods to the account anniversary with month-end clamping", () => {
  const period = accountMonthPeriod(
    new Date("2026-01-31T08:30:00.000Z"),
    new Date("2026-02-28T09:00:00.000Z"),
  );
  assert.equal(period.startsAt.toISOString(), "2026-02-28T08:30:00.000Z");
  assert.equal(period.endsAt.toISOString(), "2026-03-31T08:30:00.000Z");
});

test("uses fixed seven-day paid quota periods", () => {
  const period = fixedWeekPeriod(
    new Date("2026-07-01T00:00:00.000Z"),
    new Date("2026-07-16T12:00:00.000Z"),
  );
  assert.equal(period.startsAt.toISOString(), "2026-07-15T00:00:00.000Z");
  assert.equal(period.endsAt.toISOString(), "2026-07-22T00:00:00.000Z");
});

test("keeps paid entitlement only inside the past-due grace window", () => {
  const now = new Date("2026-07-26T00:00:00.000Z");
  assert.equal(
    subscriptionHasPaidEntitlement({
      status: "past_due",
      graceEndsAt: new Date("2026-07-27T00:00:00.000Z"),
      now,
    }),
    true,
  );
  assert.equal(
    subscriptionHasPaidEntitlement({
      status: "past_due",
      graceEndsAt: new Date("2026-07-25T00:00:00.000Z"),
      now,
    }),
    false,
  );
});
