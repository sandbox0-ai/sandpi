"use client";

import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import type {
  EnvironmentMetricWindow,
  EnvironmentPauseInterval,
  MetricPoint,
  MetricSegment,
} from "@/lib/types";

export type MetricChartTone = "green" | "blue" | "amber";

export interface MetricChartSeries {
  id: string;
  label: string;
  stepSeconds: number;
  segments: MetricSegment[];
  tone: MetricChartTone;
}

interface InteractiveMetricChartProps {
  series: MetricChartSeries[];
  max?: number;
  title: string;
  instructions: string;
  legendLabel: string;
  pauseLabel: string;
  window: EnvironmentMetricWindow;
  pauseIntervals: EnvironmentPauseInterval[];
  toggleSeriesLabel: (label: string, visible: boolean) => string;
  formatTime: (at: number) => string;
  formatValue: (value: number) => string;
}

const WIDTH = 520;
const HEIGHT = 88;
const PLOT_TOP = 7;
const PLOT_BOTTOM = 7;

function pointTime(point: MetricPoint): number {
  return point.at;
}

function findNearestIndex(times: number[], target: number): number {
  if (times.length <= 1) {
    return 0;
  }

  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  if (low === 0) {
    return 0;
  }
  return target - times[low - 1] <= times[low] - target ? low - 1 : low;
}

function seriesPointAt(series: MetricChartSeries, at: number) {
  return series.segments
    .flatMap((segment) => segment.points)
    .find((point) => pointTime(point) === at);
}

export interface MetricChartPauseBand {
  startedAt: number;
  endedAt: number;
  active: boolean;
  leftPercent: number;
  widthPercent: number;
}

/** Clips durable pause intervals to the exact metrics query window. */
export function metricChartPauseBands(
  pauseIntervals: EnvironmentPauseInterval[],
  window: EnvironmentMetricWindow,
): MetricChartPauseBand[] {
  const duration = window.endedAt - window.startedAt;
  if (
    !Number.isFinite(window.startedAt) ||
    !Number.isFinite(window.endedAt) ||
    duration <= 0
  ) {
    return [];
  }
  return pauseIntervals.flatMap((interval) => {
    const startedAt = Math.max(interval.startedAt, window.startedAt);
    const endedAt = Math.min(interval.endedAt ?? window.endedAt, window.endedAt);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(endedAt) ||
      endedAt <= startedAt
    ) {
      return [];
    }
    return [
      {
        startedAt,
        endedAt,
        active: interval.endedAt === undefined,
        leftPercent: ((startedAt - window.startedAt) / duration) * 100,
        widthPercent: ((endedAt - startedAt) / duration) * 100,
      },
    ];
  });
}

/**
 * Extends bucket-backed segment endpoints to an overlapping durable pause.
 * Sandbox0 timestamps aggregates at the bucket start, so the final point on
 * either side may otherwise stop up to one effective step short of the exact
 * lifecycle boundary. Source segments stay separate and longer gaps remain
 * visible.
 */
export function metricChartAlignedSegments(
  segments: MetricSegment[],
  stepSeconds: number,
  pauseBands: MetricChartPauseBand[],
): MetricSegment[] {
  if (
    !Number.isFinite(stepSeconds) ||
    stepSeconds <= 0 ||
    pauseBands.length === 0
  ) {
    return segments;
  }

  const aligned = segments.map((segment) => ({
    points: [...segment.points],
  }));

  for (const band of pauseBands) {
    let beforeIndex = -1;
    let beforeAt = Number.NEGATIVE_INFINITY;

    for (const [index, segment] of aligned.entries()) {
      const last = segment.points.at(-1);
      if (
        last &&
        Number.isFinite(last.at) &&
        last.at <= band.startedAt &&
        band.startedAt - last.at <= stepSeconds &&
        last.at > beforeAt
      ) {
        beforeIndex = index;
        beforeAt = last.at;
      }
    }

    if (beforeIndex >= 0 && beforeAt < band.startedAt) {
      const segment = aligned[beforeIndex];
      const last = segment?.points.at(-1);
      if (segment && last) {
        segment.points.push({ at: band.startedAt, value: last.value });
      }
    }

    if (band.active) {
      continue;
    }

    let afterIndex = -1;
    let afterDistance = Number.POSITIVE_INFINITY;
    const firstAllowedIndex = beforeIndex >= 0 ? beforeIndex + 1 : 0;

    for (let index = firstAllowedIndex; index < aligned.length; index += 1) {
      const segment = aligned[index];
      const first = segment?.points[0];
      const last = segment?.points.at(-1);
      if (
        !first ||
        !last ||
        !Number.isFinite(first.at) ||
        !Number.isFinite(last.at) ||
        last.at < band.endedAt ||
        first.at < band.startedAt - stepSeconds
      ) {
        continue;
      }
      const distance = Math.abs(first.at - band.endedAt);
      if (distance <= stepSeconds && distance < afterDistance) {
        afterIndex = index;
        afterDistance = distance;
      }
    }

    if (afterIndex < 0) {
      continue;
    }

    const segment = aligned[afterIndex];
    const first = segment?.points[0];
    if (!segment || !first || first.at === band.endedAt) {
      continue;
    }
    if (first.at > band.endedAt) {
      segment.points.unshift({ at: band.endedAt, value: first.value });
      continue;
    }

    const boundarySource =
      segment.points.findLast((point) => point.at <= band.endedAt) ?? first;
    segment.points = [
      { at: band.endedAt, value: boundarySource.value },
      ...segment.points.filter((point) => point.at > band.endedAt),
    ];
  }

  return aligned;
}

