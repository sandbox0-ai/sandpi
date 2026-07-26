import type { UnixTimestamp } from "./time";

export type SandpiPlanId = "deployment" | "free" | "plus" | "pro";
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
  monthlyPriceUsd: number | null;
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
  pendingPlanId?: "plus" | "pro";
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
  usageSource: "sandbox0-sdk" | "local-projection";
}

export interface SandpiCheckoutResult {
  kind: "checkout" | "subscription-updated";
  url?: string;
}

export function formatGiBHours(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 2 : 1,
  }).format(value);
}
