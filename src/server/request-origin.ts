import type { FastifyRequest } from "fastify";

import type { Principal } from "@/server/auth/principal";
import type { SandpiConfig } from "@/server/config";
import { HttpError } from "@/server/http-error";

const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE"]);

export function allowedOrigins(config: SandpiConfig) {
  const origins = new Set([config.publicUrl.origin]);
  if (config.nodeEnv !== "production") {
    origins.add("http://172.16.100.2:3000");
    origins.add("http://localhost:3000");
  }
  return origins;
}

/**
 * Enforces the browser-origin boundary for cookie-authenticated mutations and
 * WebSocket upgrades. CORS alone is insufficient for WebSockets and does not
 * prevent a cross-site request from reaching a state-changing handler.
 */
export function validateApiRequestOrigin(
  request: Pick<FastifyRequest, "headers" | "method"> & { principal: Principal },
  config: SandpiConfig,
) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins(config).has(origin)) {
    throw new HttpError(403, "origin_invalid", "Request Origin is not allowed.");
  }

  const websocketUpgrade =
    request.headers.upgrade?.toString().toLowerCase() === "websocket";
  const requiresOrigin = MUTATION_METHODS.has(request.method) || websocketUpgrade;

  // The built-in administrator mode intentionally supports server-to-server
  // clients without an Origin header. OIDC mode relies on a browser cookie, so
  // every state change and terminal WebSocket must prove its browser origin.
  if (requiresOrigin && !origin && request.principal.kind !== "builtin-admin") {
    throw new HttpError(403, "origin_required", "Request Origin is required.");
  }
}
