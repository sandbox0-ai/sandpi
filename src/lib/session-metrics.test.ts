import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_METRIC_RANGE_SECONDS,
  isSessionMetricRangeSeconds,
  SESSION_METRIC_RANGES_SECONDS,
} from "./session-metrics";

test("accepts only the metric windows exposed by the Session inspector", () => {
  assert.equal(DEFAULT_SESSION_METRIC_RANGE_SECONDS, 60 * 60);
  assert.deepEqual(SESSION_METRIC_RANGES_SECONDS, [900, 3_600, 21_600, 86_400, 604_800]);
  assert.equal(isSessionMetricRangeSeconds(21_600), true);
  assert.equal(isSessionMetricRangeSeconds(0), false);
  assert.equal(isSessionMetricRangeSeconds(3_601), false);
});
