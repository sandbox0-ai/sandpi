import {
  formatUnixTimestamp,
  type UnixTimestamp,
} from "./time";

export const SANDPI_FREE_SANDBOX_MEMORY_MIB = 2 * 1024;
export const SANDPI_FREE_RUNTIME_HOURS = 2;

export const SANDPI_PAID_PLAN_IDS = ["plus", "pro", "ultra"] as const;
export type SandpiPaidPlanId = (typeof SANDPI_PAID_PLAN_IDS)[number];
export const SANDPI_PLAN_IDS = [
  "deployment",
  "free",
  ...SANDPI_PAID_PLAN_IDS,
] as const;
export type SandpiPlanId = (typeof SANDPI_PLAN_IDS)[number];
export type SandpiSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface SandpiAccountPlan {
  id: SandpiPlanId;
  name: string;
  annualPriceUsd: number | null;
  environmentLimit: number | null;
  memoryConfigurable: boolean;
  runtimeQuotaGiBHours: number | null;
  quotaPeriod: "account-month" | "fixed-week" | "unlimited";
}

export interface SandpiUsageSummary {
  periodStartsAt: UnixTimestamp;
  periodEndsAt: UnixTimestamp;
  confirmedMiBMilliseconds: number;
  projectedMiBMilliseconds: number;
  usedMiBMilliseconds: number;
  limitMiBMilliseconds: number | null;
  remainingMiBMilliseconds: number | null;
  usedGiBHours: number;
  limitGiBHours: number | null;
  percentUsed: number | null;
  exhausted: boolean;
}

export interface SandpiSubscriptionSummary {
  status: SandpiSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodEndsAt?: UnixTimestamp;
  graceEndsAt?: UnixTimestamp;
  pendingPlanId?: SandpiPaidPlanId;
  pendingEffectiveAt?: UnixTimestamp;
}

export interface SandpiBillingSummary {
  billingEnabled: boolean;
  plan: SandpiAccountPlan;
  availablePlans: SandpiAccountPlan[];
  subscription?: SandpiSubscriptionSummary;
  usage: SandpiUsageSummary;
  environmentCount: number;
  overEnvironmentLimit: boolean;
  customerPortalAvailable: boolean;
  usageSource: "sandbox0-sdk" | "billing-disabled";
}

export interface SandpiCheckoutResult {
  kind: "checkout" | "subscription-updated";
  url?: string;
}

export interface SandpiRuntimeUsageDisplay {
  used: number;
  limit: number | null;
  unit: "hours" | "gib-hours";
}

export function formatRuntimeQuantity(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value);
}

export function runtimeUsageDisplay(
  plan: SandpiAccountPlan,
  usage: SandpiUsageSummary,
): SandpiRuntimeUsageDisplay {
  if (plan.id !== "free") {
    return {
      used: usage.usedGiBHours,
      limit: usage.limitGiBHours,
      unit: "gib-hours",
    };
  }

  const memoryGiB = SANDPI_FREE_SANDBOX_MEMORY_MIB / 1024;
  return {
    used: usage.usedGiBHours / memoryGiB,
    limit:
      usage.limitGiBHours == null
        ? null
        : usage.limitGiBHours / memoryGiB,
    unit: "hours",
  };
}

export function formatUsageResetTime(
  periodEndsAt: UnixTimestamp,
  language: string,
  timeZone: string,
) {
  return formatUnixTimestamp(periodEndsAt, language, timeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function isSandpiPaidPlanId(value: string): value is SandpiPaidPlanId {
  return (SANDPI_PAID_PLAN_IDS as readonly string[]).includes(value);
}
