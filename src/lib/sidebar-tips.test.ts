import assert from "node:assert/strict";
import test from "node:test";

import { firstVisibleSidebarTip, sidebarTips } from "./sidebar-tips";

test("keeps Sidebar Tip ids unique and migration prompts agent-oriented", () => {
  for (const language of ["en", "zh-CN"] as const) {
    const tips = sidebarTips(language);
    assert.equal(new Set(tips.map(({ id }) => id)).size, tips.length);
    assert.match(tips[0]?.prompt ?? "", /sandpi\.ai\/llms\.txt/);
    assert.match(tips[0]?.prompt ?? "", /Sandpi CLI/);
  }
});

test("selects the first Sidebar Tip that has not been dismissed", () => {
  const tip = firstVisibleSidebarTip("en", []);
  assert.ok(tip);
  assert.equal(firstVisibleSidebarTip("en", [tip.id]), undefined);
});
