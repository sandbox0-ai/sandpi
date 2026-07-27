import type {
  CodexTokenUsage,
  CodexTokenUsageDailyBucket,
} from "@/harnesses/codex/native-capabilities";

export type CodexTokenUsageView = "daily" | "weekly" | "cumulative";

export interface CodexTokenUsagePoint {
  label: string;
  value: number;
}

export function parseCodexTokenUsageView(
  value: string,
): CodexTokenUsageView | undefined {
  switch (value.trim().toLowerCase()) {
    case "":
    case "day":
    case "daily":
      return "daily";
    case "week":
    case "weekly":
      return "weekly";
    case "cumulative":
      return "cumulative";
    default:
      return undefined;
  }
}

export function codexTokenUsagePoints(
  usage: CodexTokenUsage,
  view: CodexTokenUsageView,
): CodexTokenUsagePoint[] {
  const days = normalizedDays(usage.dailyUsageBuckets);
  if (view === "daily") {
    return days.slice(-35).map((day) => ({
      label: day.startDate,
      value: day.tokens,
    }));
  }

  const weekly = new Map<string, number>();
  for (const day of days) {
    const week = sundayStart(day.startDate);
    if (!week) continue;
    weekly.set(week, (weekly.get(week) ?? 0) + day.tokens);
  }
  const points = [...weekly.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-52)
    .map(([label, value]) => ({ label, value }));
  if (view === "weekly") return points;

  let total = 0;
  return points.map((point) => {
    total += point.value;
    return { label: point.label, value: total };
  });
}

function normalizedDays(buckets: CodexTokenUsageDailyBucket[]) {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    if (!validDate(bucket.startDate)) continue;
    totals.set(
      bucket.startDate,
      (totals.get(bucket.startDate) ?? 0) + Math.max(0, bucket.tokens),
    );
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([startDate, tokens]) => ({ startDate, tokens }));
}

function sundayStart(value: string) {
  if (!validDate(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
  );
}
