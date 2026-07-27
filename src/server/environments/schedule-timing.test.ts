import assert from "node:assert/strict";
import test from "node:test";

import {
  dueEnvironmentScheduleOccurrence,
  firstEnvironmentScheduleRunAt,
  normalizeEnvironmentScheduleTiming,
} from "./schedule-timing";

test("normalizes deterministic five-field cron expressions", () => {
  const timing = normalizeEnvironmentScheduleTiming(
    {
      kind: "cron",
      expression: "  15   9  * * 1-5 ",
      timeZone: "  Asia/Shanghai ",
    },
    new Date("2026-07-27T00:00:00.000Z"),
  );
  assert.deepEqual(timing, {
    kind: "cron",
    expression: "15 9 * * 1-5",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(
    firstEnvironmentScheduleRunAt(
      timing,
      new Date("2026-07-27T00:00:00.000Z"),
    ).toISOString(),
    "2026-07-27T01:15:00.000Z",
  );
});

test("rejects past one-time schedules and ambiguous cron forms", () => {
  const now = new Date("2026-07-27T00:00:00.000Z");
  assert.throws(
    () =>
      normalizeEnvironmentScheduleTiming(
        { kind: "once", runAt: new Date(now) },
        now,
      ),
    /must run in the future/,
  );
  assert.throws(
    () =>
      normalizeEnvironmentScheduleTiming(
        {
          kind: "cron",
          expression: "0 0 9 * * *",
          timeZone: "UTC",
        },
        now,
      ),
    /five-field cron/,
  );
  assert.throws(
    () =>
      normalizeEnvironmentScheduleTiming(
        {
          kind: "cron",
          expression: "H 9 * * *",
          timeZone: "UTC",
        },
        now,
      ),
    /five-field cron/,
  );
  assert.throws(
    () =>
      normalizeEnvironmentScheduleTiming(
        {
          kind: "cron",
          expression: "0 9 * * *",
          timeZone: "Mars/Olympus",
        },
        now,
      ),
    /time zone is invalid/,
  );
});

test("coalesces downtime to the latest missed cron occurrence", () => {
  const timing = {
    kind: "cron" as const,
    expression: "*/5 * * * *",
    timeZone: "UTC",
  };
  const occurrence = dueEnvironmentScheduleOccurrence(
    timing,
    new Date("2026-07-27T10:05:00.000Z"),
    new Date("2026-07-27T10:23:12.000Z"),
  );
  assert.equal(
    occurrence.scheduledFor.toISOString(),
    "2026-07-27T10:20:00.000Z",
  );
  assert.equal(
    occurrence.nextRunAt?.toISOString(),
    "2026-07-27T10:25:00.000Z",
  );
});

test("keeps wall-clock cron time across daylight-saving changes", () => {
  const timing = {
    kind: "cron" as const,
    expression: "0 9 * * *",
    timeZone: "America/New_York",
  };
  assert.equal(
    firstEnvironmentScheduleRunAt(
      timing,
      new Date("2026-03-07T15:00:00.000Z"),
    ).toISOString(),
    "2026-03-08T13:00:00.000Z",
  );
  assert.equal(
    firstEnvironmentScheduleRunAt(
      timing,
      new Date("2026-11-01T15:00:00.000Z"),
    ).toISOString(),
    "2026-11-02T14:00:00.000Z",
  );
});
