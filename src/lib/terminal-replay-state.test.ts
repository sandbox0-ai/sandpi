import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceTerminalSequence,
  parseTerminalReplayState,
  rememberTerminalCommand,
  resetTerminalReplay,
  terminalReplayAfter,
} from "./terminal-replay-state";

test("replays from the oldest of the last three submitted commands", () => {
  let state = parseTerminalReplayState(null);
  state = advanceTerminalSequence(state, 10);
  for (const sequence of [10, 20, 30, 40]) {
    state = rememberTerminalCommand(state, sequence);
    state = advanceTerminalSequence(state, sequence + 5);
  }
  assert.deepEqual(state.commandStartSequences, [20, 30, 40]);
  assert.equal(state.lastSequence, 45);
  assert.equal(terminalReplayAfter(state), 20);
});

test("uses the latest sequence when no command history should be replayed", () => {
  const state = resetTerminalReplay(
    {
      terminalSessionId: "ses-terminal",
      lastSequence: 90,
      commandStartSequences: [10, 20, 30],
    },
    90,
  );
  assert.deepEqual(state.commandStartSequences, []);
  assert.equal(terminalReplayAfter(state), 90);
});

test("rejects malformed or forward command cursors from client storage", () => {
  assert.deepEqual(parseTerminalReplayState("not-json"), {
    lastSequence: 0,
    commandStartSequences: [],
  });
  assert.deepEqual(
    parseTerminalReplayState(
      JSON.stringify({
        terminalSessionId: "ses-terminal",
        lastSequence: 12,
        commandStartSequences: [-1, 4, 20, "8"],
      }),
    ),
    {
      terminalSessionId: "ses-terminal",
      lastSequence: 12,
      commandStartSequences: [4],
    },
  );
});
