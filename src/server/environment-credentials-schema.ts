import { z } from "zod";

import {
  ENVIRONMENT_CREDENTIAL_RESOLVER_KINDS,
  projectionMatchesResolverKind,
  protocolMatchesProjection,
} from "@/lib/environment-credentials";
import {
  NETWORK_DOMAIN_INPUT_ERROR,
  normalizeNetworkDomain,
} from "@/lib/network-policy";

const MAX_SECRET_BYTES = 1024 * 1024;

const domainSchema = z.string().transform((value, context) => {
  const domain = normalizeNetworkDomain(value);
  if (!domain) {
    context.addIssue({ code: "custom", message: NETWORK_DOMAIN_INPUT_ERROR });
    return z.NEVER;
  }
  return domain;
});

const portSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  protocol: z.literal("tcp").default("tcp"),
});

const httpHeadersProjectionSchema = z.object({
  type: z.literal("http_headers"),
  headers: z
    .array(
      z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "Invalid HTTP header name."),
        valueTemplate: z.string().trim().min(1).max(2_048),
      }),
    )
    .min(1)
    .max(32),
});

const placeholderProjectionSchema = z.object({
  type: z.literal("placeholder_substitution"),
  replacements: z
    .array(
      z.object({
        placeholder: z.string().trim().min(1).max(512),
        valueTemplate: z.string().trim().min(1).max(2_048),
        locations: z
          .array(z.enum(["header", "query", "body"]))
          .min(1)
          .max(3)
          .transform((locations) => [...new Set(locations)]),
      }),
    )
    .min(1)
    .max(32),
});

const projectionSchema = z.discriminatedUnion("type", [
  httpHeadersProjectionSchema,
  placeholderProjectionSchema,
  z.object({ type: z.literal("tls_client_certificate") }),
  z.object({ type: z.literal("username_password") }),
  z.object({
    type: z.literal("ssh_proxy"),
    upstreamUsername: z.string().trim().min(1).max(255),
    sandboxPublicKeys: z
      .array(z.string().trim().min(1).max(16_384))
      .min(1)
      .max(16),
    knownHosts: z
      .array(z.string().trim().min(1).max(16_384))
      .max(64)
      .default([]),
  }),
]);

const ruleSchema = z.object({
  protocol: z.enum([
    "http",
    "https",
    "grpc",
    "tls",
    "ssh",
    "socks5",
    "mqtt",
    "redis",
  ]),
  domains: z
    .array(domainSchema)
    .min(1)
    .max(128)
    .transform((domains) => [...new Set(domains)].sort()),
  ports: z.array(portSchema).min(1).max(16),
  failurePolicy: z.enum(["fail-closed", "fail-open"]).default("fail-closed"),
});

export const environmentEgressCredentialConfigurationSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    resolverKind: z.enum(ENVIRONMENT_CREDENTIAL_RESOLVER_KINDS),
    projection: projectionSchema,
    rule: ruleSchema,
    enabled: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (!projectionMatchesResolverKind(value.resolverKind, value.projection.type)) {
      context.addIssue({
        code: "custom",
        path: ["projection", "type"],
        message: `${value.projection.type} cannot project ${value.resolverKind}.`,
      });
    }
    if (!protocolMatchesProjection(value.projection.type, value.rule.protocol)) {
      context.addIssue({
        code: "custom",
        path: ["rule", "protocol"],
        message: `${value.rule.protocol} cannot use ${value.projection.type}.`,
      });
    }
  });

const staticHeadersMaterialSchema = z.object({
  type: z.literal("static_headers"),
  values: z
    .record(
      z.string().trim().min(1).max(128),
      z.string().min(1).max(MAX_SECRET_BYTES),
    )
    .refine((values) => Object.keys(values).length > 0, {
      message: "At least one header value is required.",
    })
    .refine((values) => Object.keys(values).length <= 32, {
      message: "At most 32 header values are allowed.",
    }),
});

const materialSchema = z.discriminatedUnion("type", [
  staticHeadersMaterialSchema,
  z.object({
    type: z.literal("static_tls_client_certificate"),
    certificatePem: z.string().trim().min(1).max(MAX_SECRET_BYTES),
    privateKeyPem: z.string().trim().min(1).max(MAX_SECRET_BYTES),
    caPem: z.string().trim().max(MAX_SECRET_BYTES).optional(),
  }),
  z.object({
    type: z.literal("static_username_password"),
    username: z.string().trim().min(1).max(1_024),
    password: z.string().min(1).max(MAX_SECRET_BYTES),
  }),
  z.object({
    type: z.literal("static_ssh_private_key"),
    privateKeyPem: z.string().trim().min(1).max(MAX_SECRET_BYTES),
    passphrase: z.string().max(MAX_SECRET_BYTES).optional(),
  }),
]);

export const createEnvironmentEgressCredentialSchema =
  environmentEgressCredentialConfigurationSchema
    .and(z.object({ material: materialSchema }))
    .superRefine((value, context) => {
      if (value.resolverKind !== value.material.type) {
        context.addIssue({
          code: "custom",
          path: ["material", "type"],
          message: "Credential material must match resolverKind.",
        });
      }
    });

export const rotateEnvironmentEgressCredentialSchema = z
  .object({
    resolverKind: z.enum(ENVIRONMENT_CREDENTIAL_RESOLVER_KINDS),
    material: materialSchema,
  })
  .superRefine((value, context) => {
    if (value.resolverKind !== value.material.type) {
      context.addIssue({
        code: "custom",
        path: ["material", "type"],
        message: "Credential material must match resolverKind.",
      });
    }
  });
