import assert from "node:assert/strict";
import test from "node:test";

import { createId, randomToken } from "./id";

test("creates compact IDs without relying on UUID punctuation", () => {
  const token = randomToken(10);
  assert.match(token, /^[a-zA-Z0-9]+$/);
  assert.equal(token.length, 10);
  assert.match(createId("message", 8), /^message-[a-zA-Z0-9]{8}$/);
});
