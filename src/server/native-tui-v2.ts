import { HttpError } from "@/server/http-error";

export const NATIVE_TUI_V2_UNAVAILABLE_CODE =
  "native_tui_structured_operation_unavailable";

/**
 * v1 operations that depended on Codex app-server Turn semantics. The route
 * templates used by OpenAPI and concrete request paths intentionally match
 * the same rules so the documented 410 boundary cannot drift from runtime.
 */
export function isNativeTuiV2LegacyOperation(method: string, requestUrl: string) {
  const path = requestUrl.split("?", 1)[0] ?? requestUrl;
  const normalizedMethod = method.toUpperCase();

  if (path === "/api/v1/sessions") return normalizedMethod !== "GET";
  if (/^\/api\/v1\/sessions\/[^/]+$/.test(path)) {
    return normalizedMethod !== "GET";
  }
  if (/^\/api\/v1\/sessions\/[^/]+\//.test(path)) return true;

  if (
    /^\/api\/v1\/environments\/[^/]+\/harnesses\/codex\/(rate-limits|models|memories|uploads|skills|mcp-servers)(?:\/|$)/.test(
      path,
    )
  ) {
    return true;
  }

  if (
    path === "/api/v1/webhook-sources/github/events" ||
    path === "/api/v1/webhook-sources/github/callback" ||
    /^\/api\/v1\/webhooks\/[^/]+$/.test(path)
  ) {
    return true;
  }

  if (
    /^\/api\/v1\/environments\/[^/]+\/(schedules|webhooks|webhook-sources\/github)(?:\/|$)/.test(
      path,
    )
  ) {
    // Definitions and run history remain readable, and DELETE stays available
    // for explicit cleanup. New execution-producing mutations are gone.
    return !["GET", "DELETE"].includes(normalizedMethod);
  }
  return false;
}

export function rejectNativeTuiV2LegacyOperation(
  method: string,
  requestUrl: string,
) {
  if (!isNativeTuiV2LegacyOperation(method, requestUrl)) return;
  throw new HttpError(
    410,
    NATIVE_TUI_V2_UNAVAILABLE_CODE,
    "This structured Codex app-server operation was retired by Sandpi v2. Use the native Agent TUI; durable automation requires a future headless adapter.",
  );
}
