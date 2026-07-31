import type {
  SandpiAccountPlan,
  SandpiBillingSummary,
} from "@/lib/billing";
import type { EnvironmentSandboxState } from "@/lib/types";
import { toUnixTimestamp } from "@/lib/time";
import type { SandpiConfig } from "@/server/config";
import { HttpError, notFound } from "@/server/http-error";

import {
  accountMonthPeriod,
  fixedWeekPeriod,
  MIB_MILLISECONDS_PER_GIB_HOUR,
  PLAN_DEFINITIONS,
  type PlanDefinition,
  subscriptionHasPaidEntitlement,
} from "./plans";
import type {
  BillingAccountRecord,
  EnvironmentEntitlementPosition,
  RunningEnvironmentCandidate,
  SubscriptionRecord,
  UsageTotals,
} from "./repository";

export interface BillingQuotaStore {
  account(userId: string): Promise<BillingAccountRecord | undefined>;
  subscription(userId: string): Promise<SubscriptionRecord | undefined>;
  stripeCustomerId(userId: string): Promise<string | undefined>;
  environmentCount(userId: string): Promise<number>;
  environmentEntitlementPosition(
    environmentId: string,
  ): Promise<EnvironmentEntitlementPosition | undefined>;
  usageTotals(
    userId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<UsageTotals>;
  runningEnvironmentCandidates(): Promise<RunningEnvironmentCandidate[]>;
}

export interface EnvironmentQuotaPolicy {
  environmentCreationPolicy(userId: string): Promise<{
    environmentLimit: number | null;
    fixedSandboxMemoryMiB: number | null;
  }>;
  assertMemoryConfigurationAllowed(
    userId: string,
    currentMemoryMiB: number,
    requestedMemoryMiB: number,
  ): Promise<void>;
}

export interface RuntimeQuotaGate {
  assertEnvironmentRuntimeAllowed(environmentId: string): Promise<void>;
  isEnvironmentRuntimeBlocked?(
    environmentId: string,
  ): Promise<boolean>;
}

export interface SandboxLifecycleReader {
  getEnvironmentSandboxState(
    sandboxId: string,
  ): Promise<EnvironmentSandboxState>;
}

interface ResolvedEntitlement {
  account: BillingAccountRecord;
  plan: PlanDefinition;
  subscription?: SubscriptionRecord;
  period: { startsAt: Date; endsAt: Date };
}

export interface EnvironmentPlanEnforcement {
  pauseEnvironmentIds: string[];
  reconcileMemoryEnvironmentIds: string[];
}

export class BillingQuotaService
  implements EnvironmentQuotaPolicy, RuntimeQuotaGate
{
  constructor(
    private readonly store: BillingQuotaStore,
    private readonly billing: SandpiConfig["billing"],
    private readonly runtime: SandboxLifecycleReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async summary(userId: string): Promise<SandpiBillingSummary> {
    const entitlement = await this.resolveEntitlement(userId);
    const [usage, environmentCount, customerId] = await Promise.all([
      this.store.usageTotals(
        userId,
        entitlement.period.startsAt,
        entitlement.period.endsAt,
      ),
      this.store.environmentCount(userId),
      this.store.stripeCustomerId(userId),
    ]);
    const limit = entitlement.plan.runtimeQuotaMiBMilliseconds;
    const used = Math.max(
      usage.confirmedMiBMilliseconds,
      usage.projectedMiBMilliseconds,
    );
    const remaining = limit == null ? null : Math.max(0, limit - used);

    return {
      billingEnabled: this.billing.mode === "stripe",
      plan: publicPlan(entitlement.plan),
      availablePlans:
        this.billing.mode === "stripe"
          ? [
              publicPlan(PLAN_DEFINITIONS.free),
              publicPlan(PLAN_DEFINITIONS.plus),
              publicPlan(PLAN_DEFINITIONS.pro),
              publicPlan(PLAN_DEFINITIONS.ultra),
            ]
          : [publicPlan(PLAN_DEFINITIONS.deployment)],
      subscription: entitlement.subscription
        ? {
            status: entitlement.subscription.status,
            cancelAtPeriodEnd:
              entitlement.subscription.cancelAtPeriodEnd,
            currentPeriodEndsAt:
              entitlement.subscription.currentPeriodEndsAt &&
              toUnixTimestamp(
                entitlement.subscription.currentPeriodEndsAt,
              ),
            graceEndsAt:
              entitlement.subscription.graceEndsAt &&
              toUnixTimestamp(entitlement.subscription.graceEndsAt),
            pendingPlanId: entitlement.subscription.pendingPlanId,
            pendingEffectiveAt:
              entitlement.subscription.pendingEffectiveAt &&
              toUnixTimestamp(
                entitlement.subscription.pendingEffectiveAt,
              ),
          }
        : undefined,
      usage: {
        periodStartsAt: toUnixTimestamp(entitlement.period.startsAt),
        periodEndsAt: toUnixTimestamp(entitlement.period.endsAt),
        confirmedMiBMilliseconds: usage.confirmedMiBMilliseconds,
        projectedMiBMilliseconds: usage.projectedMiBMilliseconds,
        usedMiBMilliseconds: used,
        limitMiBMilliseconds: limit,
        remainingMiBMilliseconds: remaining,
        usedGiBHours: used / MIB_MILLISECONDS_PER_GIB_HOUR,
        limitGiBHours: entitlement.plan.runtimeQuotaGiBHours,
        percentUsed:
          limit == null ? null : Math.min(100, (used / limit) * 100),
        exhausted: limit != null && used >= limit,
      },
      environmentCount,
      overEnvironmentLimit:
        entitlement.plan.environmentLimit != null &&
        environmentCount > entitlement.plan.environmentLimit,
      customerPortalAvailable:
        this.billing.mode === "stripe" && Boolean(customerId),
      usageSource:
        this.billing.mode === "stripe"
          ? "sandbox0-sdk"
          : "local-projection",
    };
  }

  async environmentCreationPolicy(userId: string) {
    const plan = (await this.resolveEntitlement(userId)).plan;
    return {
      environmentLimit: plan.environmentLimit,
      fixedSandboxMemoryMiB: plan.fixedSandboxMemoryMiB,
    };
  }

  async assertMemoryConfigurationAllowed(
    userId: string,
    currentMemoryMiB: number,
    requestedMemoryMiB: number,
  ) {
    if (currentMemoryMiB === requestedMemoryMiB) return;
    const entitlement = await this.resolveEntitlement(userId);
    if (entitlement.plan.fixedSandboxMemoryMiB == null) return;
    throw new HttpError(
      403,
      "sandbox_memory_plan_restricted",
      `The ${entitlement.plan.name} plan fixes Sandbox memory at ${entitlement.plan.fixedSandboxMemoryMiB / 1024} GiB. Upgrade to change it.`,
      {
        planId: entitlement.plan.id,
        fixedSandboxMemoryMiB: entitlement.plan.fixedSandboxMemoryMiB,
      },
    );
  }

  async assertEnvironmentRuntimeAllowed(environmentId: string) {
    if (this.billing.mode === "disabled") return;
    const position =
      await this.store.environmentEntitlementPosition(environmentId);
    if (!position) {
      throw notFound("environment_not_found", "Environment not found.");
    }
    const entitlement = await this.resolveEntitlement(position.userId);
    if (
      entitlement.plan.environmentLimit != null &&
      position.position > entitlement.plan.environmentLimit
    ) {
      throw environmentPlanLimitError(
        entitlement.plan,
        entitlement.period.endsAt,
      );
    }
    const usage = await this.store.usageTotals(
      position.userId,
      entitlement.period.startsAt,
      entitlement.period.endsAt,
    );
    if (
      entitlement.plan.runtimeQuotaMiBMilliseconds != null &&
      Math.max(
        usage.confirmedMiBMilliseconds,
        usage.projectedMiBMilliseconds,
      ) >= entitlement.plan.runtimeQuotaMiBMilliseconds
    ) {
      throw runtimeQuotaError(
        entitlement.plan,
        entitlement.period.endsAt,
      );
    }
  }

  async isEnvironmentRuntimeBlocked(environmentId: string) {
    try {
      await this.assertEnvironmentRuntimeAllowed(environmentId);
      return false;
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.code === "environment_plan_limit" ||
          error.code === "sandbox_runtime_quota_exhausted")
      ) {
        return true;
      }
      throw error;
    }
  }

