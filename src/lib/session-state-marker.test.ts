import assert from "node:assert/strict";
import test from "node:test";

import { sessionStateMarker } from "./session-state-marker";

test("shows a running marker while a Session has an active Turn", () => {
  assert.equal(
    sessionStateMarker({ status: "running", unread: false, completed: false }),
    "running",
  );
});

test("running takes precedence over unread activity in the single marker slot", () => {
  assert.equal(
    sessionStateMarker({ status: "running", unread: true, completed: false }),
    "running",
  );
  assert.equal(
    sessionStateMarker({ status: "waiting", unread: true, completed: false }),
    "unread",
  );
  assert.equal(
    sessionStateMarker({ status: "waiting", unread: false, completed: false }),
    undefined,
  );
});

test("keeps a completed Session quiet even if it has unread activity", () => {
  assert.equal(
    sessionStateMarker({ status: "waiting", unread: true, completed: true }),
    undefined,
  );
});
