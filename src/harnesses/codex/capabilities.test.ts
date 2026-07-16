import assert from "node:assert/strict";
import test from "node:test";

import { codexTurnCapabilitySets } from "./capabilities";
import type { CodexNativeSnapshot } from "./types";

const snapshot = {
  forkableTurnIds: ["turn-one", "turn-two"],
} as CodexNativeSnapshot;

test("projects Codex Turn fork capabilities", () => {
  const capabilities = codexTurnCapabilitySets(snapshot);

  assert.equal(capabilities.forkableTurnIds.has("turn-one"), true);
  assert.equal(capabilities.forkableTurnIds.has("turn-two"), true);
});

test("starts with no fork capability before the native snapshot", () => {
  const capabilities = codexTurnCapabilitySets(null);
  assert.equal(capabilities.forkableTurnIds.size, 0);
});
