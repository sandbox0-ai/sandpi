import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSimpleScheduleRecurrence,
  defaultSimpleScheduleRecurrence,
  describeScheduleCronExpression,
  describeSimpleScheduleRecurrence,
  nextScheduleCronOccurrences,
  parseSimpleScheduleRecurrence,
  type SimpleScheduleRecurrence,
} from "./environment-schedule-recurrence";

const base = defaultSimpleScheduleRecurrence();

test("compiles common recurrence choices into deterministic cron", () => {
  const cases: Array<[Partial<SimpleScheduleRecurrence>, string]> = [
    [{ frequency: "hourly", minute: 15 }, "15 * * * *"],
    [{ frequency: "daily", time: "09:30" }, "30 9 * * *"],
    [{ frequency: "weekdays", time: "09:30" }, "30 9 * * 1-5"],
    [
      { frequency: "weekly", time: "09:30", weekdays: [5, 1, 3] },
      "30 9 * * 1,3,5",
    ],
    [
      { frequency: "monthly", time: "09:30", monthDay: 15 },
      "30 9 15 * *",
    ],
    [
      { frequency: "monthly", time: "09:30", monthDay: "last" },
      "30 9 L * *",
    ],
  ];

  for (const [overrides, expected] of cases) {
    assert.equal(
      compileSimpleScheduleRecurrence({ ...base, ...overrides }),
      expected,
    );
  }
});

test("round-trips every expression produced by the simple editor", () => {
  const recurrences: SimpleScheduleRecurrence[] = [
    { ...base, frequency: "hourly", minute: 5 },
    { ...base, frequency: "daily", time: "23:45" },
    { ...base, frequency: "weekdays", time: "08:00" },
    {
      ...base,
      frequency: "weekly",
      time: "16:20",
      weekdays: [1, 4, 0],
    },
    { ...base, frequency: "monthly", time: "07:10", monthDay: 31 },
    { ...base, frequency: "monthly", time: "07:10", monthDay: "last" },
  ];

  for (const recurrence of recurrences) {
    const expression = compileSimpleScheduleRecurrence(recurrence);
    const parsed = parseSimpleScheduleRecurrence(expression);
    assert.ok(parsed);
    assert.equal(compileSimpleScheduleRecurrence(parsed), expression);
  }
});

test("keeps expressions outside the simple editor in Advanced mode", () => {
  assert.equal(parseSimpleScheduleRecurrence("*/5 * * * *"), undefined);
  assert.equal(parseSimpleScheduleRecurrence("0 9 * */2 *"), undefined);
  assert.equal(parseSimpleScheduleRecurrence("0 9 * * MON-FRI"), undefined);
  assert.equal(parseSimpleScheduleRecurrence("0 9 1 * 1"), undefined);
});

test("describes simple expressions without exposing cron syntax", () => {
  assert.equal(
    describeScheduleCronExpression("0 9 * * 1-5"),
    "Every weekday at 09:00",
  );
  assert.equal(
    describeSimpleScheduleRecurrence({
      ...base,
      frequency: "weekly",
      time: "14:15",
      weekdays: [1, 3, 5],
    }),
    "Every Mon, Wed, and Fri at 14:15",
  );
  assert.equal(
    describeScheduleCronExpression("*/5 * * * *"),
    "Cron: */5 * * * *",
  );
});

test("previews wall-clock recurrences across daylight-saving changes", () => {
  const occurrences = nextScheduleCronOccurrences(
    "0 9 * * *",
    "America/New_York",
    new Date("2026-03-07T15:00:00.000Z"),
    2,
  );
  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.toISOString()),
    ["2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"],
  );
});

test("previews the last calendar day of each month", () => {
  const occurrences = nextScheduleCronOccurrences(
    "0 9 L * *",
    "UTC",
    new Date("2026-01-30T00:00:00.000Z"),
    3,
  );
  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.toISOString()),
    [
      "2026-01-31T09:00:00.000Z",
      "2026-02-28T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
    ],
  );
});

test("skips months that do not contain a selected calendar day", () => {
  const occurrences = nextScheduleCronOccurrences(
    "0 9 31 * *",
    "UTC",
    new Date("2026-02-01T00:00:00.000Z"),
    3,
  );
  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.toISOString()),
    [
      "2026-03-31T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
      "2026-07-31T09:00:00.000Z",
    ],
  );
});

test("rejects incomplete simple rules and invalid Advanced values", () => {
  assert.throws(
    () =>
      compileSimpleScheduleRecurrence({
        ...base,
        frequency: "weekly",
        weekdays: [],
      }),
    /at least one weekday/,
  );
  assert.throws(
    () => nextScheduleCronOccurrences("0 9 * * *", "Mars/Olympus"),
    /valid IANA time zone/,
  );
  assert.throws(
    () => nextScheduleCronOccurrences("0 0 9 * * *", "UTC"),
    /five-field cron/,
  );
});
