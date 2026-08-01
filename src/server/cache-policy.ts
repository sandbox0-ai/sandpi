import path from "node:path";

const ONE_HOUR_SECONDS = 60 * 60;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const MONACO_FINGERPRINTED_ASSET = /-[A-Za-z0-9_-]{8,}\.[^/]+$/;

const API_NO_STORE_PATHS = [
  "/harnesses/codex/mcp",
  "/workspace-backups",
  "/schedules",
  "/webhooks",
  "/egress-credentials",
  "/billing",
] as const;

/**
 * Sensitive API responses are never stored implicitly. Browser Dashboard
 * handlers own their cache policy because HTML/control responses are private
 * and uncacheable while fingerprinted assets are safe to retain.
 */
export function shouldApplyApiNoStore(
  requestUrl: string,
  hasExplicitCacheControl: boolean,
) {
  if (API_NO_STORE_PATHS.some((candidate) => requestUrl.includes(candidate))) {
    return true;
  }
  return requestUrl.includes("/browser") && !hasExplicitCacheControl;
}

/**
 * Next build assets are content addressed. Monaco mixes fingerprinted chunks
 * with stable loader paths, so only the former can be immutable.
 */
export function staticWebCacheControl(filePath: string) {
  const normalized = `/${filePath
    .split(path.sep)
    .join("/")
    .replace(/^\/+/, "")}`;
  if (normalized.includes("/_next/static/")) {
    return `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
  }
  if (normalized.includes("/monaco/vs/")) {
    return MONACO_FINGERPRINTED_ASSET.test(normalized)
      ? `public, max-age=${ONE_YEAR_SECONDS}, immutable`
      : `public, max-age=${ONE_HOUR_SECONDS}`;
  }
  if (normalized.endsWith(".html")) {
    return "private, no-cache";
  }
  if (normalized.endsWith("/llms.txt")) {
    return "public, no-cache";
  }
  return `public, max-age=${ONE_HOUR_SECONDS}`;
}
