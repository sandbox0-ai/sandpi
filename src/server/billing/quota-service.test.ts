import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";
import type { EnvironmentSandboxUsageProjection } from "@/server/runtime/types";

import { MIB_MILLISECONDS_PER_GIB_HOUR } from "./plans";
import {
  type BillingQuotaStore,
  BillingQuotaService,
} from "./quota-service";
import type {
  BillingAccountRecord,
  RunningEnvironmentCandidate,
  SubscriptionRecord,
  UsageTotals,
} from "./repository";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const account: BillingAccountRecord = {
  userId: "user-one",
  email: "user@example.com",
  name: "User",
  createdAt: new Date("2026-01-31T08:30:00.000Z"),
};

class FakeQuotaStore implements BillingQuotaStore {
  subscriptionRecord?: SubscriptionRecord;
  usage: UsageTotals = {
    confirmedMiBMilliseconds: 0,
  };
  count = 1;
  position = 1;
  candidates: RunningEnvironmentCandidate[] = [];
  customerId?: string;

  async account(userId: string) {
    return userId === account.userId ? account : undefined;
  }

  async subscription() {
    return this.subscriptionRecord;
  }

  async stripeCustomerId() {
    return this.customerId;
  }

  async environmentCount() {
    return this.count;
  }

  async environmentEntitlementPosition(environmentId: string) {
    return environmentId === "environment-one"
      ? {
          userId: account.userId,
          position: this.position,
          environmentCount: this.count,
        }
      : undefined;
  }

  async usageTotals() {
    return this.usage;
  }

  async runningEnvironmentCandidates(userId?: string) {
    return userId
      ? this.candidates.filter((candidate) => candidate.userId === userId)
      : this.candidates;
  }
}

class FakeLifecycleReader {
  readonly projections = new Map<
    string,
    EnvironmentSandboxUsageProjection
  >();

  async getEnvironmentSandboxUsageProjection(sandboxId: string) {
    return (
      this.projections.get(sandboxId) ?? {
        state: "running" as const,
        activeSince: NOW,
      }
    );
  }
}

function quotaService(
  store: BillingQuotaStore,
  billing: typeof disabledBilling | typeof stripeBilling,
  runtime = new FakeLifecycleReader(),
) {
  return new BillingQuotaService(store, billing, runtime, () => NOW, 0);
}

const disabledBilling = { mode: "disabled" } as const;
const stripeBilling = {
  mode: "stripe",
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  plusPriceId: "price_plus",
  proPriceId: "price_pro",
  ultraPriceId: "price_ultra",
  usagePollIntervalMs: 15_000,
} as const;

test("self-hosted deployments remain unlimited without Stripe", async () => {
  const store = new FakeQuotaStore();
  store.count = 12;
  store.usage = {
    confirmedMiBMilliseconds: 30,
  };
  const service = quotaService(store, disabledBilling);

  const summary = await service.summary(account.userId);

  assert.equal(summary.billingEnabled, false);
  assert.equal(summary.plan.id, "deployment");
  assert.equal(summary.plan.environmentLimit, null);
  assert.deepEqual(
    summary.availablePlans.map((plan) => plan.id),
    ["deployment"],
  );
  assert.equal(summary.plan.memoryConfigurable, true);
  assert.equal(summary.usage.usedMiBMilliseconds, 30);
  assert.equal(summary.usage.limitMiBMilliseconds, null);
  assert.equal(summary.usageSource, "billing-disabled");
  assert.equal(summary.overEnvironmentLimit, false);
  await service.assertMemoryConfigurationAllowed(account.userId, 2048, 4096);
  await service.assertEnvironmentRuntimeAllowed("environment-one");
});

test("free entitlement adds the live Sandbox0 allocation to closed usage", async () => {
  const store = new FakeQuotaStore();
  store.customerId = "cus_one";
  store.usage = {
    confirmedMiBMilliseconds: 6 * MIB_MILLISECONDS_PER_GIB_HOUR,
  };
  store.candidates = [
    {
      environmentId: "environment-one",
      sandboxId: "sandbox-one",
      userId: account.userId,
      position: 1,
      environmentCount: 1,
      sandboxMemoryMiB: 2 * 1024,
    },
  ];
  const runtime = new FakeLifecycleReader();
  runtime.projections.set("sandbox-one", {
    state: "running",
    activeSince: new Date(NOW.getTime() - 60 * 60 * 1_000),
  });
  const service = quotaService(store, stripeBilling, runtime);

  const summary = await service.summary(account.userId);

  assert.equal(summary.plan.id, "free");
  assert.equal(summary.plan.environmentLimit, 1);
  assert.deepEqual(
    summary.availablePlans.map((plan) => plan.id),
    ["free", "plus", "pro", "ultra"],
  );
  assert.deepEqual(
    summary.availablePlans.map((plan) => plan.annualPriceUsd),
    [0, 99, 199, 499],
  );
  assert.equal(summary.plan.runtimeQuotaGiBHours, 8);
  assert.equal(summary.usage.usedGiBHours, 8);
  assert.equal(
    summary.usage.projectedMiBMilliseconds,
    8 * MIB_MILLISECONDS_PER_GIB_HOUR,
  );
  assert.equal(summary.usage.exhausted, true);
  assert.equal(
    summary.usage.periodStartsAt,
    Date.parse("2026-06-30T08:30:00.000Z") / 1_000,
  );
  assert.equal(
    summary.usage.periodEndsAt,
    Date.parse("2026-07-31T08:30:00.000Z") / 1_000,
  );
  assert.equal(summary.customerPortalAvailable, true);
  assert.equal(summary.usageSource, "sandbox0-sdk");
  assert.deepEqual(await service.environmentCreationPolicy(account.userId), {
    environmentLimit: 1,
    fixedSandboxMemoryMiB: 2 * 1024,
  });
});

