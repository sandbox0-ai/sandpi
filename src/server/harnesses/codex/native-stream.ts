import type { CodexNativeStreamFailure } from "@/harnesses/codex/types";
import { HttpError } from "@/server/http-error";

export const CODEX_NATIVE_STREAM_AUTH_RETRY_MS = 15_000;

/**
 * Converts only deployment-credential failures into the Codex SSE contract.
 * Request authentication, missing Sessions, and transient runtime errors keep
 * their ordinary HTTP semantics and are handled by EventSource's error path.
 */
export function codexNativeStreamFailure(
  error: unknown,
): CodexNativeStreamFailure | undefined {
  if (
    !(error instanceof HttpError) ||
    !error.code.startsWith("sandbox0_") ||
    (error.statusCode !== 401 && error.statusCode !== 403)
  ) {
    return undefined;
  }

  return {
    status: error.statusCode,
    code: error.code,
    message: error.message,
    // Credential repair requires operator action, but a low-frequency
    // reconnect lets an already-open browser recover after Sandpi restarts.
    retryable: true,
  };
}
