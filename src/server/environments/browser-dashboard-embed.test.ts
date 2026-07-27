import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_DASHBOARD_EMBED_MARKER,
  BROWSER_DASHBOARD_EMBED_SCRIPT,
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
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /sessionObserver\.disconnect/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /liveFrameMatchesViewport/);
  assert.match(BROWSER_DASHBOARD_EMBED_SCRIPT, /crossProductDifference/);
});

test("reports the live screen bounds and waits for the resized frame", () => {
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
});
