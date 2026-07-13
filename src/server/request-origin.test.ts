import assert from "node:assert/strict";
import test from "node:test";

import type { Principal } from "@/server/auth/principal";
import type { SandpiConfig } from "@/server/config";
import { validateApiRequestOrigin } from "@/server/request-origin";

const config = {
  nodeEnv: "production",
  publicUrl: new URL("https://sandpi.example.com"),
} as SandpiConfig;

const builtin: Principal = {
  userId: "user-admin",
  subject: "builtin:admin",
  email: "admin@sandpi.local",
  name: "Administrator",
  kind: "builtin-admin",
};

const oidc: Principal = {
  userId: "user-1",
  subject: "oidc:user-1",
  email: "user@example.com",
  name: "User",
  kind: "oidc-session",
};

function request(
  principal: Principal,
  method: string,
  headers: Record<string, string | undefined> = {},
) {
  return { principal, method, headers };
}

test("rejects an untrusted Origin even in built-in administrator mode", () => {
  assert.throws(
    () =>
      validateApiRequestOrigin(
        request(builtin, "POST", { origin: "https://attacker.example" }),
        config,
      ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "origin_invalid",
  );
});

test("requires an Origin for OIDC mutations", () => {
  assert.throws(
    () => validateApiRequestOrigin(request(oidc, "PUT"), config),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "origin_required",
  );
});

test("requires and validates the terminal WebSocket Origin", () => {
  assert.throws(
    () =>
      validateApiRequestOrigin(
        request(oidc, "GET", { upgrade: "websocket" }),
        config,
      ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "origin_required",
  );

  assert.doesNotThrow(() =>
    validateApiRequestOrigin(
      request(oidc, "GET", {
        origin: "https://sandpi.example.com",
        upgrade: "websocket",
      }),
      config,
    ),
  );
});

test("allows originless read-only and built-in administrator requests", () => {
  assert.doesNotThrow(() =>
    validateApiRequestOrigin(request(oidc, "GET"), config),
  );
  assert.doesNotThrow(() =>
    validateApiRequestOrigin(request(builtin, "DELETE"), config),
  );
});
