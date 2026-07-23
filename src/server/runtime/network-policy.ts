import type { Sandbox } from "sandbox0";

import { normalizeNetworkDomain } from "@/lib/network-policy";
import type { Sandbox0NetworkPolicyInput } from "./types";

type Sandbox0NetworkPolicy = Parameters<Sandbox["updateNetworkPolicy"]>[0];

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
    return { mode: policy.mode, credentialBindings: [] };
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
    credentialBindings: [],
  };
}
