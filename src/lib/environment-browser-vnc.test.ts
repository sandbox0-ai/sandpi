import assert from "node:assert/strict";
import test from "node:test";

import { configureEnvironmentBrowserRfb } from "./environment-browser-vnc";

test("requests the human-control panel size with scaling as a legacy fallback", () => {
  const rfb = {
    scaleViewport: false,
    resizeSession: false,
    focusOnClick: false,
    showDotCursor: false,
    qualityLevel: 0,
    compressionLevel: 0,
  };

  configureEnvironmentBrowserRfb(rfb);

  assert.deepEqual(rfb, {
    scaleViewport: true,
    resizeSession: true,
    focusOnClick: true,
    showDotCursor: true,
    qualityLevel: 6,
    compressionLevel: 2,
  });
});
