import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvironmentBrowserService,
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
    async ensureEnvironmentBrowserDashboard(
      runtime: EnvironmentRuntimeRecord,
    ) {
      assert.equal(runtime, runtimeRecord);
      dashboardEnsures += 1;
      return {
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
});

test("restarts the Dashboard only after the shared browser is restarted", async () => {
  const dashboardRevisions: number[] = [];
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
      return browserRestarted;
    },
    async ensureEnvironmentBrowserDashboard(
      _runtime: EnvironmentRuntimeRecord,
      sessionRevision: number,
    ) {
      dashboardRevisions.push(sessionRevision);
      return {
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

  browserRestarted = true;
  await service.ensureSession("user-browser", runtimeRecord.id);
  await service.httpUpstream("user-browser", runtimeRecord.id, undefined);

  assert.deepEqual(dashboardRevisions, [1, 2]);
});

test("resizes the shared browser through protected runtime access", async () => {
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

  assert.deepEqual(calls, [
    {
      runtime: runtimeRecord,
      width: 519,
      height: 759,
    },
  ]);
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
