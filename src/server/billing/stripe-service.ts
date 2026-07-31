import Stripe from "stripe";

import type {
  SandpiCheckoutResult,
  SandpiPaidPlanId,
  SandpiSubscriptionStatus,
} from "@/lib/billing";
import type { SandpiConfig } from "@/server/config";
import { HttpError, notFound } from "@/server/http-error";

import { isPaidPlanDowngrade, PAST_DUE_GRACE_MS } from "./plans";
import { type BillingRepository } from "./repository";

interface StripeServiceLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export class StripeBillingService {
  private readonly stripe?: Stripe;

  constructor(
    private readonly repository: BillingRepository,
    private readonly config: SandpiConfig["billing"],
    private readonly publicUrl: URL,
    private readonly logger: StripeServiceLogger,
    stripe?: Stripe,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.stripe =
      stripe ??
      (config.mode === "stripe"
        ? new Stripe(config.secretKey, {
            appInfo: {
              name: "Sandpi",
              version: "0.1.0",
              url: "https://sandpi.ai",
            },
          })
        : undefined);
  }

  constructWebhookEvent(rawBody: Buffer, signature: string) {
    const { stripe, config } = this.requireStripe();
    return stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.webhookSecret,
    );
  }

  async checkout(
    userId: string,
    planId: SandpiPaidPlanId,
    idempotencyKey: string,
  ): Promise<SandpiCheckoutResult> {
    const { stripe, config } = this.requireStripe();
    const account = await this.repository.account(userId);
    if (!account) throw notFound("user_not_found", "User not found.");
    const customerId = await this.ensureCustomer(
      account.userId,
      account.email,
      account.name,
    );
    const priceId = {
      plus: config.plusPriceId,
      pro: config.proPriceId,
      ultra: config.ultraPriceId,
    }[planId];
    const stored = await this.repository.subscription(userId);
    let current: Stripe.Subscription | undefined;
    if (
      stored &&
      subscriptionCanBeUpdated(stored.status) &&
      stored.stripeSubscriptionId.startsWith("sub_")
    ) {
      try {
        current = await stripe.subscriptions.retrieve(
          stored.stripeSubscriptionId,
        );
      } catch (error) {
        if (!stripeResourceMissing(error)) throw error;
        this.logger.warn(
          { userId, subscriptionId: stored.stripeSubscriptionId },
          "Starting Checkout because the projected Stripe subscription no longer exists",
        );
      }
    } else if (stored && subscriptionCanBeUpdated(stored.status)) {
      this.logger.info(
        { userId, entitlementId: stored.stripeSubscriptionId },
        "Starting Checkout from a non-Stripe entitlement",
      );
    }
    if (stored && current) {
      if (subscriptionCanBeUpdated(current.status)) {
        const item = current.items.data[0];
        if (!item) {
          throw new HttpError(
            502,
            "stripe_subscription_invalid",
            "The Stripe subscription has no plan item.",
          );
        }
        const currentPlan = this.planForPrice(item.price.id);
        const cancelPendingDowngrade =
          stored.planId === planId &&
          stored.pendingPlanId != null &&
          currentPlan !== planId;
        if (currentPlan !== planId) {
          const downgrade =
            currentPlan != null && isPaidPlanDowngrade(currentPlan, planId);
          const updated = await stripe.subscriptions.update(
            current.id,
            {
              items: [{ id: item.id, price: priceId }],
              proration_behavior:
                downgrade || cancelPendingDowngrade
                  ? "none"
                  : "always_invoice",
              payment_behavior: downgrade || cancelPendingDowngrade
                ? "allow_incomplete"
                : "pending_if_incomplete",
              metadata: {
                ...current.metadata,
                sandpi_user_id: userId,
                sandpi_plan_id: planId,
              },
            },
            { idempotencyKey: `subscription:${idempotencyKey}` },
          );
          await this.syncSubscription(updated, userId);
        } else {
          await this.syncSubscription(current, userId);
        }
        return { kind: "subscription-updated" };
      }
    }

    const successUrl = new URL("/preferences/", this.publicUrl);
    successUrl.searchParams.set("billing", "success");
    const cancelUrl = new URL("/preferences/", this.publicUrl);
    cancelUrl.searchParams.set("billing", "canceled");
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        client_reference_id: userId,
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: true,
        billing_address_collection: "auto",
        success_url: successUrl.toString(),
        cancel_url: cancelUrl.toString(),
        metadata: {
          sandpi_user_id: userId,
          sandpi_plan_id: planId,
        },
        subscription_data: {
          metadata: {
            sandpi_user_id: userId,
            sandpi_plan_id: planId,
          },
        },
      },
      { idempotencyKey: `checkout:${idempotencyKey}` },
    );
    if (!session.url) {
      throw new HttpError(
        502,
        "stripe_checkout_unavailable",
        "Stripe did not return a Checkout URL.",
      );
    }
    return { kind: "checkout", url: session.url };
  }

  async customerPortal(userId: string) {
    const { stripe } = this.requireStripe();
    const customerId = await this.repository.stripeCustomerId(userId);
    if (!customerId) {
      throw new HttpError(
        409,
        "stripe_customer_missing",
        "Start a subscription before opening the billing portal.",
      );
    }
    const returnUrl = new URL("/preferences/", this.publicUrl);
    returnUrl.searchParams.set("billing", "portal-return");
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl.toString(),
    });
    return { url: session.url };
  }

  async processWebhook(event: Stripe.Event) {
    const claim = await this.repository.recordWebhookEvent({
      id: event.id,
      type: event.type,
      payload: webhookReceipt(event),
    });
    if (claim.status === "processed") return;
    if (claim.status === "busy") {
      throw new HttpError(
        503,
        "stripe_webhook_processing",
        "This Stripe event is already being processed; retry later.",
      );
    }
    try {
      await this.applyWebhook(event);
      await this.repository.completeWebhookEvent(event.id, claim.attempt);
    } catch (error) {
      await this.repository.failWebhookEvent(
        event.id,
        claim.attempt,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async applyWebhook(event: Stripe.Event) {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId =
        session.metadata?.sandpi_user_id ?? session.client_reference_id;
      const customerId = stripeId(session.customer);
      if (userId && customerId) {
        await this.repository.saveStripeCustomer(userId, customerId);
      }
      const subscriptionId = stripeId(session.subscription);
      if (subscriptionId) {
        const { stripe } = this.requireStripe();
        await this.syncSubscription(
          await stripe.subscriptions.retrieve(subscriptionId),
          userId ?? undefined,
        );
      }
      return;
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.paused" ||
      event.type === "customer.subscription.resumed"
    ) {
      const received = event.data.object as Stripe.Subscription;
      const { stripe } = this.requireStripe();
      const latest =
        received.status === "canceled"
          ? received
          : await stripe.subscriptions.retrieve(received.id);
      await this.syncSubscription(
        await this.preferCurrentSubscription(latest),
      );
    }
  }

  private async preferCurrentSubscription(
    received: Stripe.Subscription,
  ) {
    const customerId = stripeId(received.customer);
    const userId =
      received.metadata.sandpi_user_id ??
      (customerId
        ? await this.repository.userIdForStripeCustomer(customerId)
        : undefined);
    if (!userId) return received;
    const existing = await this.repository.subscription(userId);
    if (
      !existing ||
      existing.stripeSubscriptionId === received.id ||
      subscriptionStatusPriority(existing.status) <
        subscriptionStatusPriority(received.status)
    ) {
      return received;
    }
    const { stripe } = this.requireStripe();
    try {
      const current = await stripe.subscriptions.retrieve(
        existing.stripeSubscriptionId,
      );
      return subscriptionStatusPriority(current.status) >=
        subscriptionStatusPriority(received.status)
        ? current
        : received;
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          subscriptionId: existing.stripeSubscriptionId,
        },
        "Could not recheck the current Sandpi subscription",
      );
      return received;
    }
  }

  private async ensureCustomer(
    userId: string,
    email: string,
    name: string,
  ) {
    const existing = await this.repository.stripeCustomerId(userId);
    if (existing) return existing;
    const { stripe } = this.requireStripe();
    const customer = await stripe.customers.create(
      {
        email,
        name,
        metadata: { sandpi_user_id: userId },
      },
      { idempotencyKey: `sandpi-customer:${userId}` },
    );
    await this.repository.saveStripeCustomer(userId, customer.id);
    return customer.id;
  }

  private async syncSubscription(
    subscription: Stripe.Subscription,
    userHint?: string,
  ) {
    const item = subscription.items.data[0];
    if (!item) return;
    const actualPlan = this.planForPrice(item.price.id);
    if (!actualPlan) {
      this.logger.warn(
        {
          subscriptionId: subscription.id,
          priceId: item.price.id,
        },
        "Ignoring a Stripe subscription with an unknown Sandpi price",
      );
      return;
    }
    const customerId = stripeId(subscription.customer);
    const userId =
      userHint ??
      subscription.metadata.sandpi_user_id ??
      (customerId
        ? await this.repository.userIdForStripeCustomer(customerId)
        : undefined);
    if (!userId) {
      this.logger.warn(
        { subscriptionId: subscription.id },
        "Ignoring a Stripe subscription without a Sandpi user",
      );
      return;
    }
    if (customerId) {
      await this.repository.saveStripeCustomer(userId, customerId);
    }

    const now = this.now();
    const existing = await this.repository.subscription(userId);
    const currentPeriodStartsAt = fromUnixSeconds(
      item.current_period_start,
    );
    const currentPeriodEndsAt = fromUnixSeconds(item.current_period_end);
    let planId = actualPlan;
    let stripePriceId = item.price.id;
    let pendingPlanId: SandpiPaidPlanId | undefined;
    let pendingPriceId: string | undefined;
    let pendingEffectiveAt: Date | undefined;

    const effectiveExistingPlan =
      existing?.pendingPlanId &&
      existing.pendingEffectiveAt &&
      existing.pendingEffectiveAt.getTime() <= now.getTime()
        ? existing.pendingPlanId
        : existing?.planId;
    const effectiveExistingPrice =
      existing?.pendingPlanId &&
      existing.pendingPriceId &&
      existing.pendingEffectiveAt &&
      existing.pendingEffectiveAt.getTime() <= now.getTime()
        ? existing.pendingPriceId
        : existing?.stripePriceId;
    const pendingDowngrade =
      effectiveExistingPlan != null &&
      isPaidPlanDowngrade(effectiveExistingPlan, actualPlan) &&
      currentPeriodEndsAt.getTime() > now.getTime();
    if (pendingDowngrade) {
      planId = effectiveExistingPlan;
      stripePriceId = effectiveExistingPrice ?? existing!.stripePriceId;
      pendingPlanId = actualPlan;
      pendingPriceId = item.price.id;
      pendingEffectiveAt =
        existing?.pendingPlanId === actualPlan
          ? existing.pendingEffectiveAt ?? currentPeriodEndsAt
          : currentPeriodEndsAt;
    }

    const status = subscription.status as SandpiSubscriptionStatus;
    const remainsPastDue =
      status === "past_due" && existing?.status === "past_due";
    const graceEndsAt =
      status === "past_due"
        ? remainsPastDue && existing.graceEndsAt
          ? existing.graceEndsAt
          : new Date(now.getTime() + PAST_DUE_GRACE_MS)
        : undefined;
    const quotaAnchorAt =
      existing?.quotaAnchorAt ??
      (status === "active" || status === "trialing" ? now : undefined);

    await this.repository.upsertSubscription({
      userId,
      stripeSubscriptionId: subscription.id,
      stripePriceId,
      planId,
      status,
      cancelAtPeriodEnd: cancellationIsScheduled(subscription, now),
      currentPeriodStartsAt,
      currentPeriodEndsAt,
      quotaAnchorAt,
      graceEndsAt,
      pendingPlanId,
      pendingPriceId,
      pendingEffectiveAt,
    });
    this.logger.info(
      {
        userId,
        subscriptionId: subscription.id,
        planId,
        status,
        pendingPlanId,
      },
      "Synchronized Sandpi subscription",
    );
  }

  private planForPrice(priceId: string) {
    if (this.config.mode !== "stripe") return undefined;
    if (priceId === this.config.plusPriceId) return "plus" as const;
    if (priceId === this.config.proPriceId) return "pro" as const;
    if (priceId === this.config.ultraPriceId) return "ultra" as const;
    return undefined;
  }

  private requireStripe() {
    if (this.config.mode !== "stripe" || !this.stripe) {
      throw new HttpError(
        503,
        "billing_not_configured",
        "Subscription billing is not enabled for this Sandpi deployment.",
      );
    }
    return { stripe: this.stripe, config: this.config };
  }
}

