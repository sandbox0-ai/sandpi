const DOMAIN_LABEL_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const NETWORK_DOMAIN_INPUT_ERROR =
  "Enter a domain such as example.com or *.example.com, without a URL, path, or port.";

/**
 * Normalizes one user-facing domain matcher to Sandbox0's exact or wildcard
 * suffix form. URLs and host:port values are rejected because their extra
 * components would otherwise look configured without affecting the rule.
 */
export function normalizeNetworkDomain(value: string): string | undefined {
  let normalized = value.trim().toLowerCase();
  if (
    normalized === "" ||
    normalized.includes("://") ||
    normalized.includes("/") ||
    normalized.includes(":") ||
    /\s/.test(normalized)
  ) {
    return undefined;
  }

  const wildcard = normalized.startsWith("*.");
  if (wildcard) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/\.$/, "");

  if (
    normalized === "" ||
    normalized.length > 253 ||
    normalized.split(".").some((label) => !DOMAIN_LABEL_PATTERN.test(label))
  ) {
    return undefined;
  }

  return wildcard ? `*.${normalized}` : normalized;
}
