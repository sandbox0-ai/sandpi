import assert from "node:assert/strict";
import test from "node:test";

import { metricChartPauseBands } from "./metric-chart";

test("clips idle pause intervals to the metrics query window", () => {
  assert.deepEqual(
    metricChartPauseBands(
      [
        {
          startedAt: -20,
          endedAt: 10,
          reason: "idle",
        },
        {
          startedAt: 40,
          reason: "idle",
        },
        {
          startedAt: 110,
          endedAt: 120,
          reason: "idle",
        },
      ],
      { startedAt: 0, endedAt: 100 },
    ),
    [
      {
        startedAt: 0,
        endedAt: 10,
        active: false,
        leftPercent: 0,
        widthPercent: 10,
      },
      {
        startedAt: 40,
        endedAt: 100,
        active: true,
        leftPercent: 40,
        widthPercent: 60,
      },
    ],
  );
});

test("rejects invalid metric windows and zero-width pause intervals", () => {
  assert.deepEqual(
    metricChartPauseBands(
      [{ startedAt: 20, endedAt: 20, reason: "idle" }],
      { startedAt: 0, endedAt: 100 },
    ),
    [],
  );
  assert.deepEqual(
    metricChartPauseBands([], { startedAt: 100, endedAt: 100 }),
    [],
  );
});
