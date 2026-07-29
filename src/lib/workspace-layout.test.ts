import assert from "node:assert/strict";
import test from "node:test";

import {
  clampFileBrowserSidebarWidthForAvailableWidth,
  clampInspectorWidthRatioForAvailableWidth,
  DEFAULT_FILE_BROWSER_SIDEBAR_WIDTH,
  DEFAULT_INSPECTOR_WIDTH_RATIO,
  fileBrowserSidebarWidthFromPointer,
  inspectorWidthRatioFromPointer,
  normalizeFileBrowserSidebarWidth,
  normalizeInspectorWidthRatio,
} from "./workspace-layout";

test("normalizes persisted Inspector width ratios", () => {
  assert.equal(
    normalizeInspectorWidthRatio(undefined),
    DEFAULT_INSPECTOR_WIDTH_RATIO,
  );
  assert.equal(
    normalizeInspectorWidthRatio(Number.NaN),
    DEFAULT_INSPECTOR_WIDTH_RATIO,
  );
  assert.equal(normalizeInspectorWidthRatio(0.625), 0.625);
  assert.equal(normalizeInspectorWidthRatio(0.05), 0.2);
  assert.equal(normalizeInspectorWidthRatio(0.95), 0.8);
});

test("derives the same split from expanded and collapsed Sidebar layouts", () => {
  assert.equal(
    inspectorWidthRatioFromPointer({
      pointerX: 846,
      shellLeft: 0,
      shellWidth: 1_440,
      sidebarWidth: 252,
    }),
    0.5,
  );
  assert.equal(
    inspectorWidthRatioFromPointer({
      pointerX: 720,
      shellLeft: 0,
      shellWidth: 1_440,
      sidebarWidth: 0,
    }),
    0.5,
  );
});

test("keeps both workspace panes usable while dragging", () => {
  assert.equal(
    clampInspectorWidthRatioForAvailableWidth(0.8, 1_188),
    0.697,
  );
  assert.equal(
    clampInspectorWidthRatioForAvailableWidth(0.2, 741),
    0.4858,
  );
});

test("normalizes persisted file browser sidebar widths", () => {
  assert.equal(
    normalizeFileBrowserSidebarWidth(undefined),
    DEFAULT_FILE_BROWSER_SIDEBAR_WIDTH,
  );
  assert.equal(
    normalizeFileBrowserSidebarWidth(Number.NaN),
    DEFAULT_FILE_BROWSER_SIDEBAR_WIDTH,
  );
  assert.equal(normalizeFileBrowserSidebarWidth(287.6), 288);
  assert.equal(normalizeFileBrowserSidebarWidth(40), 160);
  assert.equal(normalizeFileBrowserSidebarWidth(900), 480);
});

test("keeps the file browser and editor usable while dragging", () => {
  assert.equal(
    clampFileBrowserSidebarWidthForAvailableWidth(480, 594),
    346,
  );
  assert.equal(
    clampFileBrowserSidebarWidthForAvailableWidth(160, 360),
    160,
  );
  assert.equal(
    clampFileBrowserSidebarWidthForAvailableWidth(240, 300),
    146,
  );
  assert.equal(
    fileBrowserSidebarWidthFromPointer({
      pointerX: 328,
      workbenchLeft: 40,
      workbenchWidth: 800,
    }),
    288,
  );
});