test("live projection starts after the latest imported Sandbox0 window", async () => {
  const store = new FakeQuotaStore();
  store.usage = {
    confirmedMiBMilliseconds: MIB_MILLISECONDS_PER_GIB_HOUR,
  };
  store.candidates = [
    {
      environmentId: "environment-one",
      sandboxId: "sandbox-one",
      userId: account.userId,
      position: 1,
      environmentCount: 1,
      sandboxMemoryMiB: 2 * 1024,
      lastUsageWindowEndsAt: new Date(NOW.getTime() - 30 * 60 * 1_000),
    },
  ];
  const runtime = new FakeLifecycleReader();
  runtime.projections.set("sandbox-one", {
    state: "running",
    activeSince: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000),
  });

  const summary = await quotaService(
    store,
    stripeBilling,
    runtime,
  ).summary(account.userId);

  assert.equal(
    summary.usage.confirmedMiBMilliseconds,
    MIB_MILLISECONDS_PER_GIB_HOUR,
  );
  assert.equal(summary.usage.usedGiBHours, 2);
});

test("active Sandbox projection without claimed_at fails quota admission closed", async () => {
  const store = new FakeQuotaStore();
  store.candidates = [
    {
      environmentId: "environment-one",
      sandboxId: "sandbox-one",
      userId: account.userId,
      position: 1,
      environmentCount: 1,
      sandboxMemoryMiB: 2 * 1024,
    },
  ];
  const runtime = new FakeLifecycleReader();
  runtime.projections.set("sandbox-one", { state: "running" });

  await assert.rejects(
    quotaService(store, stripeBilling, runtime).assertEnvironmentRuntimeAllowed(
      "environment-one",
    ),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 502 &&
      error.code === "sandbox0_usage_projection_invalid",
  );
});

