export const ENVIRONMENT_METRIC_RANGES_SECONDS = [
  15 * 60,
  60 * 60,
  6 * 60 * 60,
  24 * 60 * 60,
  7 * 24 * 60 * 60,
] as const;

export type EnvironmentMetricRangeSeconds =
  (typeof ENVIRONMENT_METRIC_RANGES_SECONDS)[number];

export const DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS: EnvironmentMetricRangeSeconds =
  60 * 60;

/** Sandbox0 samples runtime resources every 15 seconds; keep the badge query equally light. */
export const ENVIRONMENT_RESOURCE_METRIC_POLL_INTERVAL_MS = 15_000;
export const ENVIRONMENT_RESOURCE_METRIC_RETRY_INTERVAL_MS = 60_000;
export const ENVIRONMENT_RESOURCE_METRIC_LOOKBACK_SECONDS = 60;

export function isEnvironmentMetricRangeSeconds(
  value: number,
): value is EnvironmentMetricRangeSeconds {
  return ENVIRONMENT_METRIC_RANGES_SECONDS.some(
    (candidate) => candidate === value,
  );
}

export function environmentResourceMetricPercent(
  value: number | null | undefined,
) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const percent = Math.min(Math.max(value, 0), 1) * 100;
  return percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent);
}
