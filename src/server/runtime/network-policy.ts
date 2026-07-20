import { createHash } from "node:crypto";

import type { Sandbox } from "sandbox0";

import { normalizeNetworkDomain } from "@/lib/network-policy";
import type { Sandbox0NetworkPolicyInput } from "./types";

type Sandbox0NetworkPolicy = Parameters<Sandbox["updateNetworkPolicy"]>[0];

export interface ManagedMcpCredentialBinding {
  bindingRef: string;
  sourceRef: string;
  destinationDomain: string;
  destinationPath: string;
  credentialHeaderName: string;
  credentialValueTemplate: string;
}

/**
 * Composes the user-owned traffic policy with Sandpi-managed MCP credential
 * bindings. Credential injection is orthogonal to traffic authorization, so
 * adding a binding never bypasses a user deny rule.
 */
export function toSandbox0NetworkPolicy(
  policy: Sandbox0NetworkPolicyInput,
  managed: readonly ManagedMcpCredentialBinding[] = [],
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
  const managedBindings = normalizeManagedBindings(managed);
  if (domains.length === 0 && managedBindings.length === 0) {
    return { mode: policy.mode, credentialBindings: [] };
  }

  const trafficRules =
    domains.length > 0
      ? [
          {
            name: "sandpi-environment-domain-exceptions",
            action:
              policy.mode === "block-all"
                ? ("allow" as const)
                : ("deny" as const),
            domains,
          },
        ]
      : undefined;

  return {
    mode: policy.mode,
    egress: {
      ...(trafficRules ? { trafficRules } : {}),
      ...(managedBindings.length > 0
        ? {
            credentialRules: managedBindings.map((binding) => ({
              name: managedCredentialRuleName(binding.bindingRef),
              credentialRef: binding.bindingRef,
              rollout: "enabled",
              protocol: "https",
              tlsMode: "terminate-reoriginate",
              failurePolicy: "fail-closed",
              domains: [binding.destinationDomain],
              ports: [{ port: 443, protocol: "tcp" }],
              httpMatch: {
                paths: [binding.destinationPath],
              },
            })),
          }
        : {}),
    },
    credentialBindings: managedBindings.map((binding) => ({
      ref: binding.bindingRef,
      sourceRef: binding.sourceRef,
      projection: {
        type: "http_headers",
        httpHeaders: {
          headers: [
            {
              name: binding.credentialHeaderName,
              valueTemplate: binding.credentialValueTemplate,
            },
          ],
        },
      },
    })),
  };
}

function normalizeManagedBindings(
  bindings: readonly ManagedMcpCredentialBinding[],
) {
  const bindingRefs = new Set<string>();
  const destinations = new Set<string>();
  return bindings
    .map((binding) => {
      const bindingRef = requiredTrimmed(binding.bindingRef, "binding ref");
      if (bindingRefs.has(bindingRef)) {
        throw new Error(`Duplicate MCP credential binding ref: ${bindingRef}`);
      }
      bindingRefs.add(bindingRef);

      const sourceRef = requiredTrimmed(binding.sourceRef, "source ref");
      const destinationDomain = normalizeNetworkDomain(
        binding.destinationDomain,
      );
      if (!destinationDomain || destinationDomain.startsWith("*.")) {
        throw new Error(
          `Invalid exact MCP credential destination domain: ${binding.destinationDomain}`,
        );
      }
      const destinationPath = normalizeDestinationPath(binding.destinationPath);
      const destinationKey = `${destinationDomain}\n${destinationPath}`;
      if (destinations.has(destinationKey)) {
        throw new Error(
          `Duplicate MCP credential destination: ${destinationDomain}${destinationPath}`,
        );
      }
      destinations.add(destinationKey);

      const credentialHeaderName = requiredTrimmed(
        binding.credentialHeaderName,
        "header name",
      );
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(credentialHeaderName)) {
        throw new Error(
          `Invalid MCP credential header name: ${credentialHeaderName}`,
        );
      }
      const credentialValueTemplate = requiredTrimmed(
        binding.credentialValueTemplate,
        "header value template",
      );
      if (
        !/^(?:[A-Za-z][A-Za-z0-9._~-]{0,31} )?\{\{ \.token \}\}$/.test(
          credentialValueTemplate,
        )
      ) {
        throw new Error(
          "MCP credential value template must be a managed token template.",
        );
      }
      return {
        bindingRef,
        sourceRef,
        destinationDomain,
        destinationPath,
        credentialHeaderName,
        credentialValueTemplate,
      };
    })
    .sort(
      (left, right) =>
        left.destinationDomain.localeCompare(right.destinationDomain) ||
        right.destinationPath.length - left.destinationPath.length ||
        left.destinationPath.localeCompare(right.destinationPath) ||
        left.bindingRef.localeCompare(right.bindingRef),
    );
}

function normalizeDestinationPath(path: string) {
  const normalized = path.trim() || "/";
  if (
    !normalized.startsWith("/") ||
    normalized.includes("?") ||
    normalized.includes("#")
  ) {
    throw new Error(
      `Invalid MCP credential destination path: ${path || "(empty)"}`,
    );
  }
  return normalized;
}

function requiredTrimmed(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`MCP credential ${label} is required.`);
  return normalized;
}

function managedCredentialRuleName(bindingRef: string) {
  const suffix = createHash("sha256")
    .update(bindingRef)
    .digest("hex")
    .slice(0, 12);
  return `sandpi-mcp-credential-${suffix}`;
}
