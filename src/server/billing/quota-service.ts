import type {
  SandpiAccountPlan,
  SandpiBillingSummary,
} from "@/lib/billing";
import { toUnixTimestamp } from "@/lib/time";
import type { SandpiConfig } from "@/server/config";
import { HttpError, notFound } from "@/server/http-error";
import type { EnvironmentSandboxUsageProjection } from "@/server/runtime/types";

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
  runningEnvironmentCandidates(
    userId?: string,
  ): Promise<RunningEnvironmentCandidate[]>;
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
  getEnvironmentSandboxUsageProjection(
    sandboxId: string,
  ): Promise<EnvironmentSandboxUsageProjection>;
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

interface LiveRuntimeObservation {
  candidate: RunningEnvironmentCandidate;
  projection: EnvironmentSandboxUsageProjection;
}

interface ProjectedUsageTotals extends UsageTotals {
  projectedMiBMilliseconds: number;
}

const LIVE_USAGE_OBSERVATION_CACHE_TTL_MS = 5_000;

export class BillingQuotaService
  implements EnvironmentQuotaPolicy, RuntimeQuotaGate
{
  private readonly liveObservationCache = new Map<
    string,
    {
      expiresAt: number;
      value: Promise<LiveRuntimeObservation[]>;
    }
  >();

  constructor(
    private readonly store: BillingQuotaStore,
    private readonly billing: SandpiConfig["billing"],
    private readonly runtime: SandboxLifecycleReader,
    private readonly now: () => Date = () => new Date(),
    private readonly liveObservationCacheTtlMs =
      LIVE_USAGE_OBSERVATION_CACHE_TTL_MS,
  ) {}

  async summary(userId: string): Promise<SandpiBillingSummary> {
    const entitlement = await this.resolveEntitlement(userId);
    const [usage, environmentCount, customerId] = await Promise.all([
      this.billing.mode === "stripe"
        ? this.projectedUsage(userId, entitlement.period)
        : this.confirmedUsage(userId, entitlement.period),
      this.store.environmentCount(userId),
      this.store.stripeCustomerId(userId),
    ]);
    const limit = entitlement.plan.runtimeQuotaMiBMilliseconds;
    const used = usage.projectedMiBMilliseconds;
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
          : "billing-disabled",
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
    const usage = await this.projectedUsage(
      position.userId,
      entitlement.period,
    );
    if (
      entitlement.plan.runtimeQuotaMiBMilliseconds != null &&
      usage.projectedMiBMilliseconds >=
        entitlement.plan.runtimeQuotaMiBMilliseconds
    ) {
      throw runtimeQuotaError(
        entitlement.plan,
        entitlement.period.endsAt,
        usage.projectedMiBMilliseconds,
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
    const observations = await Promise.all(
      (await this.store.runningEnvironmentCandidates()).map((candidate) =>
        this.observeRuntime(candidate),
      ),
    );
    const observationsByUser = new Map<string, LiveRuntimeObservation[]>();
    for (const observation of observations) {
      const current = observationsByUser.get(observation.candidate.userId);
      if (current) current.push(observation);
      else observationsByUser.set(observation.candidate.userId, [observation]);
    }
    const actionGroups = await Promise.all(
      [...observationsByUser.entries()].map(
        async ([userId, userObservations]) => {
          const resolved = await this.resolveEntitlement(userId);
          const invalidActiveProjection = userObservations.some(
            ({ projection }) =>
              activeRuntimeState(projection.state) &&
              !validActiveSince(projection.activeSince),
          );
          const totals = invalidActiveProjection
            ? undefined
            : await this.projectedUsage(
                userId,
                resolved.period,
                userObservations,
              );
          return userObservations.map(({ candidate, projection }) => {
            const reconcileMemory =
              resolved.plan.fixedSandboxMemoryMiB != null &&
              candidate.sandboxMemoryMiB !==
                resolved.plan.fixedSandboxMemoryMiB;
            const active = activeRuntimeState(projection.state);
            const environmentViolation =
              resolved.plan.environmentLimit != null &&
              candidate.position > resolved.plan.environmentLimit;
            const runtimeViolation =
              invalidActiveProjection ||
              (resolved.plan.runtimeQuotaMiBMilliseconds != null &&
                (totals?.projectedMiBMilliseconds ?? 0) >=
                  resolved.plan.runtimeQuotaMiBMilliseconds);
            return {
              candidate,
              pause:
                active && (environmentViolation || runtimeViolation),
              reconcileMemory,
            };
          });
        },
      ),
    );
    const actions = actionGroups.flat();
    return {
      pauseEnvironmentIds: actions
        .filter((action) => action.pause)
        .map((action) => action.candidate.environmentId),
      reconcileMemoryEnvironmentIds: actions
        .filter((action) => action.reconcileMemory)
        .map((action) => action.candidate.environmentId),
    };
  }

  private async confirmedUsage(
    userId: string,
    period: { startsAt: Date; endsAt: Date },
  ): Promise<ProjectedUsageTotals> {
    const usage = await this.store.usageTotals(
      userId,
      period.startsAt,
      period.endsAt,
    );
    return {
      ...usage,
      projectedMiBMilliseconds: usage.confirmedMiBMilliseconds,
    };
  }

  private async projectedUsage(
    userId: string,
    period: { startsAt: Date; endsAt: Date },
    observations?: LiveRuntimeObservation[],
  ): Promise<ProjectedUsageTotals> {
    const [usage, live] = await Promise.all([
      this.store.usageTotals(userId, period.startsAt, period.endsAt),
      observations ?? this.liveObservationsForUser(userId),
    ]);
    const observedAt = this.now();
    const openMiBMilliseconds = live.reduce(
      (total, observation) =>
        total + liveRuntimeUsage(observation, period, observedAt),
      0,
    );
    return {
      ...usage,
      projectedMiBMilliseconds:
        usage.confirmedMiBMilliseconds + Math.floor(openMiBMilliseconds),
    };
  }

  private async liveObservationsForUser(userId: string) {
    const cached = this.liveObservationCache.get(userId);
    const cacheNow = Date.now();
    if (cached && cached.expiresAt > cacheNow) return cached.value;

    const value = this.store
      .runningEnvironmentCandidates(userId)
      .then((candidates) =>
        Promise.all(
          candidates.map((candidate) => this.observeRuntime(candidate)),
        ),
      );
    if (this.liveObservationCacheTtlMs > 0) {
      const entry = {
        expiresAt: cacheNow + this.liveObservationCacheTtlMs,
        value,
      };
      this.liveObservationCache.set(userId, entry);
      void value.catch(() => {
        if (this.liveObservationCache.get(userId) === entry) {
          this.liveObservationCache.delete(userId);
        }
      });
    }
    return value;
  }

  private async observeRuntime(
    candidate: RunningEnvironmentCandidate,
  ): Promise<LiveRuntimeObservation> {
    return {
      candidate,
      projection:
        await this.runtime.getEnvironmentSandboxUsageProjection(
          candidate.sandboxId,
        ),
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

function runtimeQuotaError(
  plan: PlanDefinition,
  resetAt: Date,
  usedMiBMilliseconds: number,
) {
  return new HttpError(
    429,
    "sandbox_runtime_quota_exhausted",
    "The Sandbox runtime allowance is exhausted for this quota period.",
    {
      planId: plan.id,
      resetAt: toUnixTimestamp(resetAt),
      limitMiBMilliseconds: plan.runtimeQuotaMiBMilliseconds,
      usedMiBMilliseconds,
      usedGiBHours: usedMiBMilliseconds / MIB_MILLISECONDS_PER_GIB_HOUR,
      limitGiBHours: plan.runtimeQuotaGiBHours,
    },
  );
}

function activeRuntimeState(state: EnvironmentSandboxUsageProjection["state"]) {
  return state === "running" || state === "provisioning";
}

function validActiveSince(value: Date | undefined): value is Date {
  return Boolean(value && Number.isFinite(value.getTime()));
}

function liveRuntimeUsage(
  observation: LiveRuntimeObservation,
  period: { startsAt: Date; endsAt: Date },
  observedAt: Date,
) {
  if (!activeRuntimeState(observation.projection.state)) return 0;
  const activeSince = observation.projection.activeSince;
  if (!validActiveSince(activeSince)) {
    throw new HttpError(
      502,
      "sandbox0_usage_projection_invalid",
      "Sandbox0 returned an active Sandbox without a valid claimed_at timestamp.",
      { sandboxId: observation.candidate.sandboxId },
    );
  }
  const latestClosedAt = observation.candidate.lastUsageWindowEndsAt;
  const startsAt = Math.max(
    period.startsAt.getTime(),
    activeSince.getTime(),
    latestClosedAt && Number.isFinite(latestClosedAt.getTime())
      ? latestClosedAt.getTime()
      : Number.NEGATIVE_INFINITY,
  );
  const endsAt = Math.min(observedAt.getTime(), period.endsAt.getTime());
  return (
    Math.max(0, endsAt - startsAt) *
    Math.max(0, observation.candidate.sandboxMemoryMiB)
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
