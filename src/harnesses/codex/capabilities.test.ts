import assert from "node:assert/strict";
import test from "node:test";

import { codexTurnCapabilitySets } from "./capabilities";
import type { CodexNativeSnapshot } from "./types";

const snapshot = {
  forkableTurnIds: ["turn-output-only", "turn-both"],
  mutableTurnIds: ["turn-input-only", "turn-both"],
} as CodexNativeSnapshot;

test("keeps Codex Turn fork and mutation capabilities independent", () => {
  const capabilities = codexTurnCapabilitySets(snapshot);

  assert.equal(capabilities.forkableTurnIds.has("turn-output-only"), true);
  assert.equal(capabilities.mutableTurnIds.has("turn-output-only"), false);
  assert.equal(capabilities.forkableTurnIds.has("turn-input-only"), false);
  assert.equal(capabilities.mutableTurnIds.has("turn-input-only"), true);
  assert.equal(capabilities.forkableTurnIds.has("turn-both"), true);
  assert.equal(capabilities.mutableTurnIds.has("turn-both"), true);
});

test("starts with no destructive capability before the native snapshot", () => {
  const capabilities = codexTurnCapabilitySets(null);
  assert.equal(capabilities.forkableTurnIds.size, 0);
  assert.equal(capabilities.mutableTurnIds.size, 0);
});
