import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS,
  ENVIRONMENT_METRIC_RANGES_SECONDS,
  environmentResourceMetricPercent,
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

test("formats compact resource ratios as bounded percentages", () => {
  assert.equal(environmentResourceMetricPercent(0), 0);
  assert.equal(environmentResourceMetricPercent(0.0027), 0.3);
  assert.equal(environmentResourceMetricPercent(0.074), 7.4);
  assert.equal(environmentResourceMetricPercent(0.075), 7.5);
  assert.equal(environmentResourceMetricPercent(0.424), 42);
  assert.equal(environmentResourceMetricPercent(1), 100);
  assert.equal(environmentResourceMetricPercent(1.25), 100);
  assert.equal(environmentResourceMetricPercent(-0.1), 0);
});

test("omits unavailable resource ratios", () => {
  assert.equal(environmentResourceMetricPercent(null), null);
  assert.equal(environmentResourceMetricPercent(undefined), null);
  assert.equal(environmentResourceMetricPercent(Number.NaN), null);
  assert.equal(environmentResourceMetricPercent(Number.POSITIVE_INFINITY), null);
});
