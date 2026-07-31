import type { UnixTimestamp } from "./time";

export interface RuntimePlanBlock {
  code: "sandbox_runtime_quota_exhausted" | "environment_plan_limit";
  message: string;
  planId?: string;
  resetAt?: UnixTimestamp;
  usedGiBHours?: number;
  limitGiBHours?: number;
}

export function runtimePlanBlockFromMeta(
  meta: Record<string, unknown> | undefined,
): RuntimePlanBlock | undefined {
  if (meta?.runtimeAccess !== "persistent-storage") return undefined;
  const block = objectRecord(meta.runtimeBlock);
  const details = objectRecord(block?.details);
  const code = block?.code;
  if (
    code !== "sandbox_runtime_quota_exhausted" &&
    code !== "environment_plan_limit"
  ) {
    return undefined;
  }
  return {
    code,
    message:
      typeof block?.message === "string" && block.message.trim()
        ? block.message
        : "Sandbox runtime access is blocked by the current plan.",
    planId: finiteString(details?.planId),
    resetAt: finiteNumber(details?.resetAt),
    usedGiBHours: finiteNumber(details?.usedGiBHours),
    limitGiBHours: finiteNumber(details?.limitGiBHours),
  };
}

function objectRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function finiteString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}
