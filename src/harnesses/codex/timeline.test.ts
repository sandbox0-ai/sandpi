import assert from "node:assert/strict";
import test from "node:test";

import { createMockCodexHarnessState } from "./events";
import {
  appendCodexTurn,
  replaceCodexTurn,
  truncateCodexEventsBeforeUserItem,
  visibleCodexConversationWhileEditing,
} from "./timeline";

const initial = createMockCodexHarnessState("thread-test", "gpt-5.2-codex", {
  content: "first",
  assistantText: "first reply",
  createdAt: "2026-07-12T00:00:00Z",
});
const state = appendCodexTurn(initial, {
  content: "second",
  assistantText: "second reply",
  createdAt: "2026-07-12T00:01:00Z",
});
const secondUser = visibleCodexConversationWhileEditing(state.events, null).find(
  (message) => message.content === "second",
);

test("projects native Codex item notifications without a shared chat schema", () => {
  assert.deepEqual(
    visibleCodexConversationWhileEditing(state.events, null).map((message) => message.content),
    ["first", "first reply", "second", "second reply"],
  );
});

test("uses the native Codex Turn boundary for delete and edit", () => {
  assert.ok(secondUser);
  const prefix = truncateCodexEventsBeforeUserItem(state.events, secondUser.id);
  assert.deepEqual(
    visibleCodexConversationWhileEditing(prefix ?? [], null).map((message) => message.content),
    ["first", "first reply"],
  );

  const replacement = replaceCodexTurn(state, secondUser.id, {
    content: "edited",
    assistantText: "edited reply",
    createdAt: "2026-07-12T00:02:00Z",
  });
  assert.deepEqual(
    visibleCodexConversationWhileEditing(replacement?.events ?? [], null).map(
      (message) => message.content,
    ),
    ["first", "first reply", "edited", "edited reply"],
  );
});

test("editing hides the selected native Turn and every descendant", () => {
  assert.ok(secondUser);
  assert.deepEqual(
    visibleCodexConversationWhileEditing(state.events, secondUser.id).map(
      (message) => message.content,
    ),
    ["first", "first reply"],
  );
  assert.deepEqual(
    visibleCodexConversationWhileEditing(state.events, "missing").map(
      (message) => message.content,
    ),
    ["first", "first reply", "second", "second reply"],
  );
});
