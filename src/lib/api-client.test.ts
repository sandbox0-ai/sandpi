import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, apiFetch } from "./api-client";

test("API errors preserve registration admission metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "authentication_required",
          message: "Sign in required.",
          loginUrl: "/api/v1/auth/login",
          registrationOpen: false,
        },
      }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );

  try {
    await assert.rejects(
      apiFetch("/api/v1/bootstrap"),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 401 &&
        error.loginUrl === "/api/v1/auth/login" &&
        error.registrationOpen === false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
