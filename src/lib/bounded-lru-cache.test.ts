import assert from "node:assert/strict";
import test from "node:test";

import { BoundedLruCache } from "./bounded-lru-cache";

test("evicts the least recently used entry at its bound", () => {
  const cache = new BoundedLruCache<string, number>(2);
  cache.set("one", 1);
  cache.set("two", 2);

  assert.equal(cache.get("one"), 1);
  cache.set("three", 3);

  assert.equal(cache.get("two"), undefined);
  assert.equal(cache.get("one"), 1);
  assert.equal(cache.get("three"), 3);
  assert.equal(cache.size, 2);
});

test("replaces an entry without evicting another key", () => {
  const cache = new BoundedLruCache<string, number>(2);
  cache.set("one", 1);
  cache.set("two", 2);
  cache.set("one", 10);

  assert.equal(cache.get("one"), 10);
  assert.equal(cache.get("two"), 2);
  assert.equal(cache.size, 2);
});

test("rejects an invalid entry bound", () => {
  assert.throws(() => new BoundedLruCache(0), RangeError);
  assert.throws(() => new BoundedLruCache(1.5), RangeError);
});
