import assert from "node:assert/strict";
import test from "node:test";

import { publicAuthPath, validateBillingRuntime } from "./server";

test("only Stripe webhook and OIDC entry routes bypass user authentication", () => {
  assert.equal(publicAuthPath("/api/v1/auth/login"), true);
  assert.equal(publicAuthPath("/api/v1/auth/callback?code=example"), true);
  assert.equal(publicAuthPath("/api/v1/billing/webhook"), true);
  assert.equal(publicAuthPath("/api/v1/billing/summary"), false);
  assert.equal(publicAuthPath("/api/v1/billing/checkout"), false);
  assert.equal(publicAuthPath("/api/v1/billing/webhook/other"), false);
});

test("Stripe mode refuses to start without the official SDK usage resource", () => {
  assert.doesNotThrow(() =>
    validateBillingRuntime(
      { mode: "disabled" },
      { supportsUsageWindows: () => false },
    ),
  );
  assert.throws(
    () =>
      validateBillingRuntime(
        {
          mode: "stripe",
          secretKey: "sk_test",
          webhookSecret: "whsec_test",
          plusPriceId: "price_plus",
          proPriceId: "price_pro",
          usagePollIntervalMs: 15_000,
        },
        { supportsUsageWindows: () => false },
      ),
    /client\.usage\.listWindows/,
  );
  assert.doesNotThrow(() =>
    validateBillingRuntime(
      {
        mode: "stripe",
        secretKey: "sk_test",
        webhookSecret: "whsec_test",
        plusPriceId: "price_plus",
        proPriceId: "price_pro",
        usagePollIntervalMs: 15_000,
      },
      { supportsUsageWindows: () => true },
    ),
  );
});
