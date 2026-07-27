import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_DASHBOARD_EMBED_MARKER,
  BROWSER_DASHBOARD_EMBED_SCRIPT,
  BROWSER_DASHBOARD_EMBED_STYLE,
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

test("selects the shared default session before announcing a live frame", () => {
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
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /liveFrameMatchesViewport/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /crossProductDifference/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /setTimeout\(\(\) => \{/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /5_000/);
});

test("reports a mode-aware viewport and waits for the resized frame", () => {
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /new ResizeObserver/);
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /observedScreen\.getBoundingClientRect\(\)/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi:browser-dashboard-viewport/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi:browser-dashboard-viewport-applied/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /desiredViewport\.width === appliedViewport\.width/,
  );
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /desktopMinimumWidth/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /viewportMode === "mobile"/);
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi:browser-dashboard-viewport-mode/,
  );
});

test("adapts native tabs and loading without patching Playwright assets", () => {
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /collectTabs/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /sandpi:browser-dashboard-tabs/);
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi:browser-dashboard-command/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /sandpi:browser-dashboard-loading/,
  );
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /finishLoadingAfterFrame/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /target\.click\(\)/);
});

test("hides the native sidebar only after compatibility is detected", () => {
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /\.sandpi-browser-dashboard-integrated/,
  );
  assert.match(
    BROWSER_DASHBOARD_EMBED_SCRIPT,
    /root\.classList\.toggle\([\s\S]*sandpi-browser-dashboard-integrated/,
  );
});
