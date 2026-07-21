import assert from "node:assert/strict";
import test from "node:test";

import type { CodingSession } from "./types";
import { visibleSessionsForEnvironment } from "./session-list";

function session(
  id: string,
  environmentId: string,
  pinned = false,
  archived = false,
): CodingSession {
  return { id, environmentId, pinned, archived } as CodingSession;
}

test("orders the viewer's personal pins within each Environment", () => {
  const sessions = [
    session("a-1", "env-a"),
    session("b-pinned", "env-b", true),
    session("a-pinned", "env-a", true),
    session("a-archived", "env-a", true, true),
    session("a-2", "env-a"),
  ];

  assert.deepEqual(
    visibleSessionsForEnvironment(sessions, "env-a").map(({ id }) => id),
    ["a-pinned", "a-1", "a-2"],
  );
  assert.deepEqual(
    visibleSessionsForEnvironment(sessions, "env-b").map(({ id }) => id),
    ["b-pinned"],
  );
});

test("can omit the Session being archived when selecting its replacement", () => {
  const sessions = [
    session("current", "env-a", true),
    session("next-pinned", "env-a", true),
    session("next", "env-a"),
  ];

  assert.equal(
    visibleSessionsForEnvironment(sessions, "env-a", "current")[0]?.id,
    "next-pinned",
  );
});
