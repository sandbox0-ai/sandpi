import type { Sandbox } from "sandbox0";

import { normalizeNetworkDomain } from "@/lib/network-policy";
import type { Sandbox0NetworkPolicyInput } from "./types";

type Sandbox0NetworkPolicy = Parameters<Sandbox["updateNetworkPolicy"]>[0];

/**
 * Sandpi stores one domain-exception list. Sandbox0's mode supplies the
 * unmatched fallback, while one native traffic rule gives those exceptions
 * the opposite action.
 */
export function toSandbox0NetworkPolicy(
  policy: Sandbox0NetworkPolicyInput,
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
  if (domains.length === 0) {
    return { mode: policy.mode };
  }

  return {
    mode: policy.mode,
    egress: {
      trafficRules: [
        {
          name: "sandpi-environment-domain-exceptions",
          action: policy.mode === "block-all" ? "allow" : "deny",
          domains,
        },
      ],
    },
  };
}
