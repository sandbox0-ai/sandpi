import { z } from "zod";

import {
  NETWORK_DOMAIN_INPUT_ERROR,
  normalizeNetworkDomain,
} from "@/lib/network-policy";

const networkDomainSchema = z.string().transform((value, context) => {
  const domain = normalizeNetworkDomain(value);
  if (!domain) {
    context.addIssue({
      code: "custom",
      message: NETWORK_DOMAIN_INPUT_ERROR,
    });
    return z.NEVER;
  }
  return domain;
});

export const networkPolicySchema = z.object({
  mode: z.enum(["allow-all", "block-all"]),
  domainExceptions: z
    .array(networkDomainSchema)
    .max(500)
    .transform((domains) => [...new Set(domains)]),
});
