import type { UnixTimestamp } from "@/lib/time";

export const ENVIRONMENT_CREDENTIAL_RESOLVER_KINDS = [
  "static_headers",
  "static_tls_client_certificate",
  "static_username_password",
  "static_ssh_private_key",
] as const;

export type EnvironmentCredentialResolverKind =
  (typeof ENVIRONMENT_CREDENTIAL_RESOLVER_KINDS)[number];

export const ENVIRONMENT_CREDENTIAL_PROJECTION_TYPES = [
  "http_headers",
  "placeholder_substitution",
  "tls_client_certificate",
  "username_password",
  "ssh_proxy",
] as const;

export type EnvironmentCredentialProjectionType =
  (typeof ENVIRONMENT_CREDENTIAL_PROJECTION_TYPES)[number];

export type EnvironmentCredentialProtocol =
  | "http"
  | "https"
  | "grpc"
  | "tls"
  | "ssh"
  | "socks5"
  | "mqtt"
  | "redis";

export interface EnvironmentCredentialPort {
  port: number;
  protocol: "tcp";
}

export type EnvironmentCredentialProjection =
  | {
      type: "http_headers";
      headers: Array<{ name: string; valueTemplate: string }>;
    }
  | {
      type: "placeholder_substitution";
      replacements: Array<{
        placeholder: string;
        valueTemplate: string;
        locations: Array<"header" | "query" | "body">;
      }>;
    }
  | { type: "tls_client_certificate" }
  | { type: "username_password" }
  | {
      type: "ssh_proxy";
      upstreamUsername: string;
      sandboxPublicKeys: string[];
      knownHosts: string[];
    };

export interface EnvironmentCredentialRule {
  protocol: EnvironmentCredentialProtocol;
  domains: string[];
  ports: EnvironmentCredentialPort[];
  failurePolicy: "fail-closed" | "fail-open";
}

export type EnvironmentCredentialStatus =
  | "provisioning"
  | "active"
  | "error"
  | "deleting";

/**
 * Secret-free Environment view. Sandbox0 owns the source material and Sandpi
 * returns only the desired projection, destination and observed source state.
 */
export interface EnvironmentEgressCredential {
  id: string;
  environmentId: string;
  name: string;
  resolverKind: EnvironmentCredentialResolverKind;
  projection: EnvironmentCredentialProjection;
  rule: EnvironmentCredentialRule;
  enabled: boolean;
  status: EnvironmentCredentialStatus;
  currentVersion?: number;
  sourceStatus?: string;
  error?: string;
  createdAt: UnixTimestamp;
  updatedAt: UnixTimestamp;
}

export type EnvironmentCredentialMaterial =
  | {
      type: "static_headers";
      values: Record<string, string>;
    }
  | {
      type: "static_tls_client_certificate";
      certificatePem: string;
      privateKeyPem: string;
      caPem?: string;
    }
  | {
      type: "static_username_password";
      username: string;
      password: string;
    }
  | {
      type: "static_ssh_private_key";
      privateKeyPem: string;
      passphrase?: string;
    };

export interface EnvironmentEgressCredentialConfiguration {
  name: string;
  resolverKind: EnvironmentCredentialResolverKind;
  projection: EnvironmentCredentialProjection;
  rule: EnvironmentCredentialRule;
  enabled: boolean;
}

export interface CreateEnvironmentEgressCredentialInput
  extends EnvironmentEgressCredentialConfiguration {
  material: EnvironmentCredentialMaterial;
}

export type UpdateEnvironmentEgressCredentialInput =
  EnvironmentEgressCredentialConfiguration;

export interface RotateEnvironmentEgressCredentialInput {
  resolverKind: EnvironmentCredentialResolverKind;
  material: EnvironmentCredentialMaterial;
}

export function projectionMatchesResolverKind(
  resolverKind: EnvironmentCredentialResolverKind,
  projectionType: EnvironmentCredentialProjectionType,
) {
  switch (resolverKind) {
    case "static_headers":
      return (
        projectionType === "http_headers" ||
        projectionType === "placeholder_substitution"
      );
    case "static_tls_client_certificate":
      return projectionType === "tls_client_certificate";
    case "static_username_password":
      return projectionType === "username_password";
    case "static_ssh_private_key":
      return projectionType === "ssh_proxy";
  }
}

export function protocolMatchesProjection(
  projectionType: EnvironmentCredentialProjectionType,
  protocol: EnvironmentCredentialProtocol,
) {
  switch (projectionType) {
    case "http_headers":
    case "placeholder_substitution":
      return protocol === "http" || protocol === "https" || protocol === "grpc";
    case "tls_client_certificate":
      return protocol === "tls";
    case "username_password":
      return protocol === "socks5" || protocol === "mqtt" || protocol === "redis";
    case "ssh_proxy":
      return protocol === "ssh";
  }
}
