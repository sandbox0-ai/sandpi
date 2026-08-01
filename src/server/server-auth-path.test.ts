import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_COOKIE_CLEAR_PATHS,
  AUTH_COOKIE_PATH,
  authCookieAttributes,
  publicAuthPath,
  validateBillingRuntime,
} from "./server";

test("only authenticated webhook and browser-auth entry routes bypass authentication", () => {
  assert.equal(publicAuthPath("/api/v1/auth/login"), true);
  assert.equal(publicAuthPath("/api/v1/auth/callback?code=example"), true);
  assert.equal(publicAuthPath("/api/v1/auth/native/prepare"), true);
  assert.equal(
    publicAuthPath("/api/v1/auth/native/login?attempt_id=example"),
    true,
  );
  assert.equal(publicAuthPath("/api/v1/auth/native/complete"), true);
  assert.equal(publicAuthPath("/api/v1/auth/native/finalize"), false);
  assert.equal(publicAuthPath("/api/v1/billing/webhook"), true);
  assert.equal(publicAuthPath("/api/v1/billing/summary"), false);
  assert.equal(publicAuthPath("/api/v1/billing/checkout"), false);
  assert.equal(publicAuthPath("/api/v1/billing/webhook/other"), false);
  assert.equal(publicAuthPath("/api/v1/webhooks/hook_123"), true);
  assert.equal(publicAuthPath("/api/v1/webhooks/hook_123?token=secret"), true);
  assert.equal(publicAuthPath("/api/v1/webhooks"), false);
  assert.equal(publicAuthPath("/api/v1/webhooks/hook_123/runs"), false);
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
          ultraPriceId: "price_ultra",
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
        ultraPriceId: "price_ultra",
        usagePollIntervalMs: 15_000,
      },
      { supportsUsageWindows: () => true },
    ),
  );
});

test("authentication cookies are scoped to the API boundary", () => {
  assert.equal(AUTH_COOKIE_PATH, "/api/v1");
  assert.deepEqual(AUTH_COOKIE_CLEAR_PATHS, ["/api/v1", "/"]);
  assert.deepEqual(
    authCookieAttributes({ publicUrl: new URL("https://sandpi.ai") }),
    {
      path: "/api/v1",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    },
  );
  assert.equal(
    authCookieAttributes({ publicUrl: new URL("http://localhost:3000") })
      .secure,
    false,
  );
});
