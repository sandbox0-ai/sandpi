import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserDashboardViewport } from "@/lib/environment-browser";
import {
  EnvironmentBrowserService,
  dashboardAssetCacheControl,
  dashboardAssetPath,
  dashboardProxyPrefix,
  dashboardRedirectLocation,
  rewriteDashboardCss,
  rewriteDashboardHtml,
} from "./browser-service";
import type { EnvironmentRuntimeAccessService } from "./runtime-access-service";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
} from "@/server/runtime/types";
import { HttpError } from "@/server/http-error";

const runtimeRecord: EnvironmentRuntimeRecord = {
  id: "environment-browser",
  sandboxId: "sandbox-browser",
  workspaceVolumeId: "volume-browser",
  runtimeGeneration: 1,
  decoder: {
    supervisorCursor: 0,
    tailBase64: "",
    runtimeGeneration: 1,
  },
};

test("reuses protected coordinates but admits every HTTP and WebSocket request", async () => {
  let admissions = 0;
  let dashboardEnsures = 0;
  const dashboardRestarts: boolean[] = [];
  const runtimeAccess = {
    async withRuntimeAccess(
      userId: string,
      environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      assert.equal(userId, "user-browser");
      assert.equal(environmentId, runtimeRecord.id);
      admissions += 1;
      return operation(runtimeRecord);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    async ensureEnvironmentBrowserService(
      runtime: EnvironmentRuntimeRecord,
      restart = false,
    ) {
      assert.equal(runtime, runtimeRecord);
      dashboardEnsures += 1;
      dashboardRestarts.push(restart);
      return {
        owner: "agent" as const,
        transport: "playwright" as const,
        revision: 0,
        publicUrl: "https://dashboard.example.invalid/generated",
        requestHeaders: { "X-Sandpi-Browser-Proxy": "secret" },
      };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  assert.deepEqual(
    await service.httpUpstream(
      "user-browser",
      runtimeRecord.id,
      "assets/app.js",
    ),
    {
      url: "https://dashboard.example.invalid/assets/app.js",
      headers: { "X-Sandpi-Browser-Proxy": "secret" },
    },
  );
  assert.deepEqual(
    await service.httpUpstream("user-browser", runtimeRecord.id, "index.html"),
    {
      url: "https://dashboard.example.invalid/index.html",
      headers: { "X-Sandpi-Browser-Proxy": "secret" },
    },
  );
  assert.deepEqual(
    await service.httpUpstream("user-browser", runtimeRecord.id, undefined),
    {
      url: "https://dashboard.example.invalid/",
      headers: { "X-Sandpi-Browser-Proxy": "secret" },
    },
  );
  assert.deepEqual(
    await service.websocketUpstream(
      "user-browser",
      runtimeRecord.id,
      "socket-guid",
    ),
    {
      url: "wss://dashboard.example.invalid/socket-guid",
      headers: { "X-Sandpi-Browser-Proxy": "secret" },
    },
  );
  assert.equal(admissions, 4);
  assert.equal(dashboardEnsures, 1);
  assert.deepEqual(dashboardRestarts, [false]);
});

test("reuses the session probe and restarts the Dashboard only on forced recovery", async () => {
  const dashboardRestarts: boolean[] = [];
  const operations: string[] = [];
  let sessionEnsures = 0;
  let browserRestarted = true;
  const runtimeAccess = {
    async withRuntimeAccess(
      _userId: string,
      _environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      return operation(runtimeRecord);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    async ensureEnvironmentBrowserSession() {
      operations.push("session");
      sessionEnsures += 1;
      return browserRestarted;
    },
    async ensureEnvironmentBrowserService(
      _runtime: EnvironmentRuntimeRecord,
      restart = false,
    ) {
      operations.push("dashboard");
      dashboardRestarts.push(restart);
      return {
        owner: "agent" as const,
        transport: "playwright" as const,
        revision: Number(restart),
        publicUrl: "https://dashboard.example.invalid",
        requestHeaders: {},
      };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  await service.ensureSession("user-browser", runtimeRecord.id);
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);
  await service.httpUpstream("user-browser", runtimeRecord.id, "index.html");

  browserRestarted = false;
  await service.ensureSession("user-browser", runtimeRecord.id);
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);
  await service.ensureSession("user-browser", runtimeRecord.id, true);
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);

  browserRestarted = true;
  await service.ensureSession("user-browser", runtimeRecord.id, true);
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);

  assert.equal(sessionEnsures, 3);
  assert.deepEqual(dashboardRestarts, [false, true, true]);
  assert.deepEqual(operations, [
    "dashboard",
    "session",
    "dashboard",
    "session",
    "dashboard",
    "session",
  ]);
});

test("refreshes invalidated coordinates without restarting the AppService", async () => {
  const dashboardRestarts: boolean[] = [];
  const runtimeAccess = {
    async withRuntimeAccess(
      _userId: string,
      _environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      return operation(runtimeRecord);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    async ensureEnvironmentBrowserService(
      _runtime: EnvironmentRuntimeRecord,
      restart = false,
    ) {
      dashboardRestarts.push(restart);
      return {
        owner: "agent" as const,
        transport: "playwright" as const,
        revision: 0,
        publicUrl: "https://dashboard.example.invalid",
        requestHeaders: {},
      };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);
  service.invalidate(runtimeRecord.id);
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);

  assert.deepEqual(dashboardRestarts, [false, false]);
});

test("admits only the transport owned by the current Browser controller", async () => {
  let owner: "agent" | "human" = "agent";
  let revision = 0;
  const runtimeAccess = {
    async withRuntimeAccess(
      _userId: string,
      _environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      return operation(runtimeRecord);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const control = () => ({
    owner,
    transport: owner === "human" ? ("vnc" as const) : ("playwright" as const),
    revision,
  });
  const runtime = {
    async updateEnvironmentBrowserControl(
      _runtime: EnvironmentRuntimeRecord,
      input: { owner: "agent" | "human" },
    ) {
      owner = input.owner;
      revision += 1;
      return control();
    },
    async ensureEnvironmentBrowserService() {
      return {
        ...control(),
        publicUrl: "https://browser.example.invalid",
        requestHeaders: {},
      };
    },
    async ensureEnvironmentBrowserSession() {
      throw new Error("human control must reject before Playwright runs");
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  assert.equal(
    (await service.control("user-browser", runtimeRecord.id)).owner,
    "agent",
  );
  assert.equal(
    (
      await service.updateControl("user-browser", runtimeRecord.id, {
        owner: "human",
      })
    ).transport,
    "vnc",
  );
  assert.deepEqual(
    await service.websocketUpstream("user-browser", runtimeRecord.id, "vnc"),
    { url: "wss://browser.example.invalid/vnc", headers: {} },
  );
  await assert.rejects(
    service.httpUpstream("user-browser", runtimeRecord.id, undefined),
    (error) =>
      error instanceof HttpError &&
      error.code === "environment_browser_under_human_control",
  );
  await assert.rejects(
    service.ensureSession("user-browser", runtimeRecord.id),
    (error) =>
      error instanceof HttpError &&
      error.code === "environment_browser_under_human_control",
  );

  await service.updateControl("user-browser", runtimeRecord.id, {
    owner: "agent",
  });
  await assert.rejects(
    service.websocketUpstream("user-browser", runtimeRecord.id, "vnc"),
    (error) =>
      error instanceof HttpError &&
      error.code === "environment_browser_under_agent_control",
  );
  assert.equal(
    (
      await service.httpUpstream("user-browser", runtimeRecord.id, undefined)
    ).url,
    "https://browser.example.invalid/",
  );
});

test("linearizes the first Browser install with a concurrent takeover", async () => {
  let owner: "agent" | "human" = "agent";
  let revision = 0;
  let releaseInstall: (() => void) | undefined;
  const installBlocked = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  let installStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    installStarted = resolve;
  });
  const events: string[] = [];
  const runtimeAccess = {
    async withRuntimeAccess(
      _userId: string,
      _environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      return operation(runtimeRecord);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const current = () => ({
    owner,
    transport: owner === "human" ? ("vnc" as const) : ("playwright" as const),
    revision,
    publicUrl: "https://browser.example.invalid",
    requestHeaders: {},
  });
  const runtime = {
    async ensureEnvironmentBrowserService() {
      events.push("install-start");
      installStarted?.();
      await installBlocked;
      events.push("install-finish");
      return current();
    },
    async updateEnvironmentBrowserControl(
      _runtime: EnvironmentRuntimeRecord,
      input: { owner: "agent" | "human" },
    ) {
      events.push("takeover");
      owner = input.owner;
      revision += 1;
      return current();
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  const initial = service.control("user-browser", runtimeRecord.id);
  await started;
  const takeover = service.updateControl("user-browser", runtimeRecord.id, {
    owner: "human",
  });
  await Promise.resolve();
  assert.deepEqual(events, ["install-start"]);

  releaseInstall?.();
  assert.equal((await initial).owner, "agent");
  assert.equal((await takeover).owner, "human");
  assert.deepEqual(events, ["install-start", "install-finish", "takeover"]);
  assert.equal(
    (await service.control("user-browser", runtimeRecord.id)).owner,
    "human",
  );
});

test("deduplicates viewport updates within one runtime generation", async () => {
  const calls: Array<{
    runtime: EnvironmentRuntimeRecord;
    width: number;
    height: number;
  }> = [];
  const runtimeAccess = {
    async withRuntimeAccess(
      userId: string,
      environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      assert.equal(userId, "user-browser");
      assert.equal(environmentId, runtimeRecord.id);
      return operation(runtimeRecord);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    async ensureEnvironmentBrowserService() {
      return {
        owner: "agent" as const,
        transport: "playwright" as const,
        revision: 0,
        publicUrl: "https://dashboard.example.invalid",
        requestHeaders: {},
      };
    },
    async resizeEnvironmentBrowserViewport(
      runtime: EnvironmentRuntimeRecord,
      viewport: { width: number; height: number },
    ) {
      calls.push({ runtime, ...viewport });
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  await service.resizeViewport("user-browser", runtimeRecord.id, {
    width: 519,
    height: 759,
  });
  await service.resizeViewport("user-browser", runtimeRecord.id, {
    width: 519,
    height: 759,
  });

  assert.deepEqual(calls, [
    {
      runtime: runtimeRecord,
      width: 519,
      height: 759,
    },
  ]);
});

test("coalesces intermediate viewport updates while one resize is running", async () => {
  const calls: BrowserDashboardViewport[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstResize = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const runtimeAccess = {
    async withRuntimeAccess(
      _userId: string,
      _environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      return operation(runtimeRecord);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    async ensureEnvironmentBrowserService() {
      return {
        owner: "agent" as const,
        transport: "playwright" as const,
        revision: 0,
        publicUrl: "https://dashboard.example.invalid",
        requestHeaders: {},
      };
    },
    async resizeEnvironmentBrowserViewport(
      _runtime: EnvironmentRuntimeRecord,
      viewport: BrowserDashboardViewport,
    ) {
      calls.push(viewport);
      if (calls.length === 1) await firstResize;
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  const first = service.resizeViewport("user-browser", runtimeRecord.id, {
    width: 500,
    height: 700,
  });
  const middle = service.resizeViewport("user-browser", runtimeRecord.id, {
    width: 600,
    height: 700,
  });
  const latest = service.resizeViewport("user-browser", runtimeRecord.id, {
    width: 700,
    height: 700,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ width: 500, height: 700 }]);
  releaseFirst?.();
  await Promise.all([first, middle, latest]);
  assert.deepEqual(calls, [
    { width: 500, height: 700 },
    { width: 700, height: 700 },
  ]);
});

test("refreshes Dashboard coordinates after the runtime generation changes", async () => {
  let currentRuntime = runtimeRecord;
  let dashboardEnsures = 0;
  const runtimeAccess = {
    async withRuntimeAccess(
      _userId: string,
      _environmentId: string,
      operation: (runtime: EnvironmentRuntimeRecord) => Promise<unknown>,
    ) {
      return operation(currentRuntime);
    },
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    async ensureEnvironmentBrowserService() {
      dashboardEnsures += 1;
      return {
        owner: "agent" as const,
        transport: "playwright" as const,
        revision: 0,
        publicUrl: "https://dashboard.example.invalid",
        requestHeaders: {},
      };
    },
  } as unknown as RuntimeAdapter;
  const service = new EnvironmentBrowserService(runtimeAccess, runtime);

  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);
  currentRuntime = {
    ...runtimeRecord,
    runtimeGeneration: runtimeRecord.runtimeGeneration + 1,
  };
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);

  assert.equal(dashboardEnsures, 2);
});

test("maps only official Dashboard static paths", () => {
  assert.equal(dashboardAssetPath(undefined), "/");
  assert.equal(dashboardAssetPath("index.html"), "/index.html");
  assert.equal(
    dashboardAssetPath("assets/index-BY2S1tHT.css"),
    "/assets/index-BY2S1tHT.css",
  );
  assert.throws(() => dashboardAssetPath("../credential"));
  assert.throws(() => dashboardAssetPath("other/runtime.json"));
});

test("caches only static Dashboard assets with bounded private freshness", () => {
  assert.equal(
    dashboardAssetCacheControl(undefined, "public, max-age=14400"),
    "private, no-store",
  );
  assert.equal(
    dashboardAssetCacheControl("index.html", "public, max-age=14400"),
    "private, no-store",
  );
  assert.equal(
    dashboardAssetCacheControl(
      "assets/index-BY2S1tHT.css",
      "public, max-age=14400",
    ),
    "private, max-age=86400, immutable",
  );
  assert.equal(
    dashboardAssetCacheControl(
      "playwright-logo.svg",
      "public, max-age=999999",
    ),
    "private, max-age=86400",
  );
  assert.equal(
    dashboardAssetCacheControl("assets/runtime.js", null),
    "private, max-age=3600",
  );
});

test("rewrites the official Dashboard redirect and root-relative assets", () => {
  const prefix = dashboardProxyPrefix("environment one");
  assert.equal(
    dashboardRedirectLocation("/index.html?ws=socket-guid", prefix),
    "/api/v1/environments/environment%20one/browser/index.html?ws=api%2Fv1%2Fenvironments%2Fenvironment%2520one%2Fbrowser%2Fws%2Fsocket-guid",
  );
  assert.equal(
    rewriteDashboardHtml(
      '<script src="/assets/app.js"></script><link href="/playwright-logo.svg">',
      prefix,
    ),
    '<script src="/api/v1/environments/environment%20one/browser/assets/app.js"></script><link href="/api/v1/environments/environment%20one/browser/playwright-logo.svg">',
  );
  assert.equal(
    rewriteDashboardCss(
      '@font-face{src:url(/assets/codicon.ttf)}.external{src:url("https://example.com/font.woff2")}',
      prefix,
    ),
    '@font-face{src:url(/api/v1/environments/environment%20one/browser/assets/codicon.ttf)}.external{src:url("https://example.com/font.woff2")}',
  );
});

test("embeds Sandpi layout and theme control into the official Dashboard", () => {
  const rewritten = rewriteDashboardHtml(
    `<!doctype html>
<html>
  <head>
    <script type="module" src="/assets/index.js"></script>
    <link rel="stylesheet" href="/assets/index.css">
  </head>
  <body><div id="root"></div></body>
</html>`,
    "/api/v1/environments/environment/browser",
  );

  assert.match(rewritten, /data-sandpi-browser-dashboard/);
  assert.match(rewritten, /sandpi:browser-dashboard-ready/);
  assert.match(rewritten, /sandpi:browser-dashboard-theme/);
  assert.match(
    rewritten,
    /#root > \.split-view\.horizontal\.sidebar-first > \.split-view-sidebar/,
  );
  assert.match(rewritten, /\.browser-window \{/);
  assert.match(rewritten, /width: 100% !important/);
  assert.match(rewritten, /--color-canvas-default/);
  assert.match(
    rewritten,
    /src="\/api\/v1\/environments\/environment\/browser\/assets\/index\.js"/,
  );
  assert.match(
    rewritten,
    /href="\/api\/v1\/environments\/environment\/browser\/assets\/index\.css"/,
  );
});

test("rejects redirects that are not Dashboard socket handoffs", () => {
  assert.equal(
    dashboardRedirectLocation("https://example.com/index.html?ws=socket", "/browser"),
    "/browser/index.html?ws=browser%2Fws%2Fsocket",
  );
  assert.equal(
    dashboardRedirectLocation("/elsewhere?ws=socket", "/browser"),
    undefined,
  );
  assert.equal(
    dashboardRedirectLocation("/index.html?ws=../../socket", "/browser"),
    undefined,
  );
});
