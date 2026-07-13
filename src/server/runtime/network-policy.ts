import type { Sandbox0NetworkPolicyInput } from "./types";

export interface Sandbox0NetworkPolicy {
  mode: "allow-all" | "block-all";
  egress?: {
    trafficRules: Array<{
      name: string;
      action: "allow";
      domains: string[];
      ports: Array<{ port: number; protocol: "tcp" }>;
    }>;
  };
}

/**
 * Sandbox0 has allow-all and block-all base modes. Sandpi's restricted mode is
 * a block-all policy with explicit allow rules; it is submitted in the claim
 * request so a Sandbox never starts in a temporary unrestricted state.
 */
export function toSandbox0NetworkPolicy(
  policy: Sandbox0NetworkPolicyInput,
): Sandbox0NetworkPolicy {
  if (policy.mode === "allow-all") {
    return { mode: "allow-all" };
  }
  if (policy.mode === "block-all" || policy.allowedDomains.length === 0) {
    return { mode: "block-all" };
  }

  return {
    mode: "block-all",
    egress: {
      trafficRules: [
        {
          name: "sandpi-environment-allow",
          action: "allow",
          domains: [...new Set(policy.allowedDomains.map(normalizeDomain))].sort(),
          ports: [{ port: 443, protocol: "tcp" }],
        },
      ],
    },
  };
}

function normalizeDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}
