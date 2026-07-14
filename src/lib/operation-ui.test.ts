import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAuditDateTime,
  formatAuditTime,
  getAuditTimeFormatOptions,
  shouldSubmitComposer,
} from "./operation-ui";
import { toUnixTimestamp } from "./time";

const key = {
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
};

test("composer shortcut preserves newlines and IME composition", () => {
  assert.equal(shouldSubmitComposer(key, "enter"), true);
  assert.equal(
    shouldSubmitComposer({ ...key, shiftKey: true }, "enter"),
    false,
  );
  assert.equal(
    shouldSubmitComposer({ ...key, isComposing: true }, "enter"),
    false,
  );
  assert.equal(shouldSubmitComposer(key, "mod-enter"), false);
  assert.equal(
    shouldSubmitComposer({ ...key, metaKey: true }, "mod-enter"),
    true,
  );
  assert.equal(
    shouldSubmitComposer({ ...key, ctrlKey: true }, "mod-enter"),
    true,
  );
  assert.equal(
    shouldSubmitComposer(
      { ...key, ctrlKey: true, shiftKey: true },
      "mod-enter",
    ),
    false,
  );
});

test("audit time options omit the time zone for system mode", () => {
  assert.deepEqual(getAuditTimeFormatOptions("auto"), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  assert.equal(
    getAuditTimeFormatOptions("Asia/Shanghai").timeZone,
    "Asia/Shanghai",
  );
});

test("audit time formatting respects locale and configured time zone", () => {
  const timestamp = toUnixTimestamp(new Date("2026-07-12T00:00:00.000Z"));
  assert.equal(formatAuditTime(timestamp, "en", "UTC"), "00:00:00");
  assert.equal(
    formatAuditTime(timestamp, "zh-CN", "Asia/Shanghai"),
    "08:00:00",
  );
  assert.match(
    formatAuditDateTime(timestamp, "en", "UTC"),
    /Jul 12, 00:00:00/,
  );
});
