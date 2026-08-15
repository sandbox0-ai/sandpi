import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config";

const oidcEnvironment = {
  NODE_ENV: "test",
  SANDPI_AUTH_MODE: "oidc",
  SANDPI_PUBLIC_URL: "https://sandpi.example.com",
  SANDPI_COOKIE_SECRET: "cookie-secret-with-at-least-32-characters",
  SANDPI_SECRET_KEY: "deployment-secret-with-at-least-32-characters",
  SANDPI_OIDC_ISSUER: "https://identity.example.com/",
  SANDPI_OIDC_CLIENT_ID: "sandpi",
  SANDPI_OIDC_DEVICE_CLIENT_ID: "sandpi-cli",
} as const satisfies NodeJS.ProcessEnv;

test("configures a confidential OIDC client explicitly", () => {
  const config = loadConfig({
    ...oidcEnvironment,
    SANDPI_OIDC_CLIENT_SECRET: "oidc-client-secret",
    SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "client_secret_basic",
    SANDPI_OIDC_SCOPES: "  openid   email profile  ",
  });

  assert.equal(config.auth.mode, "oidc");
  if (config.auth.mode !== "oidc") return;
  assert.equal(config.auth.tokenEndpointAuthMethod, "client_secret_basic");
  assert.equal(config.auth.clientSecret, "oidc-client-secret");
  assert.equal(config.auth.deviceClientId, "sandpi-cli");
  assert.equal(config.auth.scopes, "openid email profile");
});

test("defaults confidential OIDC clients to client_secret_post", () => {
  const config = loadConfig({
    ...oidcEnvironment,
    SANDPI_OIDC_CLIENT_SECRET: "oidc-client-secret",
  });

  assert.equal(config.auth.mode, "oidc");
  if (config.auth.mode !== "oidc") return;
  assert.equal(config.auth.tokenEndpointAuthMethod, "client_secret_post");
});

test("defaults OIDC clients without a secret to public client authentication", () => {
  const config = loadConfig(oidcEnvironment);

  assert.equal(config.auth.mode, "oidc");
  if (config.auth.mode !== "oidc") return;
  assert.equal(config.auth.tokenEndpointAuthMethod, "none");
  assert.equal(config.auth.clientSecret, undefined);
});

test("configures OIDC new-user admission explicitly", () => {
  const openConfig = loadConfig(oidcEnvironment);
  const closedConfig = loadConfig({
    ...oidcEnvironment,
    SANDPI_ALLOW_NEW_USERS: "false",
  });

  assert.equal(openConfig.auth.mode, "oidc");
  assert.equal(closedConfig.auth.mode, "oidc");
  if (openConfig.auth.mode !== "oidc" || closedConfig.auth.mode !== "oidc") {
    return;
  }
  assert.equal(openConfig.auth.allowNewUsers, true);
  assert.equal(closedConfig.auth.allowNewUsers, false);
  assert.throws(
    () =>
      loadConfig({
        ...oidcEnvironment,
        SANDPI_ALLOW_NEW_USERS: "yes",
      }),
    /SANDPI_ALLOW_NEW_USERS/,
  );
});

test("rejects inconsistent OIDC client authentication settings", () => {
  assert.throws(
    () =>
      loadConfig({
        ...oidcEnvironment,
        SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "client_secret_post",
      }),
    /SANDPI_OIDC_CLIENT_SECRET is required/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...oidcEnvironment,
        SANDPI_OIDC_CLIENT_SECRET: "oidc-client-secret",
        SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "none",
      }),
    /SANDPI_OIDC_CLIENT_SECRET must be unset/,
  );
});

test("requires the openid scope for OIDC", () => {
  assert.throws(
    () =>
      loadConfig({
        ...oidcEnvironment,
        SANDPI_OIDC_SCOPES: "profile email",
      }),
    /SANDPI_OIDC_SCOPES must include openid/,
  );
});

test("keeps self-hosted billing disabled by default", () => {
  assert.deepEqual(loadConfig({ NODE_ENV: "test" }).billing, {
    mode: "disabled",
  });
});

test("configures GitHub Webhooks only from a complete GitHub App tuple", () => {
  assert.equal(loadConfig({ NODE_ENV: "test" }).githubWebhooks, undefined);
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        SANDPI_GITHUB_APP_SLUG: "sandpi",
      }),
    /SANDPI_GITHUB_CLIENT_ID.*SANDPI_GITHUB_CLIENT_SECRET.*SANDPI_GITHUB_WEBHOOK_SECRET/,
  );
  assert.deepEqual(
    loadConfig({
      NODE_ENV: "test",
      SANDPI_GITHUB_APP_SLUG: "sandpi",
      SANDPI_GITHUB_CLIENT_ID: "Iv1.example",
      SANDPI_GITHUB_CLIENT_SECRET: "github-client-secret",
      SANDPI_GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
    }).githubWebhooks,
    {
      appSlug: "sandpi",
      clientId: "Iv1.example",
      clientSecret: "github-client-secret",
      webhookSecret: "github-webhook-secret",
    },
  );
});

test("requires a complete server-side Stripe configuration", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "test",
        SANDPI_BILLING_MODE: "stripe",
        SANDPI_STRIPE_SECRET_KEY: "sk_test_example",
      }),
    /SANDPI_STRIPE_WEBHOOK_SECRET.*SANDPI_STRIPE_PLUS_PRICE_ID.*SANDPI_STRIPE_PRO_PRICE_ID.*SANDPI_STRIPE_ULTRA_PRICE_ID/,
  );

  const config = loadConfig({
    NODE_ENV: "test",
    SANDPI_BILLING_MODE: "stripe",
    SANDPI_STRIPE_PRIVATE_KEY: "sk_test_example",
    SANDPI_STRIPE_WEBHOOK_SECRET: "whsec_example",
    SANDPI_STRIPE_PLUS_PRICE_ID: "price_plus",
    SANDPI_STRIPE_PRO_PRICE_ID: "price_pro",
    SANDPI_STRIPE_ULTRA_PRICE_ID: "price_ultra",
    SANDPI_USAGE_POLL_INTERVAL_MS: "30000",
  });
  assert.deepEqual(config.billing, {
    mode: "stripe",
    secretKey: "sk_test_example",
    webhookSecret: "whsec_example",
    plusPriceId: "price_plus",
    proPriceId: "price_pro",
    ultraPriceId: "price_ultra",
    usagePollIntervalMs: 30_000,
  });
});
