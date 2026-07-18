import type { UnixTimestamp } from "@/lib/time";

export interface CodexRolloutToolOutput {
  outputType: string;
  createdAt: UnixTimestamp | null;
  nativeStatus: string | null;
  /** Sanitized but otherwise native Codex output-item payload. */
  payload: unknown;
}

/**
 * Durable Codex tool interaction reconstructed from native rollout
 * `response_item` records. This is intentionally Codex-specific and is not
 * part of Sandpi's shared Session contract.
 */
export interface CodexRolloutToolActivity {
  kind: "rolloutToolCall";
  id: string;
  turnId: string;
  createdAt: UnixTimestamp;
  completedAt: UnixTimestamp | null;
  durationMs: number | null;
  status: "running" | "completed" | "failed";
  callId: string;
  callType: string;
  name: string;
  namespace: string | null;
  nativeStatus: string | null;
  /** Sanitized but otherwise native Codex call-item payload. */
  callPayload: unknown;
  /** Every native output for this call, retained in rollout order. */
  outputs: CodexRolloutToolOutput[];
  /** Literal nested `tools.<name>(...)` calls visible in code-mode input. */
  codeModeTools: string[];
  /** True when server-side safety limits shortened any native value. */
  payloadTruncated: boolean;
}

export interface CodexRolloutActivityError {
  code: string;
  message: string;
}

/**
 * A sibling read model to app-server `thread/read`. Codex documents historical
 * ThreadItems as lossy, so persisted tool calls are read from that Thread's
 * own rollout while conversation content remains app-server authoritative.
 */
export interface CodexRolloutActivityFeed {
  source: "codex-rollout";
  availability: "loading" | "available" | "partial" | "unavailable";
  records: CodexRolloutToolActivity[];
  error: CodexRolloutActivityError | null;
}

const CODEX_ROLLOUT_ACTIVITY_AVAILABILITY = new Set<
  CodexRolloutActivityFeed["availability"]
>(["loading", "available", "partial", "unavailable"]);
const CODEX_ROLLOUT_ACTIVITY_STATUSES = new Set<
  CodexRolloutToolActivity["status"]
>(["running", "completed", "failed"]);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function nullableFiniteNumber(value: unknown) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validRolloutToolActivity(value: unknown) {
  const record = objectRecord(value);
  const outputs = Array.isArray(record?.outputs) ? record.outputs : null;
  return Boolean(
    record &&
      record.kind === "rolloutToolCall" &&
      typeof record.id === "string" &&
      typeof record.turnId === "string" &&
      typeof record.createdAt === "number" &&
      Number.isFinite(record.createdAt) &&
      nullableFiniteNumber(record.completedAt) &&
      nullableFiniteNumber(record.durationMs) &&
      typeof record.status === "string" &&
      CODEX_ROLLOUT_ACTIVITY_STATUSES.has(
        record.status as CodexRolloutToolActivity["status"],
      ) &&
      typeof record.callId === "string" &&
      typeof record.callType === "string" &&
      typeof record.name === "string" &&
      nullableString(record.namespace) &&
      nullableString(record.nativeStatus) &&
      Object.hasOwn(record, "callPayload") &&
      outputs &&
      outputs.every((value) => {
        const output = objectRecord(value);
        return Boolean(
          output &&
            typeof output.outputType === "string" &&
            nullableFiniteNumber(output.createdAt) &&
            nullableString(output.nativeStatus) &&
            Object.hasOwn(output, "payload"),
        );
      }) &&
      Array.isArray(record.codeModeTools) &&
      record.codeModeTools.every((name) => typeof name === "string") &&
      typeof record.payloadTruncated === "boolean",
  );
}

function unavailableActivity(
  code: string,
  message: string,
): CodexRolloutActivityFeed {
  return {
    source: "codex-rollout",
    availability: "unavailable",
    records: [],
    error: { code, message },
  };
}

/**
 * Activity is supplemental to the app-server conversation snapshot. Keep an
 * older or malformed server response from turning a usable conversation into
 * an endless history-loading state; the Activity surface reports its own
 * machine-readable failure instead.
 */
export function normalizeCodexRolloutActivityFeed(
  value: unknown,
): CodexRolloutActivityFeed {
  if (value === undefined) {
    return unavailableActivity(
      "codex_rollout_activity_missing",
      "The native snapshot did not include persisted Codex tool activity.",
    );
  }
  const feed = objectRecord(value);
  const error = objectRecord(feed?.error);
  const availability = feed?.availability;
  const validError =
    feed?.error === null ||
    (error && typeof error.code === "string" && typeof error.message === "string");
  if (
    !feed ||
    feed.source !== "codex-rollout" ||
    typeof availability !== "string" ||
    !CODEX_ROLLOUT_ACTIVITY_AVAILABILITY.has(
      availability as CodexRolloutActivityFeed["availability"],
    ) ||
    !Array.isArray(feed.records) ||
    !feed.records.every(validRolloutToolActivity) ||
    !validError ||
    ((availability === "available" || availability === "loading") &&
      feed.error !== null) ||
    ((availability === "partial" || availability === "unavailable") &&
      feed.error === null) ||
    (availability === "loading" && feed.records.length > 0)
  ) {
    return unavailableActivity(
      "codex_rollout_activity_invalid",
      "The native snapshot included an invalid Codex tool activity payload.",
    );
  }
  return value as CodexRolloutActivityFeed;
}
