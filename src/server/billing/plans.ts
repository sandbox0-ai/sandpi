import type {
  SandpiAccountPlan,
  SandpiPlanId,
  SandpiSubscriptionStatus,
} from "@/lib/billing";

export const MIB_MILLISECONDS_PER_GIB_HOUR = 1024 * 60 * 60 * 1000;
export const PAST_DUE_GRACE_MS = 72 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface PlanDefinition extends SandpiAccountPlan {
  runtimeQuotaMiBMilliseconds: number | null;
}

export const PLAN_DEFINITIONS = {
  deployment: {
    id: "deployment",
    name: "Self-hosted",
    monthlyPriceUsd: null,
    environmentLimit: null,
    memoryConfigurable: true,
    runtimeQuotaGiBHours: null,
    runtimeQuotaMiBMilliseconds: null,
    quotaPeriod: "unlimited",
  },
  free: {
    id: "free",
    name: "Free",
    monthlyPriceUsd: 0,
    environmentLimit: 1,
    memoryConfigurable: false,
    runtimeQuotaGiBHours: 1,
    runtimeQuotaMiBMilliseconds: MIB_MILLISECONDS_PER_GIB_HOUR,
    quotaPeriod: "account-month",
  },
  plus: {
    id: "plus",
    name: "Plus",
    monthlyPriceUsd: 10,
    environmentLimit: 3,
    memoryConfigurable: true,
    runtimeQuotaGiBHours: 168,
    runtimeQuotaMiBMilliseconds:
      168 * MIB_MILLISECONDS_PER_GIB_HOUR,
    quotaPeriod: "fixed-week",
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPriceUsd: 25,
    environmentLimit: 10,
    memoryConfigurable: true,
    runtimeQuotaGiBHours: 500,
    runtimeQuotaMiBMilliseconds:
      500 * MIB_MILLISECONDS_PER_GIB_HOUR,
    quotaPeriod: "fixed-week",
  },
} as const satisfies Record<SandpiPlanId, PlanDefinition>;

export interface UsagePeriod {
  startsAt: Date;
  endsAt: Date;
}

export function accountMonthPeriod(
  accountCreatedAt: Date,
  now: Date,
): UsagePeriod {
  const anchor = new Date(accountCreatedAt);
  if (now.getTime() < anchor.getTime()) {
    return {
      startsAt: anchor,
      endsAt: addAnchorMonths(anchor, 1),
    };
  }
  let index =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    anchor.getUTCMonth();
  let startsAt = addAnchorMonths(anchor, index);
  if (startsAt.getTime() > now.getTime()) {
    index -= 1;
    startsAt = addAnchorMonths(anchor, index);
  }
  let endsAt = addAnchorMonths(anchor, index + 1);
  if (endsAt.getTime() <= now.getTime()) {
    index += 1;
    startsAt = endsAt;
    endsAt = addAnchorMonths(anchor, index + 1);
  }
  return { startsAt, endsAt };
}

export function fixedWeekPeriod(anchorAt: Date, now: Date): UsagePeriod {
  const anchor = new Date(anchorAt);
  const elapsed = Math.max(0, now.getTime() - anchor.getTime());
  const index = Math.floor(elapsed / WEEK_MS);
  const startsAt = new Date(anchor.getTime() + index * WEEK_MS);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + WEEK_MS),
  };
}

export function subscriptionHasPaidEntitlement(input: {
  status: SandpiSubscriptionStatus;
  graceEndsAt?: Date;
  now: Date;
}) {
  if (input.status === "active" || input.status === "trialing") return true;
  return (
    input.status === "past_due" &&
    Boolean(
      input.graceEndsAt &&
        input.graceEndsAt.getTime() > input.now.getTime(),
    )
  );
}

function addAnchorMonths(anchor: Date, months: number) {
  const firstOfTarget = new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth() + months,
      1,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(
      firstOfTarget.getUTCFullYear(),
      firstOfTarget.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  firstOfTarget.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
  return firstOfTarget;
}
