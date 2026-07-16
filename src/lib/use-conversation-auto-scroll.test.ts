import assert from "node:assert/strict";
import test from "node:test";

import { isNearConversationBottom } from "./use-conversation-auto-scroll";

test("stops following when the reader moves away from the conversation end", () => {
  assert.equal(
    isNearConversationBottom({
      scrollHeight: 2_000,
      scrollTop: 900,
      clientHeight: 700,
    }),
    false,
  );
});

test("resumes following when the reader returns to the bottom threshold", () => {
  assert.equal(
    isNearConversationBottom({
      scrollHeight: 2_000,
      scrollTop: 1_292,
      clientHeight: 700,
    }),
    true,
  );
  assert.equal(
    isNearConversationBottom({
      scrollHeight: 2_000,
      scrollTop: 1_291,
      clientHeight: 700,
    }),
    false,
  );
});
