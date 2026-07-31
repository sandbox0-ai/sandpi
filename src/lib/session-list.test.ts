import assert from "node:assert/strict";
import test from "node:test";

import type { CodingSession } from "./types";
import {
  SIDEBAR_INITIAL_SESSION_COUNT,
  SIDEBAR_SESSION_PAGE_SIZE,
  sidebarSessionPage,
  visibleSessionsForEnvironment,
} from "./session-list";

function session(
  id: string,
  environmentId: string,
  pinned = false,
  archived = false,
  status: CodingSession["status"] = "waiting",
): CodingSession {
  return { id, environmentId, pinned, archived, status } as CodingSession;
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

test("paginates Sidebar Sessions in a six-plus-ten window", () => {
  const sessions = Array.from({ length: 29 }, (_, index) =>
    session(`session-${index + 1}`, "env-a"),
  );

  const firstPage = sidebarSessionPage(
    sessions,
    SIDEBAR_INITIAL_SESSION_COUNT,
  );
  assert.deepEqual(
    firstPage.sessions.map(({ id }) => id),
    sessions.slice(0, 6).map(({ id }) => id),
  );
  assert.equal(firstPage.hiddenCount, 23);
  assert.equal(firstPage.nextCount, SIDEBAR_SESSION_PAGE_SIZE);
  assert.equal(firstPage.expanded, false);

  const secondPage = sidebarSessionPage(
    sessions,
    SIDEBAR_INITIAL_SESSION_COUNT + SIDEBAR_SESSION_PAGE_SIZE,
  );
  assert.deepEqual(
    secondPage.sessions.map(({ id }) => id),
    sessions.slice(0, 16).map(({ id }) => id),
  );
  assert.equal(secondPage.hiddenCount, 13);
  assert.equal(secondPage.nextCount, SIDEBAR_SESSION_PAGE_SIZE);
  assert.equal(secondPage.expanded, true);

  const finalPage = sidebarSessionPage(sessions, 26);
  assert.equal(finalPage.sessions.length, 26);
  assert.equal(finalPage.hiddenCount, 3);
  assert.equal(finalPage.nextCount, 3);
});

test("keeps a selected Session visible outside the Sidebar window", () => {
  const sessions = Array.from({ length: 20 }, (_, index) =>
    session(`session-${index + 1}`, "env-a"),
  );

  const page = sidebarSessionPage(
    sessions,
    SIDEBAR_INITIAL_SESSION_COUNT,
    "session-12",
  );
  assert.deepEqual(
    page.sessions.map(({ id }) => id),
    [
      ...sessions.slice(0, SIDEBAR_INITIAL_SESSION_COUNT).map(({ id }) => id),
      "session-12",
    ],
  );
  assert.equal(page.hiddenCount, 13);
  assert.equal(page.nextCount, 10);

  const expanded = sidebarSessionPage(sessions, 16, "session-12");
  assert.equal(
    expanded.sessions.filter(({ id }) => id === "session-12").length,
    1,
  );
  assert.equal(expanded.sessions.length, 17);
});

test("keeps every running Session visible outside the Sidebar window", () => {
  const runningIds = new Set([
    "session-8",
    "session-10",
    "session-12",
    "session-14",
    "session-16",
    "session-18",
    "session-20",
    "session-22",
  ]);
  const sessions = Array.from({ length: 30 }, (_, index) => {
    const id = `session-${index + 1}`;
    return session(
      id,
      "env-a",
      false,
      false,
      runningIds.has(id) ? "running" : "waiting",
    );
  });

  const page = sidebarSessionPage(
    sessions,
    SIDEBAR_INITIAL_SESSION_COUNT,
  );
  assert.deepEqual(
    page.sessions.map(({ id }) => id),
    [
      ...sessions.slice(0, SIDEBAR_INITIAL_SESSION_COUNT).map(({ id }) => id),
      ...runningIds,
    ],
  );
  assert.equal(page.hiddenCount, 16);
  assert.equal(page.nextCount, SIDEBAR_SESSION_PAGE_SIZE);
  assert.equal(page.expanded, false);

  const expanded = sidebarSessionPage(
    sessions,
    SIDEBAR_INITIAL_SESSION_COUNT + SIDEBAR_SESSION_PAGE_SIZE,
  );
  assert.equal(expanded.sessions.length, 24);
  assert.deepEqual(
    expanded.sessions
      .filter(({ status }) => status === "running")
      .map(({ id }) => id),
    [...runningIds],
  );
  assert.equal(expanded.hiddenCount, 6);
  assert.equal(expanded.nextCount, 6);
});
