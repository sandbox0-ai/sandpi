import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_DASHBOARD_READY_MESSAGE,
  BROWSER_DASHBOARD_SESSION_NAME,
  BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  isBrowserDashboardReadyMessage,
  isBrowserDashboardSessionReadyMessage,
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
  assert.equal(BROWSER_DASHBOARD_SESSION_NAME, "default");
  assert.deepEqual(BROWSER_DASHBOARD_THEME_TOKEN_MAP["--canvas"], [
    "--color-canvas-default",
  ]);
  assert.deepEqual(BROWSER_DASHBOARD_THEME_TOKEN_MAP["--line"], [
    "--color-border-default",
    "--vscode-panel-border",
  ]);
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
