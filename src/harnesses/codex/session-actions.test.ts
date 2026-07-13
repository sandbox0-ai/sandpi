import assert from "node:assert/strict";
import test from "node:test";

import { createMockSession, mockEnvironments } from "@/lib/mock-data";

import { projectCodexConversation } from "./events";
import { forkMockCodexSession, forkMockCodexTurn } from "./session-actions";

test("forks a Codex Session with a distinct native thread", () => {
  const source = createMockSession(mockEnvironments[0], {
    title: "source",
    prompt: "inspect the repo",
  });
  const forked = forkMockCodexSession(source, "2026-07-13T00:00:00Z");

  assert.notEqual(forked.id, source.id);
  assert.notEqual(forked.harnessState.threadId, source.harnessState.threadId);
  assert.equal(forked.origin?.kind, "session");
  assert.equal(
    forked.harnessState.events[0].notification.method,
    "thread/started",
  );
});

test("forks a Codex Turn from its native userMessage item", () => {
  const source = createMockSession(mockEnvironments[0], {
    title: "source",
    prompt: "inspect the repo",
  });
  const userItem = projectCodexConversation(source.harnessState.events).find(
    (message) => message.role === "user",
  );
  assert.ok(userItem);

  const forked = forkMockCodexTurn(
    source,
    userItem.id,
    "2026-07-13T00:00:00Z",
  );
  assert.ok(forked);
  assert.equal(forked.origin?.kind, "turn");
  assert.equal(forked.origin?.sourceNativeItemId, userItem.id);
  assert.deepEqual(
    projectCodexConversation(forked.harnessState.events).map((message) => message.content),
    ["inspect the repo", expectQueuedResponse()],
  );
});

function expectQueuedResponse() {
  return "I’ve queued that instruction for the running Codex thread. This prototype now stores native app-server notifications; the backend integration will replace these mock events with the Supervisor event stream.";
}
