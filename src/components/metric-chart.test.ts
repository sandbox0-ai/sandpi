import assert from "node:assert/strict";
import test from "node:test";

import {
  metricChartAlignedSegments,
  metricChartPauseBands,
} from "./metric-chart";

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

test("aligns adjacent metric bucket endpoints to an idle pause", () => {
  const segments = [
    {
      points: [
        { at: 0, value: 1 },
        { at: 20, value: 2 },
      ],
    },
    {
      points: [
        { at: 34, value: 3 },
        { at: 40, value: 4 },
      ],
    },
  ];
  const bands = metricChartPauseBands(
    [{ startedAt: 25, endedAt: 35, reason: "idle" }],
    { startedAt: 0, endedAt: 100 },
  );

  assert.deepEqual(metricChartAlignedSegments(segments, 10, bands), [
    {
      points: [
        { at: 0, value: 1 },
        { at: 20, value: 2 },
        { at: 25, value: 2 },
      ],
    },
    {
      points: [
        { at: 35, value: 3 },
        { at: 40, value: 4 },
      ],
    },
  ]);
  assert.equal(segments[0]?.points.at(-1)?.at, 20);
  assert.equal(segments[1]?.points[0]?.at, 34);
});

test("does not hide metric gaps longer than one aggregation step", () => {
  const segments = [
    { points: [{ at: 10, value: 1 }] },
    { points: [{ at: 50, value: 2 }] },
  ];
  const bands = metricChartPauseBands(
    [{ startedAt: 25, endedAt: 35, reason: "idle" }],
    { startedAt: 0, endedAt: 100 },
  );

  assert.deepEqual(metricChartAlignedSegments(segments, 10, bands), segments);
});

test("aligns the final metric bucket to an active idle pause", () => {
  const bands = metricChartPauseBands(
    [{ startedAt: 25, reason: "idle" }],
    { startedAt: 0, endedAt: 100 },
  );

  assert.deepEqual(
    metricChartAlignedSegments(
      [
        {
          points: [
            { at: 0, value: 1 },
            { at: 20, value: 2 },
          ],
        },
      ],
      10,
      bands,
    ),
    [
      {
        points: [
          { at: 0, value: 1 },
          { at: 20, value: 2 },
          { at: 25, value: 2 },
        ],
      },
    ],
  );
});
