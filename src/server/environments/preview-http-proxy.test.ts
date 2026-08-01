import assert from "node:assert/strict";
import test from "node:test";

import {
  previewDownstreamHeaders,
  previewRedirectLocation,
  previewUpstreamHeaders,
  withoutCookie,
} from "./preview-http-proxy";

const session = {
  userId: "user-one",
  environmentId: "environment-one",
  targetHost: "localhost" as const,
  targetPort: 3000,
};
const previewOrigin = "https://p3000-deadbeef.preview.sandpi.example";

test("forwards application headers without Preview credentials", () => {
  assert.deepEqual(
    previewUpstreamHeaders(
      {
        host: "preview.sandpi.example",
        cookie: "app=one; __Host-sandpi_preview=secret; theme=dark",
        origin: previewOrigin,
        referer: `${previewOrigin}/dashboard`,
        connection: "keep-alive",
        "x-forwarded-for": "203.0.113.5",
        "x-sandpi-preview-proxy": "attacker",
      },
      { "X-Sandpi-Preview-Proxy": "server-secret" },
      session,
      previewOrigin,
      "__Host-sandpi_preview",
    ),
    {
      cookie: "app=one; theme=dark",
      origin: "http://localhost:3000",
      referer: "http://localhost:3000/dashboard",
      "X-Sandpi-Preview-Proxy": "server-secret",
    },
  );
});

test("rewrites same-target redirects and frame/cookie response headers", () => {
  assert.equal(
    previewRedirectLocation(
      "http://localhost:3000/login?next=%2F",
      session,
      previewOrigin,
    ),
    `${previewOrigin}/login?next=%2F`,
  );
  assert.equal(
    previewRedirectLocation("http://localhost:4000/other", session, previewOrigin),
    "http://localhost:4000/other",
  );
  assert.deepEqual(
    previewDownstreamHeaders(
      {
        location: "/next",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "set-cookie": [
          "app=one; Domain=localhost; Path=/; HttpOnly",
          "__Host-sandpi_preview=attacker; Secure; Path=/",
        ],
      },
      session,
      previewOrigin,
      "__Host-sandpi_preview",
    ),
    {
      location: `${previewOrigin}/next`,
      "content-security-policy": "default-src 'self'",
      "set-cookie": ["app=one; Path=/; HttpOnly"],
    },
  );
});

test("removes only the reserved Preview cookie", () => {
  assert.equal(
    withoutCookie("a=1; sandpi_preview=secret; b=2", "sandpi_preview"),
    "a=1; b=2",
  );
  assert.equal(withoutCookie("sandpi_preview=secret", "sandpi_preview"), undefined);
});
