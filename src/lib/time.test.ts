import assert from "node:assert/strict";
import test from "node:test";

import {
  dateFromUnixTimestamp,
  formatUnixTimestamp,
  toUnixTimestamp,
  unixTimestampToIso,
} from "./time";

test("round-trips Unix seconds without losing millisecond precision", () => {
  const date = new Date("2026-07-14T08:09:10.123Z");
  const timestamp = toUnixTimestamp(date);

  assert.equal(timestamp, 1_784_016_550.123);
  assert.equal(dateFromUnixTimestamp(timestamp).getTime(), date.getTime());
  assert.equal(unixTimestampToIso(timestamp), date.toISOString());
});

test("uses the browser time zone for auto and an explicit global zone otherwise", () => {
  const timestamp = toUnixTimestamp(new Date("2026-07-14T00:00:00Z"));
  const options = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  } as const;
  const date = dateFromUnixTimestamp(timestamp);

  assert.equal(
    formatUnixTimestamp(timestamp, "en", "auto", options),
    new Intl.DateTimeFormat("en", options).format(date),
  );
  assert.equal(
    formatUnixTimestamp(timestamp, "en", "Asia/Shanghai", options),
    new Intl.DateTimeFormat("en", {
      ...options,
      timeZone: "Asia/Shanghai",
    }).format(date),
  );
});
