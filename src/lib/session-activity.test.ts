import assert from "node:assert/strict";
import test from "node:test";

import { sessionActivityMarker } from "./session-activity";

test("shows a running marker while a Session has an active Turn", () => {
  assert.equal(
    sessionActivityMarker({ status: "running", unread: false }),
    "running",
  );
});

test("running takes precedence over unread activity in the single marker slot", () => {
  assert.equal(
    sessionActivityMarker({ status: "running", unread: true }),
    "running",
  );
  assert.equal(
    sessionActivityMarker({ status: "waiting", unread: true }),
    "unread",
  );
  assert.equal(
    sessionActivityMarker({ status: "waiting", unread: false }),
    undefined,
  );
});
