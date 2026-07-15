import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS,
  ENVIRONMENT_METRIC_RANGES_SECONDS,
  isEnvironmentMetricRangeSeconds,
} from "./environment-metrics";

test("accepts only the metric windows exposed by the Environment inspector", () => {
  assert.equal(DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS, 60 * 60);
  assert.deepEqual(ENVIRONMENT_METRIC_RANGES_SECONDS, [
    900,
    3_600,
    21_600,
    86_400,
    604_800,
  ]);
  assert.equal(isEnvironmentMetricRangeSeconds(21_600), true);
  assert.equal(isEnvironmentMetricRangeSeconds(0), false);
  assert.equal(isEnvironmentMetricRangeSeconds(3_601), false);
});
