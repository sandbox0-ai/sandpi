import type { Sandbox } from "sandbox0";

import { normalizeNetworkDomain } from "@/lib/network-policy";
import type {
  RuntimeEnvironmentEgressCredential,
  Sandbox0NetworkPolicyInput,
} from "./types";

type Sandbox0NetworkPolicy = Parameters<Sandbox["updateNetworkPolicy"]>[0];

export function toSandbox0NetworkPolicy(
  policy: Sandbox0NetworkPolicyInput,
  credentials: RuntimeEnvironmentEgressCredential[] = [],
): Sandbox0NetworkPolicy {
  const domains = [
    ...new Set(
      policy.domainExceptions.map((domain) => {
        const normalized = normalizeNetworkDomain(domain);
        if (!normalized) {
          throw new Error(`Invalid Environment network domain: ${domain}`);
        }
        return normalized;
      }),
    ),
  ].sort();
  const enabledCredentials = credentials.filter(
    (credential) =>
      credential.enabled &&
      credential.status !== "deleting" &&
      Boolean(credential.currentVersion),
  );
  const trafficRules: NonNullable<
    NonNullable<Sandbox0NetworkPolicy["egress"]>["trafficRules"]
  > = [];
  if (domains.length > 0) {
    trafficRules.push({
      name: "sandpi-environment-domain-exceptions",
      action: policy.mode === "block-all" ? "allow" : "deny",
      domains,
    });
  }
  if (policy.mode === "block-all") {
    trafficRules.push(
      ...enabledCredentials.map((credential) => ({
        name: nativeCredentialTrafficRuleName(credential.id),
        action: "allow" as const,
        domains: credential.rule.domains,
        ports: credential.rule.ports,
      })),
    );
  }

  const credentialRules = enabledCredentials.map((credential) => ({
    name: nativeCredentialRuleName(credential.id),
    credentialRef: nativeCredentialBindingRef(credential.id),
    rollout: "enabled" as const,
    protocol: credential.rule.protocol,
    ...(requiresTLSTermination(credential)
      ? { tlsMode: "terminate-reoriginate" as const }
      : {}),
    failurePolicy: credential.rule.failurePolicy,
    domains: credential.rule.domains,
    ports: credential.rule.ports,
  }));
  const credentialBindings = enabledCredentials.map((credential) => ({
    ref: nativeCredentialBindingRef(credential.id),
    sourceRef: credential.sourceRef,
    projection: nativeCredentialProjection(credential),
  }));
  const egress =
    trafficRules.length > 0 || credentialRules.length > 0
      ? {
          ...(trafficRules.length > 0 ? { trafficRules } : {}),
          ...(credentialRules.length > 0 ? { credentialRules } : {}),
        }
      : undefined;

  return {
    mode: policy.mode,
    ...(egress ? { egress } : {}),
    credentialBindings,
  };
}

function nativeCredentialBindingRef(credentialId: string) {
  return `sandpi-credential-${credentialId}`;
}

function nativeCredentialRuleName(credentialId: string) {
  return `sandpi-credential-auth-${credentialId}`;
}

function nativeCredentialTrafficRuleName(credentialId: string) {
  return `sandpi-credential-allow-${credentialId}`;
}

function requiresTLSTermination(
  credential: RuntimeEnvironmentEgressCredential,
) {
  return (
    credential.projection.type === "tls_client_certificate" ||
    credential.rule.protocol === "https" ||
    credential.rule.protocol === "grpc"
  );
}

function nativeCredentialProjection(
  credential: RuntimeEnvironmentEgressCredential,
): NonNullable<Sandbox0NetworkPolicy["credentialBindings"]>[number]["projection"] {
  const projection = credential.projection;
  switch (projection.type) {
    case "http_headers":
      return {
        type: projection.type,
        httpHeaders: { headers: projection.headers },
      };
    case "placeholder_substitution":
      return {
        type: projection.type,
        placeholderSubstitution: { replacements: projection.replacements },
      };
    case "tls_client_certificate":
      return {
        type: projection.type,
        tlsClientCertificate: {},
      };
    case "username_password":
      return {
        type: projection.type,
        usernamePassword: {},
      };
    case "ssh_proxy":
      return {
        type: projection.type,
        sshProxy: {
          upstreamUsername: projection.upstreamUsername,
          sandboxPublicKeys: projection.sandboxPublicKeys,
          knownHosts: projection.knownHosts,
        },
      };
  }
}
