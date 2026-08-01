import assert from "node:assert/strict";
import test from "node:test";

import type { EnvironmentRuntimeAccessService } from "./runtime-access-service";
import type { RuntimeAdapter } from "@/server/runtime/types";
import {
  EnvironmentPreviewService,
  PREVIEW_TICKET_QUERY,
  previewHostname,
} from "./preview-service";

const runtimeRecord = {
  id: "environment-one",
  sandboxId: "sandbox-one",
  workspaceVolumeId: "volume-one",
  runtimeGeneration: 4,
  decoder: { carry: "", insideString: false, escapeNext: false, depth: 0 },
};

function fixture(now = 1_000) {
  let ensureCalls = 0;
  const runtimeAccess = {
    withRuntimeAccess: async (
      _userId: string,
      _environmentId: string,
      operation: (runtime: typeof runtimeRecord) => Promise<unknown>,
    ) => operation(runtimeRecord),
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    ensureEnvironmentPreviewProxy: async () => {
      ensureCalls += 1;
      return {
        publicUrl: "https://sandbox0.example/service/",
        requestHeaders: { "X-Sandbox-Auth": "secret" },
      };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentPreviewService(runtimeAccess, runtime, {
    publicUrl: new URL("https://preview.sandpi.example"),
    signingKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  return { service, ensureCalls: () => ensureCalls };
}

test("creates an isolated signed Preview URL and caches proxy coordinates", async () => {
  const { service, ensureCalls } = fixture();
  const first = await service.createSession(
    "user-one",
    "environment-one",
    "localhost:3000/dashboard?q=1#top",
  );
  const second = await service.createSession(
    "user-one",
    "environment-one",
    "http://127.0.0.1:3000/health",
  );

  const firstUrl = new URL(first.url);
  assert.equal(
    firstUrl.hostname,
    previewHostname("environment-one", 3000, "preview.sandpi.example"),
  );
  assert.equal(firstUrl.pathname, "/dashboard");
  assert.equal(firstUrl.searchParams.get("q"), "1");
  assert.ok(firstUrl.searchParams.get(PREVIEW_TICKET_QUERY));
  assert.equal(firstUrl.hash, "#top");
  assert.equal(second.target, "http://127.0.0.1:3000/health");
  assert.equal(ensureCalls(), 1);
});

test("exchanges short-lived tickets for host-bound sessions", async () => {
  const { service } = fixture();
  const created = await service.createSession(
    "user-one",
    "environment-one",
    "localhost:4173/app",
  );
  const createdUrl = new URL(created.url);
  const ticket = createdUrl.searchParams.get(PREVIEW_TICKET_QUERY)!;
  const exchanged = service.exchangeTicket(createdUrl.host, ticket);

  assert.deepEqual(service.authorize(createdUrl.host, exchanged.token), {
    userId: "user-one",
    environmentId: "environment-one",
    targetHost: "localhost",
    targetPort: 4173,
  });
  assert.throws(
    () => service.authorize(`p4173-deadbeef.preview.sandpi.example`, exchanged.token),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "environment_preview_session_invalid",
  );
});

test("adds only server-held routing headers to the protected upstream", async () => {
  const { service } = fixture();
  const upstream = await service.upstream(
    {
      userId: "user-one",
      environmentId: "environment-one",
      targetHost: "127.0.0.1",
      targetPort: 8080,
    },
    "/events?stream=1",
  );
  assert.equal(upstream.url.toString(), "https://sandbox0.example/events?stream=1");
  assert.deepEqual(upstream.headers, {
    "X-Sandbox-Auth": "secret",
    "X-Sandpi-Preview-Target-Host": "127.0.0.1",
    "X-Sandpi-Preview-Target-Port": "8080",
  });
});
