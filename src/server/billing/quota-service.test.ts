import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/server/http-error";

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
    projectedMiBMilliseconds: 0,
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

  async runningEnvironmentCandidates() {
    return this.candidates;
  }
}

const disabledBilling = { mode: "disabled" } as const;
const stripeBilling = {
  mode: "stripe",
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  plusPriceId: "price_plus",
  proPriceId: "price_pro",
  usagePollIntervalMs: 15_000,
} as const;

test("self-hosted deployments remain unlimited without Stripe", async () => {
  const store = new FakeQuotaStore();
  store.count = 12;
  store.usage = {
    confirmedMiBMilliseconds: 30,
    projectedMiBMilliseconds: 50,
  };
  const service = new BillingQuotaService(store, disabledBilling, () => NOW);

  const summary = await service.summary(account.userId);

  assert.equal(summary.billingEnabled, false);
  assert.equal(summary.plan.id, "deployment");
  assert.equal(summary.plan.environmentLimit, null);
  assert.deepEqual(
    summary.availablePlans.map((plan) => plan.id),
    ["deployment"],
  );
  assert.equal(summary.plan.memoryConfigurable, true);
  assert.equal(summary.usage.usedMiBMilliseconds, 50);
  assert.equal(summary.usage.limitMiBMilliseconds, null);
  assert.equal(summary.usageSource, "local-projection");
  assert.equal(summary.overEnvironmentLimit, false);
  await service.assertMemoryConfigurationAllowed(account.userId, 2048, 4096);
  await service.assertEnvironmentRuntimeAllowed("environment-one");
});

test("free entitlement uses the larger confirmed or projected usage value", async () => {
  const store = new FakeQuotaStore();
  store.customerId = "cus_one";
  store.usage = {
    confirmedMiBMilliseconds: MIB_MILLISECONDS_PER_GIB_HOUR / 2,
    projectedMiBMilliseconds: MIB_MILLISECONDS_PER_GIB_HOUR,
  };
  const service = new BillingQuotaService(store, stripeBilling, () => NOW);

  const summary = await service.summary(account.userId);

  assert.equal(summary.plan.id, "free");
  assert.equal(summary.plan.environmentLimit, 1);
  assert.deepEqual(
    summary.availablePlans.map((plan) => plan.id),
    ["free", "plus", "pro"],
  );
  assert.equal(summary.usage.usedGiBHours, 1);
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
  const service = new BillingQuotaService(store, stripeBilling, () => NOW);

  const summary = await service.summary(account.userId);

  assert.equal(summary.plan.id, "plus");
  assert.equal(summary.plan.runtimeQuotaGiBHours, 168);
  assert.equal(
    summary.usage.periodStartsAt,
    Date.parse("2026-07-22T00:00:00.000Z") / 1_000,
  );
  assert.equal(
    summary.usage.periodEndsAt,
    Date.parse("2026-07-29T00:00:00.000Z") / 1_000,
  );
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
  const service = new BillingQuotaService(store, stripeBilling, () => NOW);

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
  const service = new BillingQuotaService(store, stripeBilling, () => NOW);

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
  const service = new BillingQuotaService(store, stripeBilling, () => NOW);

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
  store.usage.projectedMiBMilliseconds =
    MIB_MILLISECONDS_PER_GIB_HOUR;
  await assert.rejects(
    service.assertEnvironmentRuntimeAllowed("environment-one"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 429 &&
      error.code === "sandbox_runtime_quota_exhausted",
  );
});

test("background enforcement returns only running environments in violation", async () => {
  const store = new FakeQuotaStore();
  store.candidates = [
    {
      environmentId: "environment-one",
      sandboxId: "sandbox-one",
      userId: account.userId,
      position: 1,
      environmentCount: 2,
    },
    {
      environmentId: "environment-two",
      sandboxId: "sandbox-two",
      userId: account.userId,
      position: 2,
      environmentCount: 2,
    },
  ];
  const service = new BillingQuotaService(store, stripeBilling, () => NOW);

  assert.deepEqual(await service.runningEnvironmentViolations(), [
    "environment-two",
  ]);
});
