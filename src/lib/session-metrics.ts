export const SESSION_METRIC_RANGES_SECONDS = [
  15 * 60,
  60 * 60,
  6 * 60 * 60,
  24 * 60 * 60,
  7 * 24 * 60 * 60,
] as const;

export type SessionMetricRangeSeconds =
  (typeof SESSION_METRIC_RANGES_SECONDS)[number];

export const DEFAULT_SESSION_METRIC_RANGE_SECONDS: SessionMetricRangeSeconds =
  60 * 60;

export function isSessionMetricRangeSeconds(
  value: number,
): value is SessionMetricRangeSeconds {
  return SESSION_METRIC_RANGES_SECONDS.some((candidate) => candidate === value);
}
