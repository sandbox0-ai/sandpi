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

export function isEnvironmentMetricRangeSeconds(
  value: number,
): value is EnvironmentMetricRangeSeconds {
  return ENVIRONMENT_METRIC_RANGES_SECONDS.some(
    (candidate) => candidate === value,
  );
}
