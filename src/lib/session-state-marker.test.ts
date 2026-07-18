import assert from "node:assert/strict";
import test from "node:test";

import { sessionStateMarker } from "./session-state-marker";

test("shows a running marker while a Session has an active Turn", () => {
  assert.equal(
    sessionStateMarker({ status: "running", unread: false }),
    "running",
  );
});

test("running takes precedence over unread activity in the single marker slot", () => {
  assert.equal(
    sessionStateMarker({ status: "running", unread: true }),
    "running",
  );
  assert.equal(
    sessionStateMarker({ status: "waiting", unread: true }),
    "unread",
  );
  assert.equal(
    sessionStateMarker({ status: "waiting", unread: false }),
    undefined,
  );
});
