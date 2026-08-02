import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  BROWSER_DASHBOARD_EMBED_MARKER,
  BROWSER_DASHBOARD_EMBED_SCRIPT,
  BROWSER_DASHBOARD_EMBED_STYLE,
  BROWSER_DASHBOARD_WEBSOCKET_COMPAT_SCRIPT,
  embedBrowserDashboard,
} from "./browser-dashboard-embed";

test("embeds once before the Dashboard head closes", () => {
  const html =
    "<!doctype html><html><head><title>Playwright Dashboard</title></head><body></body></html>";
  const embedded = embedBrowserDashboard(html);

  assert.ok(embedded.indexOf(BROWSER_DASHBOARD_EMBED_MARKER) > 0);
  assert.ok(
    embedded.indexOf(BROWSER_DASHBOARD_EMBED_MARKER) <
      embedded.indexOf("</head>"),
  );
  assert.equal(
    embedBrowserDashboard(embedded).match(
      new RegExp(BROWSER_DASHBOARD_EMBED_MARKER, "g"),
    )?.length,
    2,
  );
});

test("leaves an unrecognized Dashboard document untouched", () => {
  const html = "<main>Dashboard unavailable</main>";
  assert.equal(embedBrowserDashboard(html), html);
});

test("resolves relative Dashboard WebSocket URLs for older WebViews", () => {
  const opened: Array<{ url: string; protocols?: string | string[] }> = [];
  class NativeWebSocket {
    static readonly CONNECTING = 0;

    constructor(url: string, protocols?: string | string[]) {
      opened.push({ url, protocols });
    }
  }
  const window = {
    location: {
      href: "https://sandpi.ai/api/v1/environments/env-1/browser/index.html",
    },
    WebSocket: NativeWebSocket,
  };
  const context = vm.createContext({ URL, window });

  vm.runInContext(BROWSER_DASHBOARD_WEBSOCKET_COMPAT_SCRIPT, context);
  const CompatibleWebSocket = window.WebSocket;
  new CompatibleWebSocket("/api/v1/environments/env-1/browser/ws/socket");
  new CompatibleWebSocket("wss://browser.example/socket", ["v1"]);

  assert.deepEqual(opened, [
    {
      url: "wss://sandpi.ai/api/v1/environments/env-1/browser/ws/socket",
      protocols: undefined,
    },
    {
      url: "wss://browser.example/socket",
      protocols: ["v1"],
    },
  ]);
  assert.equal(CompatibleWebSocket.CONNECTING, NativeWebSocket.CONNECTING);
  assert.equal(
    (
      CompatibleWebSocket as typeof NativeWebSocket & {
        __sandpiRelativeUrlCompatibility?: boolean;
      }
    ).__sandpiRelativeUrlCompatibility,
    true,
  );

  vm.runInContext(BROWSER_DASHBOARD_WEBSOCKET_COMPAT_SCRIPT, context);
  assert.equal(window.WebSocket, CompatibleWebSocket);
});

test("selects the shared default session before announcing readiness", () => {
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /"sessionName":"default"/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /\.session-chip-name/);
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /\[role="option"\]\[aria-selected="true"\]/,
  );
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /firstTab\.click\(\)/);
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi:browser-dashboard-session-ready/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /screenBounds\.width > 0/,
  );
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /screenBounds\.height > 0/);
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi-browser-dashboard-ready/,
  );
  assert.doesNotMatch(BROWSER_DASHBOARD_EMBED_SCRIPT, /setTimeout/);
});

test("reports a bounded viewport that matches the visible screen", () => {
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /new ResizeObserver/);
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /new ResizeObserver\(\(\) => \{[\s\S]*selectDefaultSession\(\)/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /observedScreen\.getBoundingClientRect\(\)/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi:browser-dashboard-viewport/,
  );
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /desiredViewport\?\.width/);
  assert.doesNotMatch(BROWSER_DASHBOARD_EMBED_SCRIPT, /viewportMode|mobile/);
});

test("keeps the embedded Dashboard hidden until the read-only shape is ready", () => {
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /#root \{[\s\S]*visibility: hidden/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /sandpi-browser-dashboard-ready #root[\s\S]*visibility: visible/,
  );
});

test("removes every native Dashboard interaction surface", () => {
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /\.dashboard-main > \.toolbar/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /\.browser-window > \.browser-chrome/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /\.dashboard-view > :not\(\.dashboard-main\)/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /\.split-view-sidebar[\s\S]*display: none !important/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /\.screen,[\s\S]*\.screen-overlay[\s\S]*pointer-events: none !important/,
  );
  assert.doesNotMatch(BROWSER_DASHBOARD_EMBED_SCRIPT, /commandMessage|newTab/);
});
