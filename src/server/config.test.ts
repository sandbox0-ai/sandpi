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
