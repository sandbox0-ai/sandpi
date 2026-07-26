import assert from "node:assert/strict";
import test from "node:test";

import {
  accountMonthPeriod,
  fixedWeekPeriod,
  MIB_MILLISECONDS_PER_GIB_HOUR,
  PLAN_DEFINITIONS,
  subscriptionHasPaidEntitlement,
} from "./plans";

test("defines exact runtime quota conversions", () => {
  assert.equal(MIB_MILLISECONDS_PER_GIB_HOUR, 3_686_400_000);
  assert.equal(
    PLAN_DEFINITIONS.plus.runtimeQuotaMiBMilliseconds,
    619_315_200_000,
  );
  assert.equal(
    PLAN_DEFINITIONS.pro.runtimeQuotaMiBMilliseconds,
    1_843_200_000_000,
  );
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