  async environmentPlanEnforcement(): Promise<EnvironmentPlanEnforcement> {
    if (this.billing.mode === "disabled") {
      return {
        pauseEnvironmentIds: [],
        reconcileMemoryEnvironmentIds: [],
      };
    }
    const entitlementByUser = new Map<
      string,
      Promise<ResolvedEntitlement>
    >();
    const usageByUser = new Map<string, Promise<UsageTotals>>();
    const actions = await Promise.all(
      (await this.store.runningEnvironmentCandidates()).map(
        async (candidate) => {
          let entitlement = entitlementByUser.get(candidate.userId);
          if (!entitlement) {
            entitlement = this.resolveEntitlement(candidate.userId);
            entitlementByUser.set(candidate.userId, entitlement);
          }
          const resolved = await entitlement;
          const reconcileMemory =
            resolved.plan.fixedSandboxMemoryMiB != null &&
            candidate.sandboxMemoryMiB !==
              resolved.plan.fixedSandboxMemoryMiB;
          const running =
            (await this.runtime.getEnvironmentSandboxState(
              candidate.sandboxId,
            )) === "running";
          if (!running) {
            return { candidate, pause: false, reconcileMemory };
          }

          let usage = usageByUser.get(candidate.userId);
          if (!usage) {
            usage = this.store.usageTotals(
              candidate.userId,
              resolved.period.startsAt,
              resolved.period.endsAt,
            );
            usageByUser.set(candidate.userId, usage);
          }
          const totals = await usage;
          const environmentViolation =
            resolved.plan.environmentLimit != null &&
            candidate.position > resolved.plan.environmentLimit;
          const runtimeViolation =
            resolved.plan.runtimeQuotaMiBMilliseconds != null &&
            Math.max(
              totals.confirmedMiBMilliseconds,
              totals.projectedMiBMilliseconds,
            ) >= resolved.plan.runtimeQuotaMiBMilliseconds;
          return {
            candidate,
            pause: environmentViolation || runtimeViolation,
            reconcileMemory,
          };
        },
      ),
    );
    return {
      pauseEnvironmentIds: actions
        .filter((action) => action.pause)
        .map((action) => action.candidate.environmentId),
      reconcileMemoryEnvironmentIds: actions
        .filter((action) => action.reconcileMemory)
        .map((action) => action.candidate.environmentId),
    };
  }

