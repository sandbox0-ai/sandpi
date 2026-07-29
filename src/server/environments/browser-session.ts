import { createHash } from "node:crypto";

export const ENVIRONMENT_BROWSER_OWNER_SESSION_NAME = "default";
export const ENVIRONMENT_BROWSER_SESSION_PREFIX = "sandpi-";
const ENVIRONMENT_BROWSER_SESSION_PATTERN = /^sandpi-[a-f0-9]{32}$/;

/**
 * Derives the Playwright CLI attachment owned by one Sandpi Session without
 * exposing product identifiers as daemon-registry filenames.
 */
export function environmentBrowserSessionName(sessionId: string) {
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return `${ENVIRONMENT_BROWSER_SESSION_PREFIX}${digest.slice(0, 32)}`;
}

export function isEnvironmentBrowserSessionName(
  value: string,
): boolean {
  return ENVIRONMENT_BROWSER_SESSION_PATTERN.test(value);
}