function subscriptionCanBeUpdated(status: SandpiSubscriptionStatus) {
  return (
    status === "active" ||
    status === "trialing" ||
    status === "past_due" ||
    status === "unpaid" ||
    status === "paused"
  );
}

function cancellationIsScheduled(
  subscription: Stripe.Subscription,
  now: Date,
) {
  return (
    subscriptionCanBeUpdated(subscription.status) &&
    (subscription.cancel_at_period_end ||
      (subscription.cancel_at != null &&
        fromUnixSeconds(subscription.cancel_at).getTime() >
          now.getTime()))
  );
}

function subscriptionStatusPriority(status: SandpiSubscriptionStatus) {
  switch (status) {
    case "active":
    case "trialing":
      return 3;
    case "past_due":
      return 2;
    case "unpaid":
    case "paused":
    case "incomplete":
      return 1;
    case "incomplete_expired":
    case "canceled":
      return 0;
  }
}

function stripeId(
  value:
    | string
    | { id: string }
    | null
    | undefined,
) {
  return typeof value === "string" ? value : value?.id;
}

function fromUnixSeconds(value: number) {
  return new Date(value * 1_000);
}

function webhookReceipt(event: Stripe.Event) {
  const object = event.data.object as { id?: unknown };
  return {
    objectId: typeof object.id === "string" ? object.id : undefined,
    created: event.created,
    livemode: event.livemode,
  };
}

function stripeResourceMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "resource_missing"
  );
}
