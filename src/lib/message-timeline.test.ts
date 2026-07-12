import assert from "node:assert/strict";
import test from "node:test";

import {
  replaceTimelineFromUserMessage,
  truncateTimelineFromUserMessage,
  visibleTimelineWhileEditing,
} from "./message-timeline";
import type { ChatMessage } from "./types";

const messages: ChatMessage[] = [
  { id: "user-1", role: "user", content: "first", createdAt: "2026-07-12T00:00:00Z" },
  {
    id: "assistant-1",
    role: "assistant",
    content: "first reply",
    createdAt: "2026-07-12T00:00:01Z",
  },
  { id: "user-2", role: "user", content: "second", createdAt: "2026-07-12T00:00:02Z" },
  {
    id: "assistant-2",
    role: "assistant",
    content: "second reply",
    createdAt: "2026-07-12T00:00:03Z",
  },
];

test("delete rolls the timeline back to immediately before the selected user message", () => {
  assert.deepEqual(
    truncateTimelineFromUserMessage(messages, "user-2")?.map((message) => message.id),
    ["user-1", "assistant-1"],
  );
});

test("edit and fork replace the selected turn and discard its descendants", () => {
  const replacement: ChatMessage[] = [
    { id: "user-2b", role: "user", content: "edited", createdAt: "2026-07-12T00:01:00Z" },
    {
      id: "assistant-2b",
      role: "assistant",
      content: "new reply",
      createdAt: "2026-07-12T00:01:01Z",
    },
  ];

  assert.deepEqual(
    replaceTimelineFromUserMessage(messages, "user-2", replacement)?.map(
      (message) => message.id,
    ),
    ["user-1", "assistant-1", "user-2b", "assistant-2b"],
  );
});

test("assistant messages cannot be rollback boundaries", () => {
  assert.equal(truncateTimelineFromUserMessage(messages, "assistant-1"), null);
  assert.equal(replaceTimelineFromUserMessage(messages, "missing", []), null);
});

test("editing hides the selected user turn and every message after it", () => {
  assert.deepEqual(
    visibleTimelineWhileEditing(messages, "user-2").map((message) => message.id),
    ["user-1", "assistant-1"],
  );
  assert.equal(visibleTimelineWhileEditing(messages, null), messages);
  assert.equal(visibleTimelineWhileEditing(messages, "assistant-1"), messages);
});