export function InteractiveMetricChart({
  series,
  max,
  title,
  instructions,
  legendLabel,
  pauseLabel,
  window,
  pauseIntervals,
  toggleSeriesLabel,
  formatTime,
  formatValue,
}: InteractiveMetricChartProps) {
  const instructionsId = useId();
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [pointerActive, setPointerActive] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const visibleSeries = series.filter((item) => !hiddenSeries.has(item.id));
  const timeline = useMemo(
    () =>
      Array.from(
        new Set(
          series.flatMap((item) =>
            item.segments.flatMap((segment) =>
              segment.points.map(pointTime).filter(Number.isFinite),
            ),
          ),
        ),
      ).sort((left, right) => left - right),
    [series],
  );
  const start = window.startedAt;
  const end = window.endedAt;
  const duration = Math.max(end - start, 1);
  const pauseBands = useMemo(
    () => metricChartPauseBands(pauseIntervals, window),
    [pauseIntervals, window],
  );
  const renderedSeries = visibleSeries.map((item) => ({
    ...item,
    segments: metricChartAlignedSegments(
      item.segments,
      item.stepSeconds,
      pauseBands,
    ),
  }));
  const largestValue = Math.max(
    ...visibleSeries.flatMap((item) =>
      item.segments.flatMap((segment) =>
        segment.points.map((point) => point.value),
      ),
    ),
    1,
  );
  const upper = max ?? largestValue * 1.12;

  function xFor(at: number) {
    return ((at - start) / duration) * WIDTH;
  }

  function yFor(value: number) {
    const plotHeight = HEIGHT - PLOT_TOP - PLOT_BOTTOM;
    const normalized = Math.min(Math.max(value / Math.max(upper, 1), 0), 1);
    return HEIGHT - PLOT_BOTTOM - normalized * plotHeight;
  }

  function linePath(points: MetricPoint[]) {
    return points
      .map((point, index) => {
        const command = index === 0 ? "M" : "L";
        return `${command}${xFor(point.at).toFixed(1)},${yFor(point.value).toFixed(1)}`;
      })
      .join(" ");
  }

  function areaPath(points: MetricPoint[]) {
    if (points.length === 0) {
      return "";
    }
    const baseline = HEIGHT - PLOT_BOTTOM;
    const line = linePath(points);
    return `${line} L${xFor(points.at(-1)?.at ?? start).toFixed(1)},${baseline} L${xFor(points[0].at).toFixed(1)},${baseline} Z`;
  }

  function selectFromPointer(event: PointerEvent<HTMLDivElement>) {
    if (timeline.length === 0) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      Math.max((event.clientX - bounds.left) / Math.max(bounds.width, 1), 0),
      1,
    );
    setActiveIndex(findNearestIndex(timeline, start + ratio * duration));
    setPointerActive(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (timeline.length === 0) {
      return;
    }
    const current = activeIndex ?? timeline.length - 1;
    let next = current;
    if (event.key === "ArrowLeft") {
      next = Math.max(current - 1, 0);
    } else if (event.key === "ArrowRight") {
      next = Math.min(current + 1, timeline.length - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = timeline.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    setActiveIndex(next);
    setKeyboardActive(true);
  }

  function toggleSeries(id: string) {
    setHiddenSeries((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else if (series.length - next.size > 1) {
        // Keep one series visible so the chart never becomes an unexplained empty state.
        next.add(id);
      }
      return next;
    });
  }

  const showActivePoint =
    activeIndex !== null && (pointerActive || keyboardActive);
  const activeTime =
    activeIndex === null ? undefined : timeline[activeIndex] ?? undefined;
  const activeValues =
    activeTime === undefined
      ? []
      : visibleSeries.map((item) => ({
          series: item,
          point: seriesPointAt(item, activeTime),
        }));
  const tooltipLeft =
    activeTime === undefined
      ? 50
      : Math.min(Math.max((xFor(activeTime) / WIDTH) * 100, 16), 84);
  const activeDescription =
    activeTime === undefined
      ? ""
      : `${formatTime(activeTime)}. ${activeValues
          .filter((item) => item.point)
          .map(
            (item) =>
              `${item.series.label}: ${formatValue(item.point?.value ?? 0)}`,
          )
          .join(". ")}`;

  return (
    <div className="metric-chart-shell">
      <div
        className="metric-chart-plot"
        role="group"
        tabIndex={0}
        aria-label={title}
        aria-describedby={instructionsId}
        onPointerDown={selectFromPointer}
        onPointerMove={selectFromPointer}
        onPointerLeave={() => setPointerActive(false)}
        onFocus={() => {
          setKeyboardActive(true);
          setActiveIndex((current) => current ?? Math.max(timeline.length - 1, 0));
        }}
        onBlur={() => setKeyboardActive(false)}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only" id={instructionsId}>
          {instructions}
        </span>
        <svg
          className="metric-chart"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            className="metric-chart-grid"
            d={`M0,22 H${WIDTH} M0,44 H${WIDTH} M0,66 H${WIDTH}`}
          />
          {renderedSeries.flatMap((item) =>
            item.segments.map((segment, index) => (
              <path
                className={`metric-chart-area tone-${item.tone}`}
                d={areaPath(segment.points)}
                key={`${item.id}-area-${index}`}
              />
            )),
          )}
          {pauseBands.map((band) => {
            const x = (band.leftPercent / 100) * WIDTH;
            const width = Math.min(
              WIDTH - x,
              Math.max((band.widthPercent / 100) * WIDTH, 1.5),
            );
            return (
              <rect
                className={`metric-chart-pause-band ${
                  band.active ? "is-active" : ""
                }`}
                x={x}
                y={PLOT_TOP}
                width={width}
                height={HEIGHT - PLOT_TOP - PLOT_BOTTOM}
                key={`${band.startedAt}-${band.endedAt}`}
              >
                <title>{pauseLabel}</title>
              </rect>
            );
          })}
          {renderedSeries.flatMap((item) =>
            item.segments.map((segment, index) => (
              <path
                className={`metric-chart-line tone-${item.tone}`}
                d={linePath(segment.points)}
                key={`${item.id}-line-${index}`}
              />
            )),
          )}
          {showActivePoint && activeTime !== undefined ? (
            <>
              <line
                className="metric-chart-crosshair"
                x1={xFor(activeTime)}
                x2={xFor(activeTime)}
                y1={PLOT_TOP}
                y2={HEIGHT - PLOT_BOTTOM}
              />
              {activeValues.map((item) =>
                item.point ? (
                  <circle
                    className={`metric-chart-point tone-${item.series.tone}`}
                    cx={xFor(item.point.at)}
                    cy={yFor(item.point.value)}
                    key={item.series.id}
                    r="3.4"
                  />
                ) : null,
              )}
            </>
          ) : null}
        </svg>
        {showActivePoint && activeTime !== undefined ? (
          <div
            className="metric-chart-tooltip"
            style={{ left: `${tooltipLeft}%` }}
            aria-hidden="true"
          >
            <time>{formatTime(activeTime)}</time>
            {activeValues.map((item) =>
              item.point ? (
                <span key={item.series.id}>
                  <i className={`tone-${item.series.tone}`} />
                  {item.series.label}
                  <strong>{formatValue(item.point.value)}</strong>
                </span>
              ) : null,
            )}
          </div>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {showActivePoint ? activeDescription : ""}
        </span>
        {pauseBands.length > 0 ? (
          <span className="sr-only">
            {pauseLabel}:{" "}
            {pauseBands
              .map(
                (band) =>
                  `${formatTime(band.startedAt)}–${formatTime(band.endedAt)}`,
              )
              .join("; ")}
          </span>
        ) : null}
      </div>
      {series.length > 1 ? (
        <div className="metric-chart-legend" aria-label={legendLabel}>
          {series.map((item) => {
            const visible = !hiddenSeries.has(item.id);
            return (
              <button
                type="button"
                className={visible ? "" : "is-hidden"}
                aria-pressed={visible}
                aria-label={toggleSeriesLabel(item.label, visible)}
                key={item.id}
                onClick={() => toggleSeries(item.id)}
              >
                <i className={`tone-${item.tone}`} />
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {pauseBands.length > 0 ? (
        <div className="metric-chart-pause-legend">
          <i aria-hidden="true" />
          <span>{pauseLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