  private async resolveEntitlement(
    userId: string,
  ): Promise<ResolvedEntitlement> {
    const account = await this.store.account(userId);
    if (!account) {
      throw notFound("user_not_found", "User not found.");
    }
    const now = this.now();
    if (this.billing.mode === "disabled") {
      return {
        account,
        plan: PLAN_DEFINITIONS.deployment,
        period: accountMonthPeriod(account.createdAt, now),
      };
    }

    const subscription = await this.store.subscription(userId);
    if (
      subscription &&
      subscriptionHasPaidEntitlement({
        status: subscription.status,
        graceEndsAt: subscription.graceEndsAt,
        now,
      })
    ) {
      const anchor =
        subscription.quotaAnchorAt ??
        subscription.currentPeriodStartsAt ??
        account.createdAt;
      return {
        account,
        subscription,
        plan:
          PLAN_DEFINITIONS[
            subscription.pendingPlanId &&
            subscription.pendingEffectiveAt &&
            subscription.pendingEffectiveAt.getTime() <= now.getTime()
              ? subscription.pendingPlanId
              : subscription.planId
          ],
        period: fixedWeekPeriod(anchor, now),
      };
    }
    return {
      account,
      subscription,
      plan: PLAN_DEFINITIONS.free,
      period: accountMonthPeriod(account.createdAt, now),
    };
  }
}

function publicPlan(plan: PlanDefinition): SandpiAccountPlan {
  return {
    id: plan.id,
    name: plan.name,
    annualPriceUsd: plan.annualPriceUsd,
    environmentLimit: plan.environmentLimit,
    memoryConfigurable: plan.fixedSandboxMemoryMiB == null,
    runtimeQuotaGiBHours: plan.runtimeQuotaGiBHours,
    quotaPeriod: plan.quotaPeriod,
  };
}

function runtimeQuotaError(plan: PlanDefinition, resetAt: Date) {
  return new HttpError(
    429,
    "sandbox_runtime_quota_exhausted",
    "The Sandbox runtime allowance is exhausted for this quota period.",
    {
      planId: plan.id,
      resetAt: toUnixTimestamp(resetAt),
      limitMiBMilliseconds: plan.runtimeQuotaMiBMilliseconds,
    },
  );
}

function environmentPlanLimitError(
  plan: PlanDefinition,
  resetAt: Date,
) {
  return new HttpError(
    429,
    "environment_plan_limit",
    "This Environment is outside the current plan limit.",
    {
      planId: plan.id,
      environmentLimit: plan.environmentLimit,
      resetAt: toUnixTimestamp(resetAt),
    },
  );
}
