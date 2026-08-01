import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalDeploymentSecret = z
  .string()
  .min(32, "Deployment encryption keys must contain at least 32 characters.")
  .refine(
    (value) => !/^replace[-_ ]?with/i.test(value),
    "Replace the example deployment encryption key.",
  )
  .optional();

const oidcTokenEndpointAuthMethod = z.enum([
  "client_secret_post",
  "client_secret_basic",
  "none",
]);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://sandpi@127.0.0.1:55432/sandpi"),
  SANDPI_HOST: z.string().min(1).default("172.16.100.2"),
  SANDPI_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SANDPI_PUBLIC_URL: optionalUrl,
  SANDPI_WEB_DIR: z.string().min(1).optional(),
  SANDPI_AUTH_MODE: z.enum(["admin", "oidc"]).default("admin"),
  SANDPI_COOKIE_SECRET: z.string().min(32).optional(),
  SANDPI_SECRET_KEY: optionalDeploymentSecret,
  SANDPI_OIDC_ISSUER: optionalUrl,
  SANDPI_OIDC_CLIENT_ID: z.string().min(1).optional(),
  SANDPI_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  SANDPI_OIDC_DEVICE_CLIENT_ID: optionalString,
  SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD:
    oidcTokenEndpointAuthMethod.optional(),
  SANDPI_OIDC_SCOPES: z.string().default("openid profile email"),
  SANDPI_GITHUB_APP_SLUG: optionalString,
  SANDPI_GITHUB_CLIENT_ID: optionalString,
  SANDPI_GITHUB_CLIENT_SECRET: optionalString,
  SANDPI_GITHUB_WEBHOOK_SECRET: optionalString,
  SANDBOX0_API_HOST: optionalUrl,
  SANDBOX0_API_KEY: z.string().min(1).optional(),
  SANDBOX0_BASE_URL: optionalUrl,
  SANDBOX0_TOKEN: z.string().min(1).optional(),
  SANDPI_BILLING_MODE: z.enum(["disabled", "stripe"]).default("disabled"),
  SANDPI_STRIPE_SECRET_KEY: z.string().min(1).optional(),
  SANDPI_STRIPE_PRIVATE_KEY: z.string().min(1).optional(),
  SANDPI_STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  SANDPI_STRIPE_PLUS_PRICE_ID: z.string().min(1).optional(),
  SANDPI_STRIPE_PRO_PRICE_ID: z.string().min(1).optional(),
  SANDPI_STRIPE_ULTRA_PRICE_ID: z.string().min(1).optional(),
  SANDPI_USAGE_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(300_000)
    .default(15_000),
  SANDPI_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface SandpiConfig {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  host: string;
  port: number;
  publicUrl: URL;
  webDir: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  auth:
    | { mode: "admin"; cookieSecret?: string }
    | {
        mode: "oidc";
        cookieSecret: string;
        issuer: URL;
        clientId: string;
        clientSecret?: string;
        deviceClientId?: string;
        tokenEndpointAuthMethod: z.infer<
          typeof oidcTokenEndpointAuthMethod
        >;
        scopes: string;
      };
  secretKey?: string;
  githubWebhooks?: {
    appSlug: string;
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
  };
  sandbox0?: { apiHost: string; apiKey: string };
  billing:
    | { mode: "disabled" }
    | {
        mode: "stripe";
        secretKey: string;
        webhookSecret: string;
        plusPriceId: string;
        proPriceId: string;
        ultraPriceId: string;
        usagePollIntervalMs: number;
      };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SandpiConfig {
  const value = environmentSchema.parse(environment);
  const publicUrl = new URL(
    value.SANDPI_PUBLIC_URL ?? `http://${value.SANDPI_HOST}:${value.SANDPI_PORT}`,
  );
  const apiHost = value.SANDBOX0_API_HOST ?? value.SANDBOX0_BASE_URL;
  const apiKey = value.SANDBOX0_API_KEY ?? value.SANDBOX0_TOKEN;
  const stripeSecretKey =
    value.SANDPI_STRIPE_SECRET_KEY ?? value.SANDPI_STRIPE_PRIVATE_KEY;

  let auth: SandpiConfig["auth"];
  if (value.SANDPI_AUTH_MODE === "oidc") {
    if (!value.SANDPI_COOKIE_SECRET) {
      throw new Error("SANDPI_COOKIE_SECRET is required when SANDPI_AUTH_MODE=oidc");
    }
    if (!value.SANDPI_OIDC_ISSUER || !value.SANDPI_OIDC_CLIENT_ID) {
      throw new Error(
        "SANDPI_OIDC_ISSUER and SANDPI_OIDC_CLIENT_ID are required when SANDPI_AUTH_MODE=oidc",
      );
    }
    if (!value.SANDPI_SECRET_KEY) {
      throw new Error("SANDPI_SECRET_KEY is required when SANDPI_AUTH_MODE=oidc");
    }
    const scopes = value.SANDPI_OIDC_SCOPES.trim().split(/\s+/);
    if (!scopes.includes("openid")) {
      throw new Error(
        "SANDPI_OIDC_SCOPES must include openid when SANDPI_AUTH_MODE=oidc",
      );
    }
    const tokenEndpointAuthMethod =
      value.SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD ??
      (value.SANDPI_OIDC_CLIENT_SECRET ? "client_secret_post" : "none");
    if (
      tokenEndpointAuthMethod === "none" &&
      value.SANDPI_OIDC_CLIENT_SECRET
    ) {
      throw new Error(
        "SANDPI_OIDC_CLIENT_SECRET must be unset when SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD=none",
      );
    }
    if (
      tokenEndpointAuthMethod !== "none" &&
      !value.SANDPI_OIDC_CLIENT_SECRET
    ) {
      throw new Error(
        `SANDPI_OIDC_CLIENT_SECRET is required when SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD=${tokenEndpointAuthMethod}`,
      );
    }
    auth = {
      mode: "oidc",
      cookieSecret: value.SANDPI_COOKIE_SECRET,
      issuer: new URL(value.SANDPI_OIDC_ISSUER),
      clientId: value.SANDPI_OIDC_CLIENT_ID,
      clientSecret: value.SANDPI_OIDC_CLIENT_SECRET,
      deviceClientId: value.SANDPI_OIDC_DEVICE_CLIENT_ID,
      tokenEndpointAuthMethod,
      scopes: scopes.join(" "),
    };
  } else {
    auth = { mode: "admin", cookieSecret: value.SANDPI_COOKIE_SECRET };
  }

  let billing: SandpiConfig["billing"] = { mode: "disabled" };
  if (value.SANDPI_BILLING_MODE === "stripe") {
    const missing = [
      ["SANDPI_STRIPE_SECRET_KEY", stripeSecretKey],
      ["SANDPI_STRIPE_WEBHOOK_SECRET", value.SANDPI_STRIPE_WEBHOOK_SECRET],
      ["SANDPI_STRIPE_PLUS_PRICE_ID", value.SANDPI_STRIPE_PLUS_PRICE_ID],
      ["SANDPI_STRIPE_PRO_PRICE_ID", value.SANDPI_STRIPE_PRO_PRICE_ID],
      ["SANDPI_STRIPE_ULTRA_PRICE_ID", value.SANDPI_STRIPE_ULTRA_PRICE_ID],
    ]
      .filter(([, configured]) => !configured)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required when SANDPI_BILLING_MODE=stripe`,
      );
    }
    billing = {
      mode: "stripe",
      secretKey: stripeSecretKey!,
      webhookSecret: value.SANDPI_STRIPE_WEBHOOK_SECRET!,
      plusPriceId: value.SANDPI_STRIPE_PLUS_PRICE_ID!,
      proPriceId: value.SANDPI_STRIPE_PRO_PRICE_ID!,
      ultraPriceId: value.SANDPI_STRIPE_ULTRA_PRICE_ID!,
      usagePollIntervalMs: value.SANDPI_USAGE_POLL_INTERVAL_MS,
    };
  }

  const githubValues = [
    ["SANDPI_GITHUB_APP_SLUG", value.SANDPI_GITHUB_APP_SLUG],
    ["SANDPI_GITHUB_CLIENT_ID", value.SANDPI_GITHUB_CLIENT_ID],
    ["SANDPI_GITHUB_CLIENT_SECRET", value.SANDPI_GITHUB_CLIENT_SECRET],
    ["SANDPI_GITHUB_WEBHOOK_SECRET", value.SANDPI_GITHUB_WEBHOOK_SECRET],
  ] as const;
  const configuredGitHubValues = githubValues.filter(([, configured]) => configured);
  if (
    configuredGitHubValues.length > 0 &&
    configuredGitHubValues.length !== githubValues.length
  ) {
    const missing = githubValues
      .filter(([, configured]) => !configured)
      .map(([name]) => name);
    throw new Error(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required when GitHub Webhook integration is configured`,
    );
  }
  const githubWebhooks =
    configuredGitHubValues.length === githubValues.length
      ? {
          appSlug: value.SANDPI_GITHUB_APP_SLUG!,
          clientId: value.SANDPI_GITHUB_CLIENT_ID!,
          clientSecret: value.SANDPI_GITHUB_CLIENT_SECRET!,
          webhookSecret: value.SANDPI_GITHUB_WEBHOOK_SECRET!,
        }
      : undefined;

  return {
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    host: value.SANDPI_HOST,
    port: value.SANDPI_PORT,
    publicUrl,
    webDir: value.SANDPI_WEB_DIR
      ? path.resolve(value.SANDPI_WEB_DIR)
      : fileURLToPath(new URL("../../out/", import.meta.url)),
    logLevel: value.SANDPI_LOG_LEVEL,
    auth,
    secretKey: value.SANDPI_SECRET_KEY,
    githubWebhooks,
    sandbox0: apiHost && apiKey ? { apiHost, apiKey } : undefined,
    billing,
  };
}
