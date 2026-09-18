import assert from "node:assert/strict";
import test from "node:test";

import { TerminalReplayMemoryCache } from "./terminal-replay-cache";

function chunk(fromSeq: number, toSeq: number, value: string) {
  return {
    fromSeq,
    toSeq,
    data: new TextEncoder().encode(value),
  };
}

test("keeps a page-lifetime journal tail usable only after a full reset", () => {
  const cache = new TerminalReplayMemoryCache();
  cache.reset("terminal", "session", true);
  assert.equal(cache.usable("terminal", "session", 0), undefined);

  cache.append("terminal", "session", chunk(1, 2, "ab"));
  cache.append("terminal", "session", chunk(3, 4, "cd"));
  cache.append("terminal", "session", chunk(5, 5, ""));
  assert.equal(cache.usable("terminal", "other", 4), undefined);
  assert.deepEqual(cache.usable("terminal", "session", 5), [
    chunk(1, 2, "ab"),
    chunk(3, 4, "cd"),
    chunk(5, 5, ""),
  ]);
});

test("allows lifecycle sequence gaps but rejects reversed output", () => {
  const cache = new TerminalReplayMemoryCache();
  cache.reset("terminal", "session", true);
  cache.append("terminal", "session", chunk(1, 2, "ab"));
  cache.append("terminal", "session", chunk(4, 5, "cd"));
  assert.deepEqual(cache.usable("terminal", "session", 5), [
    chunk(1, 2, "ab"),
    chunk(4, 5, "cd"),
  ]);
  cache.append("terminal", "session", chunk(4, 5, "overlap"));
  assert.deepEqual(cache.usable("terminal", "session", 5), [
    chunk(1, 2, "ab"),
    chunk(4, 5, "cd"),
  ]);
});

test("stops exposing a cache after dropping its first chunk", () => {
  const cache = new TerminalReplayMemoryCache();
  cache.reset("terminal", "session", true);
  cache.append("terminal", "session", chunk(1, 2, "a".repeat(2 * 1024 * 1024)));
  cache.append("terminal", "session", chunk(3, 4, "b".repeat(3 * 1024 * 1024)));
  assert.equal(cache.usable("terminal", "session", 4), undefined);
});
