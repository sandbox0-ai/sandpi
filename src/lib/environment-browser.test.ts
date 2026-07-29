import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_DASHBOARD_LOADING_MESSAGE,
  BROWSER_DASHBOARD_READY_MESSAGE,
  BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  BROWSER_DASHBOARD_VIEWPORT_LIMITS,
  BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
  isBrowserDashboardLoadingMessage,
  isBrowserDashboardReadyMessage,
  isBrowserDashboardSessionReadyMessage,
  isBrowserDashboardViewport,
  isBrowserDashboardViewportMessage,
  isBrowserDashboardViewportMode,
  resolveBrowserDashboardViewport,
  sandboxLoopbackUrl,
} from "./environment-browser";

test("recognizes only the embedded Dashboard ready message", () => {
  assert.equal(
    isBrowserDashboardReadyMessage({
      type: BROWSER_DASHBOARD_READY_MESSAGE,
    }),
    true,
  );
  assert.equal(
    isBrowserDashboardReadyMessage({
      type: "sandpi:browser-dashboard-theme",
    }),
    false,
  );
  assert.equal(isBrowserDashboardReadyMessage(null), false);
  assert.equal(
    isBrowserDashboardSessionReadyMessage({
      type: BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
    }),
    true,
  );
  assert.equal(
    isBrowserDashboardSessionReadyMessage({
      type: BROWSER_DASHBOARD_READY_MESSAGE,
    }),
    false,
  );
  assert.deepEqual(BROWSER_DASHBOARD_THEME_TOKEN_MAP["--canvas"], [
    "--color-canvas-default",
  ]);
  assert.deepEqual(BROWSER_DASHBOARD_THEME_TOKEN_MAP["--line"], [
    "--color-border-default",
    "--vscode-panel-border",
  ]);
});

test("accepts only bounded integer Dashboard viewport messages", () => {
  assert.equal(
    isBrowserDashboardViewportMessage({
      type: BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
      width: 519,
      height: 759,
    }),
    true,
  );
  assert.equal(
    isBrowserDashboardViewport({
      width: BROWSER_DASHBOARD_VIEWPORT_LIMITS.minWidth,
      height: BROWSER_DASHBOARD_VIEWPORT_LIMITS.minHeight,
    }),
    true,
  );
  assert.equal(
    isBrowserDashboardViewport({
      width: BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxWidth,
      height: BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxHeight,
    }),
    true,
  );
  assert.equal(
    isBrowserDashboardViewportMessage({
      type: BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
      width: 518.5,
      height: 759,
    }),
    false,
  );
  assert.equal(
    isBrowserDashboardViewportMessage({
      type: BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
      width: BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxWidth + 1,
      height: 759,
    }),
    false,
  );
  assert.equal(
    isBrowserDashboardViewportMessage({
      type: BROWSER_DASHBOARD_READY_MESSAGE,
      width: 519,
      height: 759,
    }),
    false,
  );
});

test("resolves responsive, desktop-fit and mobile browser viewports", () => {
  assert.equal(isBrowserDashboardViewportMode("desktop"), true);
  assert.equal(isBrowserDashboardViewportMode("television"), false);
  assert.deepEqual(
    resolveBrowserDashboardViewport(
      { width: 1_000, height: 700 },
      "responsive",
    ),
    { width: 1_000, height: 700 },
  );
  assert.deepEqual(
    resolveBrowserDashboardViewport(
      { width: 1_000, height: 700 },
      "desktop",
    ),
    { width: 1_280, height: 896 },
  );
  assert.deepEqual(
    resolveBrowserDashboardViewport(
      { width: 600, height: 800 },
      "desktop",
    ),
    { width: 1_280, height: 1_707 },
  );
  assert.deepEqual(
    resolveBrowserDashboardViewport(
      { width: 1_000, height: 700 },
      "mobile",
    ),
    { width: 390, height: 844 },
  );
});

test("accepts only bounded browser loading messages", () => {
  assert.equal(
    isBrowserDashboardLoadingMessage({
      type: BROWSER_DASHBOARD_LOADING_MESSAGE,
      loading: true,
    }),
    true,
  );
  assert.equal(
    isBrowserDashboardLoadingMessage({
      type: BROWSER_DASHBOARD_LOADING_MESSAGE,
      loading: "yes",
    }),
    false,
  );
});

test("accepts HTTP loopback URLs that the Environment browser can reach", () => {
  assert.equal(
    sandboxLoopbackUrl("http://localhost:3000/dashboard?mode=debug#result"),
    "http://localhost:3000/dashboard?mode=debug#result",
  );
  assert.equal(
    sandboxLoopbackUrl("https://127.0.0.1:8443"),
    "https://127.0.0.1:8443/",
  );
  assert.equal(
    sandboxLoopbackUrl("http://[::1]:4173/"),
    "http://[::1]:4173/",
  );
  assert.equal(
    sandboxLoopbackUrl("localhost:3000/dashboard"),
    "http://localhost:3000/dashboard",
  );
  assert.equal(
    sandboxLoopbackUrl("127.0.0.1:8080/health"),
    "http://127.0.0.1:8080/health",
  );
});

test("rejects external, credential-bearing and non-HTTP URLs", () => {
  assert.equal(sandboxLoopbackUrl("https://example.com"), undefined);
  assert.equal(
    sandboxLoopbackUrl("http://user:password@localhost:3000"),
    undefined,
  );
  assert.equal(sandboxLoopbackUrl("file:///workspace/index.html"), undefined);
  assert.equal(sandboxLoopbackUrl("localhost.example.com:3000"), undefined);
  assert.equal(sandboxLoopbackUrl("not a url"), undefined);
});