test("active paid entitlement has a fixed weekly quota period", async () => {
  const store = new FakeQuotaStore();
  store.subscriptionRecord = {
    userId: account.userId,
    stripeSubscriptionId: "sub_one",
    stripePriceId: "price_plus",
    planId: "plus",
    status: "active",
    cancelAtPeriodEnd: false,
    quotaAnchorAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  const service = quotaService(store, stripeBilling);

  const summary = await service.summary(account.userId);

  assert.equal(summary.plan.id, "plus");
  assert.equal(summary.plan.runtimeQuotaGiBHours, 250);
  assert.equal(
    summary.usage.periodStartsAt,
    Date.parse("2026-07-22T00:00:00.000Z") / 1_000,
  );
  assert.equal(
    summary.usage.periodEndsAt,
    Date.parse("2026-07-29T00:00:00.000Z") / 1_000,
  );
});

test("Ultra entitlement exposes its weekly runtime and Environment limits", async () => {
  const store = new FakeQuotaStore();
  store.subscriptionRecord = {
    userId: account.userId,
    stripeSubscriptionId: "sub_ultra",
    stripePriceId: "price_ultra",
    planId: "ultra",
    status: "active",
    cancelAtPeriodEnd: false,
    quotaAnchorAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  const service = quotaService(store, stripeBilling);

  const summary = await service.summary(account.userId);

  assert.equal(summary.plan.id, "ultra");
  assert.equal(summary.plan.runtimeQuotaGiBHours, 1_250);
  assert.equal(summary.plan.environmentLimit, 25);
});

test("an effective pending downgrade changes entitlement without waiting for a webhook", async () => {
  const store = new FakeQuotaStore();
  store.subscriptionRecord = {
    userId: account.userId,
    stripeSubscriptionId: "sub_one",
    stripePriceId: "price_pro",
    planId: "pro",
    status: "active",
    cancelAtPeriodEnd: false,
    quotaAnchorAt: new Date("2026-07-01T00:00:00.000Z"),
    pendingPlanId: "plus",
    pendingPriceId: "price_plus",
    pendingEffectiveAt: new Date("2026-07-26T00:00:00.000Z"),
  };
  const service = quotaService(store, stripeBilling);

  assert.equal((await service.summary(account.userId)).plan.id, "plus");
});

test("exposes a future downgrade without applying it early", async () => {
  const store = new FakeQuotaStore();
  store.subscriptionRecord = {
    userId: account.userId,
    stripeSubscriptionId: "sub_one",
    stripePriceId: "price_pro",
    planId: "pro",
    status: "active",
    cancelAtPeriodEnd: false,
    quotaAnchorAt: new Date("2026-07-01T00:00:00.000Z"),
    pendingPlanId: "plus",
    pendingPriceId: "price_plus",
    pendingEffectiveAt: new Date("2026-08-01T00:00:00.000Z"),
  };
  const service = quotaService(store, stripeBilling);

  const summary = await service.summary(account.userId);

  assert.equal(summary.plan.id, "pro");
  assert.equal(summary.subscription?.pendingPlanId, "plus");
  assert.equal(
    summary.subscription?.pendingEffectiveAt,
    Date.parse("2026-08-01T00:00:00.000Z") / 1_000,
  );
});

test("free users cannot resize memory or run outside plan limits", async () => {
  const store = new FakeQuotaStore();
  const service = quotaService(store, stripeBilling);

  await assert.rejects(
    service.assertMemoryConfigurationAllowed(account.userId, 2048, 4096),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 403 &&
      error.code === "sandbox_memory_plan_restricted",
  );

  store.position = 2;
  await assert.rejects(
    service.assertEnvironmentRuntimeAllowed("environment-one"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 429 &&
      error.code === "environment_plan_limit",
  );

  store.position = 1;
  store.usage.confirmedMiBMilliseconds =
    8 * MIB_MILLISECONDS_PER_GIB_HOUR;
  await assert.rejects(
    service.assertEnvironmentRuntimeAllowed("environment-one"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 429 &&
      error.code === "sandbox_runtime_quota_exhausted" &&
      (error.details as { usedGiBHours?: number }).usedGiBHours === 8,
  );
});

test("background enforcement reconciles fixed memory and pauses only running violations", async () => {
  const store = new FakeQuotaStore();
  store.candidates = [
    {
      environmentId: "environment-one",
      sandboxId: "sandbox-one",
      userId: account.userId,
      position: 1,
      environmentCount: 2,
      sandboxMemoryMiB: 1024,
    },
    {
      environmentId: "environment-two",
      sandboxId: "sandbox-two",
      userId: account.userId,
      position: 2,
      environmentCount: 2,
      sandboxMemoryMiB: 2 * 1024,
    },
  ];
  const runtime = new FakeLifecycleReader();
  runtime.projections.set("sandbox-two", { state: "paused" });
  const service = quotaService(store, stripeBilling, runtime);

  assert.deepEqual(await service.environmentPlanEnforcement(), {
    pauseEnvironmentIds: [],
    reconcileMemoryEnvironmentIds: ["environment-one"],
  });

  runtime.projections.set("sandbox-two", {
    state: "running",
    activeSince: NOW,
  });

  assert.deepEqual(await service.environmentPlanEnforcement(), {
    pauseEnvironmentIds: ["environment-two"],
    reconcileMemoryEnvironmentIds: ["environment-one"],
  });
});

test("background enforcement pauses live runtime as soon as open usage reaches quota", async () => {
  const store = new FakeQuotaStore();
  store.usage.confirmedMiBMilliseconds =
    7 * MIB_MILLISECONDS_PER_GIB_HOUR;
  store.candidates = [
    {
      environmentId: "environment-one",
      sandboxId: "sandbox-one",
      userId: account.userId,
      position: 1,
      environmentCount: 1,
      sandboxMemoryMiB: 2 * 1024,
    },
  ];
  const runtime = new FakeLifecycleReader();
  runtime.projections.set("sandbox-one", {
    state: "running",
    activeSince: new Date(NOW.getTime() - 30 * 60 * 1_000),
  });

  assert.deepEqual(
    await quotaService(
      store,
      stripeBilling,
      runtime,
    ).environmentPlanEnforcement(),
    {
      pauseEnvironmentIds: ["environment-one"],
      reconcileMemoryEnvironmentIds: [],
    },
  );
});

test("background enforcement pauses active runtime when its allocation start is invalid", async () => {
  const store = new FakeQuotaStore();
  store.candidates = [
    {
      environmentId: "environment-one",
      sandboxId: "sandbox-one",
      userId: account.userId,
      position: 1,
      environmentCount: 1,
      sandboxMemoryMiB: 2 * 1024,
    },
  ];
  const runtime = new FakeLifecycleReader();
  runtime.projections.set("sandbox-one", { state: "running" });

  assert.deepEqual(
    await quotaService(
      store,
      stripeBilling,
      runtime,
    ).environmentPlanEnforcement(),
    {
      pauseEnvironmentIds: ["environment-one"],
      reconcileMemoryEnvironmentIds: [],
    },
  );
});
