import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
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
  SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD:
    oidcTokenEndpointAuthMethod.optional(),
  SANDPI_OIDC_SCOPES: z.string().default("openid profile email"),
  SANDBOX0_API_HOST: optionalUrl,
  SANDBOX0_API_KEY: z.string().min(1).optional(),
  SANDBOX0_BASE_URL: optionalUrl,
  SANDBOX0_TOKEN: z.string().min(1).optional(),
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
        tokenEndpointAuthMethod: z.infer<
          typeof oidcTokenEndpointAuthMethod
        >;
        scopes: string;
      };
  secretKey?: string;
  sandbox0?: { apiHost: string; apiKey: string };
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
      tokenEndpointAuthMethod,
      scopes: scopes.join(" "),
    };
  } else {
    auth = { mode: "admin", cookieSecret: value.SANDPI_COOKIE_SECRET };
  }

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
    sandbox0: apiHost && apiKey ? { apiHost, apiKey } : undefined,
  };
}
