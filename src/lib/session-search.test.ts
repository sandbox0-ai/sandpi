import assert from "node:assert/strict";
import test from "node:test";

import type { CodingSession, Environment } from "./types";
import { searchSessions } from "./session-search";

const environments = [
  { id: "env-dev", name: "Development" },
  { id: "env-release", name: "Release lab" },
] as Environment[];

function session(input: Partial<CodingSession> & Pick<CodingSession, "id" | "title">) {
  return {
    environmentId: "env-dev",
    harnessLabel: "Codex",
    status: "running",
    archived: false,
    updatedAt: "2026-07-12T08:00:00+08:00",
    ...input,
  } as CodingSession;
}

test("searches Session title, Environment and harness with title-first relevance", () => {
  const sessions = [
    session({ id: "environment-match", title: "Prepare package", environmentId: "env-release" }),
    session({ id: "title-match", title: "Release the SDK" }),
    session({ id: "harness-match", title: "Update changelog", harnessLabel: "Release agent" }),
  ];

  assert.deepEqual(
    searchSessions(sessions, environments, "release").map(({ session: item }) => item.id),
    ["title-match", "environment-match", "harness-match"],
  );
});

test("excludes archived Sessions and sorts an empty query by recent activity", () => {
  const sessions = [
    session({ id: "older", title: "Older", updatedAt: "2026-07-11T08:00:00+08:00" }),
    session({ id: "archived", title: "Archived", archived: true }),
    session({ id: "newer", title: "Newer", updatedAt: "2026-07-12T09:00:00+08:00" }),
  ];

  assert.deepEqual(
    searchSessions(sessions, environments, "").map(({ session: item }) => item.id),
    ["newer", "older"],
  );
});
