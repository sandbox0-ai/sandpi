import assert from "node:assert/strict";
import test from "node:test";

import { reconcileTerminalReplayCursor } from "./terminal-replay";

test("keeps a terminal cursor that is still inside the retained window", () => {
  assert.deepEqual(
    reconcileTerminalReplayCursor(240, { earliest: 200, latest: 300 }),
    { after: 240, reset: false },
  );
  assert.deepEqual(
    reconcileTerminalReplayCursor(0, { earliest: 1, latest: 20 }),
    { after: 0, reset: false },
  );
});

test("rebuilds from the retained tail when the browser cursor expired", () => {
  assert.deepEqual(
    reconcileTerminalReplayCursor(0, { earliest: 200, latest: 300 }),
    { after: 199, reset: true },
  );
});

test("rebuilds when the browser cursor belongs to a replaced journal", () => {
  assert.deepEqual(
    reconcileTerminalReplayCursor(500, { earliest: 200, latest: 300 }),
    { after: 199, reset: true },
  );
  assert.deepEqual(
    reconcileTerminalReplayCursor(80, { earliest: 81, latest: 80 }),
    { after: 80, reset: false },
  );
  assert.deepEqual(
    reconcileTerminalReplayCursor(
      250,
      { earliest: 200, latest: 300 },
      true,
    ),
    { after: 199, reset: true },
  );
});
