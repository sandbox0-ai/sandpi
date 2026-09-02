import assert from "node:assert/strict";
import test from "node:test";

import {
  isCurrentTerminalExit,
  terminalConnectionLabel,
} from "./use-terminal-session";

test("ignores a replayed exit event from an older terminal attempt", () => {
  assert.equal(
    isCurrentTerminalExit(
      { type: "attempt.exited", attemptId: "attempt-old" },
      "attempt-current",
    ),
    false,
  );
  assert.equal(
    isCurrentTerminalExit(
      { type: "attempt.exited", attemptId: "attempt-current" },
      "attempt-current",
    ),
    true,
  );
});

test("accepts the legacy unscoped exit event and exposes recovery labels", () => {
  assert.equal(isCurrentTerminalExit({ type: "exit" }, "attempt-current"), true);
  assert.equal(terminalConnectionLabel("disconnected"), "reconnecting");
  assert.equal(terminalConnectionLabel("restoring"), "restoring screen");
  assert.equal(terminalConnectionLabel("waiting"), "waiting for Environment");
  assert.equal(terminalConnectionLabel("exited"), "process exited");
});
