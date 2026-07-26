import assert from "node:assert/strict";
import test from "node:test";

import type Stripe from "stripe";

import { HttpError } from "@/server/http-error";

import type {
  BillingAccountRecord,
  BillingRepository,
  SubscriptionRecord,
  WebhookEventClaim,
} from "./repository";
import {
  isPaidPlanInput,
  StripeBillingService,
} from "./stripe-service";

const stripeConfig = {
  mode: "stripe",
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  plusPriceId: "price_plus",
  proPriceId: "price_pro",
  usagePollIntervalMs: 15_000,
} as const;
const logger = {
  info() {},
  warn() {},
};
const account: BillingAccountRecord = {
  userId: "user-one",
  email: "user@example.com",
  name: "User One",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

class FakeBillingRepository {
  subscriptionRecord?: SubscriptionRecord;
  customerId?: string;
  upserts: SubscriptionRecord[] = [];
  webhookEvents = new Set<string>();
  webhookClaim?: WebhookEventClaim;
  webhookPayloads: object[] = [];

  async account(userId: string) {
    return userId === account.userId ? account : undefined;
  }

  async stripeCustomerId() {
    return this.customerId;
  }

  async userIdForStripeCustomer(customerId: string) {
    return customerId === this.customerId ? account.userId : undefined;
  }

  async saveStripeCustomer(userId: string, customerId: string) {
    assert.equal(userId, account.userId);
    this.customerId = customerId;
  }

  async subscription() {
    return this.subscriptionRecord;
  }

  async upsertSubscription(input: SubscriptionRecord) {
    this.subscriptionRecord = input;
    this.upserts.push(input);
  }

  async recordWebhookEvent(input: { id: string; payload: object }) {
    this.webhookPayloads.push(input.payload);
    if (this.webhookClaim) return this.webhookClaim;
    if (this.webhookEvents.has(input.id)) {
      return { status: "processed" } as const;
    }
    this.webhookEvents.add(input.id);
    return { status: "claimed", attempt: 1 } as const;
  }

  async completeWebhookEvent() {}
  async failWebhookEvent() {}
}

function subscription(input: {
  id?: string;
  priceId: "price_plus" | "price_pro";
  startsAt: string;
  endsAt: string;
  status?: Stripe.Subscription.Status;
}) {
  return {
    id: input.id ?? "sub_one",
    customer: "cus_one",
    status: input.status ?? "active",
    metadata: { sandpi_user_id: account.userId },
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_one",
          price: { id: input.priceId },
          current_period_start: Date.parse(input.startsAt) / 1_000,
          current_period_end: Date.parse(input.endsAt) / 1_000,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function subscriptionEvent(
  id: string,
  value: Stripe.Subscription,
): Stripe.Event {
  return {
    id,
    type: "customer.subscription.updated",
    created: Date.parse("2026-07-26T00:00:00.000Z") / 1_000,
    livemode: false,
    data: { object: value },
  } as unknown as Stripe.Event;
}

test("validates paid plan input without accepting internal plan ids", () => {
  assert.equal(isPaidPlanInput("plus"), true);
  assert.equal(isPaidPlanInput("pro"), true);
  assert.equal(isPaidPlanInput("free"), false);
  assert.equal(isPaidPlanInput("deployment"), false);
});

test("creates Stripe Checkout with a server-side price id and user metadata", async () => {
  const repository = new FakeBillingRepository();
  let checkoutInput: Stripe.Checkout.SessionCreateParams | undefined;
  const stripe = {
    customers: {
      async create() {
        return { id: "cus_one" };
      },
    },
    checkout: {
      sessions: {
        async create(input: Stripe.Checkout.SessionCreateParams) {
          checkoutInput = input;
          return { url: "https://checkout.stripe.example/session" };
        },
      },
    },
  } as unknown as Stripe;
  const service = new StripeBillingService(
    repository as unknown as BillingRepository,
    stripeConfig,
    new URL("https://sandpi.example.com"),
    logger,
    stripe,
  );

  const result = await service.checkout(
    account.userId,
    "plus",
    "idempotency-key-one",
  );

  assert.deepEqual(result, {
    kind: "checkout",
    url: "https://checkout.stripe.example/session",
  });
  assert.equal(repository.customerId, "cus_one");
  assert.equal(checkoutInput?.line_items?.[0]?.price, "price_plus");
  assert.equal(checkoutInput?.metadata?.sandpi_user_id, account.userId);
  assert.match(checkoutInput?.success_url ?? "", /billing=success/);
});

test("upgrades immediately but preserves Pro entitlement through a scheduled downgrade", async () => {
  const repository = new FakeBillingRepository();
  repository.customerId = "cus_one";
  repository.subscriptionRecord = {
    userId: account.userId,
    stripeSubscriptionId: "sub_one",
    stripePriceId: "price_plus",
    planId: "plus",
    status: "active",
    cancelAtPeriodEnd: false,
    quotaAnchorAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  let current = subscription({
    priceId: "price_plus",
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-08-01T00:00:00.000Z",
  });
  const updates: Stripe.SubscriptionUpdateParams[] = [];
  const stripe = {
    subscriptions: {
      async retrieve() {
        return current;
      },
      async update(
        _id: string,
        input: Stripe.SubscriptionUpdateParams,
      ) {
        updates.push(input);
        current = subscription({
          priceId:
            input.items?.[0]?.price === "price_pro"
              ? "price_pro"
              : "price_plus",
          startsAt: "2026-07-01T00:00:00.000Z",
          endsAt: "2026-08-01T00:00:00.000Z",
        });
        return current;
      },
    },
  } as unknown as Stripe;
  const service = new StripeBillingService(
    repository as unknown as BillingRepository,
    stripeConfig,
    new URL("https://sandpi.example.com"),
    logger,
    stripe,
    () => new Date("2026-07-20T00:00:00.000Z"),
  );

  await service.checkout(account.userId, "pro", "upgrade-key-0001");

  assert.equal(updates[0]?.proration_behavior, "always_invoice");
  assert.equal(updates[0]?.payment_behavior, "pending_if_incomplete");
  assert.equal(repository.subscriptionRecord?.planId, "pro");

  await service.checkout(account.userId, "plus", "downgrade-key-01");

  assert.equal(updates[1]?.proration_behavior, "none");
  assert.equal(repository.subscriptionRecord?.planId, "pro");
  assert.equal(repository.subscriptionRecord?.pendingPlanId, "plus");
  assert.equal(
    repository.subscriptionRecord?.pendingEffectiveAt?.toISOString(),
    "2026-08-01T00:00:00.000Z",
  );
});

test("materializes a pending downgrade after its saved period boundary", async () => {
  const repository = new FakeBillingRepository();
  repository.customerId = "cus_one";
  repository.subscriptionRecord = {
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
  const latest = subscription({
    priceId: "price_plus",
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2026-09-01T00:00:00.000Z",
  });
  const stripe = {
    subscriptions: {
      async retrieve() {
        return latest;
      },
    },
  } as unknown as Stripe;
  const service = new StripeBillingService(
    repository as unknown as BillingRepository,
    stripeConfig,
    new URL("https://sandpi.example.com"),
    logger,
    stripe,
    () => new Date("2026-08-02T00:00:00.000Z"),
  );
  const event = subscriptionEvent("evt_one", latest);

  await service.processWebhook(event);
  await service.processWebhook(event);

  assert.equal(repository.upserts.length, 1);
  assert.deepEqual(repository.webhookPayloads[0], {
    objectId: "sub_one",
    created: Date.parse("2026-07-26T00:00:00.000Z") / 1_000,
    livemode: false,
  });
  assert.equal(
    JSON.stringify(repository.webhookPayloads[0]).includes(account.userId),
    false,
  );
  assert.equal(repository.subscriptionRecord?.planId, "plus");
  assert.equal(repository.subscriptionRecord?.stripePriceId, "price_plus");
  assert.equal(repository.subscriptionRecord?.pendingPlanId, undefined);
  assert.equal(repository.subscriptionRecord?.pendingEffectiveAt, undefined);
});

test("asks Stripe to retry an event that another worker still owns", async () => {
  const repository = new FakeBillingRepository();
  repository.webhookClaim = { status: "busy" };
  const stripe = {} as Stripe;
  const service = new StripeBillingService(
    repository as unknown as BillingRepository,
    stripeConfig,
    new URL("https://sandpi.example.com"),
    logger,
    stripe,
  );
  const event = subscriptionEvent(
    "evt_busy",
    subscription({
      priceId: "price_plus",
      startsAt: "2026-07-01T00:00:00.000Z",
      endsAt: "2026-08-01T00:00:00.000Z",
    }),
  );

  await assert.rejects(
    service.processWebhook(event),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 503 &&
      error.code === "stripe_webhook_processing",
  );
  assert.equal(repository.upserts.length, 0);
});

test("a delayed cancellation cannot replace a newer active subscription", async () => {
  const repository = new FakeBillingRepository();
  repository.customerId = "cus_one";
  repository.subscriptionRecord = {
    userId: account.userId,
    stripeSubscriptionId: "sub_current",
    stripePriceId: "price_pro",
    planId: "pro",
    status: "active",
    cancelAtPeriodEnd: false,
    quotaAnchorAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  const current = subscription({
    id: "sub_current",
    priceId: "price_pro",
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-08-01T00:00:00.000Z",
  });
  const canceled = subscription({
    id: "sub_old",
    priceId: "price_plus",
    startsAt: "2026-06-01T00:00:00.000Z",
    endsAt: "2026-07-01T00:00:00.000Z",
    status: "canceled",
  });
  const stripe = {
    subscriptions: {
      async retrieve(id: string) {
        assert.equal(id, "sub_current");
        return current;
      },
    },
  } as unknown as Stripe;
  const service = new StripeBillingService(
    repository as unknown as BillingRepository,
    stripeConfig,
    new URL("https://sandpi.example.com"),
    logger,
    stripe,
    () => new Date("2026-07-20T00:00:00.000Z"),
  );
  const event = {
    id: "evt_delayed",
    type: "customer.subscription.deleted",
    data: { object: canceled },
  } as unknown as Stripe.Event;

  await service.processWebhook(event);

  assert.equal(
    repository.subscriptionRecord?.stripeSubscriptionId,
    "sub_current",
  );
  assert.equal(repository.subscriptionRecord?.planId, "pro");
  assert.equal(repository.subscriptionRecord?.status, "active");
});
