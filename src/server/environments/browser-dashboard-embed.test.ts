import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_DASHBOARD_EMBED_MARKER,
  BROWSER_DASHBOARD_EMBED_STYLE,
  browserDashboardEmbedScript,
  embedBrowserDashboard,
} from "./browser-dashboard-embed";

const browserSessionName = `sandpi-${"a".repeat(32)}`;
const embedScript = browserDashboardEmbedScript(browserSessionName);

test("embeds once before the Dashboard head closes", () => {
  const html =
    "<!doctype html><html><head><title>Playwright Dashboard</title></head><body></body></html>";
  const embedded = embedBrowserDashboard(html, browserSessionName);

  assert.ok(embedded.indexOf(BROWSER_DASHBOARD_EMBED_MARKER) > 0);
  assert.ok(
    embedded.indexOf(BROWSER_DASHBOARD_EMBED_MARKER) <
      embedded.indexOf("</head>"),
  );
  assert.equal(
    embedBrowserDashboard(embedded, browserSessionName).match(
      new RegExp(BROWSER_DASHBOARD_EMBED_MARKER, "g"),
    )?.length,
    2,
  );
});

test("leaves an unrecognized Dashboard document untouched", () => {
  const html = "<main>Dashboard unavailable</main>";
  assert.equal(embedBrowserDashboard(html, browserSessionName), html);
});

test("selects the requested Session page before announcing readiness", () => {
  assert.match(embedScript, new RegExp(`"sessionName":"${browserSessionName}"`));
  assert.match(embedScript, /\.session-chip-name/);
  assert.match(
    embedScript,
    /\[role="option"\]\[aria-selected="true"\]/,
  );
  assert.match(embedScript, /firstTab\.click\(\)/);
  assert.match(
    embedScript,
    /sandpi:browser-dashboard-session-ready/,
  );
  assert.match(
    embedScript,
    /if \(!sessionReady && session && firstTab\)/,
  );
  assert.doesNotMatch(
    embedScript,
    /liveFrameMatchesViewport|crossProductDifference/,
  );
  assert.doesNotMatch(embedScript, /setTimeout\(\(\) => \{[\s\S]+sessionReady/);
  assert.throws(() => browserDashboardEmbedScript("default"));
});

test("reports a mode-aware viewport without blocking Dashboard readiness", () => {
  assert.match(embedScript, /new ResizeObserver/);
  assert.match(
    embedScript,
    /observedScreen\.getBoundingClientRect\(\)/,
  );
  assert.match(
    embedScript,
    /sandpi:browser-dashboard-viewport/,
  );
  assert.match(
    embedScript,
    /sandpi:browser-dashboard-viewport-applied/,
  );
  assert.match(embedScript, /desiredViewport\?\.width/);
  assert.doesNotMatch(embedScript, /appliedViewport/);
  assert.match(embedScript, /desktopMinimumWidth/);
  assert.match(embedScript, /viewportMode === "mobile"/);
  assert.match(
    embedScript,
    /sandpi:browser-dashboard-viewport-mode/,
  );
});

test("keeps loading feedback without projecting multi-tab controls", () => {
  assert.doesNotMatch(embedScript, /collectTabs/);
  assert.doesNotMatch(embedScript, /sandpi:browser-dashboard-tabs/);
  assert.doesNotMatch(embedScript, /sandpi:browser-dashboard-command/);
  assert.match(
    embedScript,
    /sandpi:browser-dashboard-loading/,
  );
  assert.match(embedScript, /finishLoadingAfterFrame/);
  assert.doesNotMatch(embedScript, /sidebar-session-new-tab|sidebar-tab-close/);
});

test("hides the native sidebar only after compatibility is detected", () => {
  assert.match(
    BROWSER_DASHBOARD_EMBED_STYLE,
    /\.sandpi-browser-dashboard-integrated/,
  );
  assert.match(
    embedScript,
    /root\.classList\.toggle\([\s\S]*sandpi-browser-dashboard-integrated/,
  );
});
