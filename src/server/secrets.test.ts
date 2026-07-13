import assert from "node:assert/strict";
import test from "node:test";

import { SecretBox, secretHash } from "./secrets";

test("encrypts and authenticates deployment secrets", () => {
  const box = new SecretBox("a-test-deployment-secret-with-32-bytes");
  const encrypted = box.encrypt("credential", "environment-1");
  assert.notEqual(encrypted.ciphertext.toString("utf8"), "credential");
  assert.equal(box.decrypt(encrypted, "environment-1"), "credential");
  assert.throws(() => box.decrypt(encrypted, "environment-2"));
});

test("rejects short or public example encryption keys", () => {
  assert.throws(() => new SecretBox("short"));
  assert.throws(
    () => new SecretBox("replace-with-a-public-example-secret-value"),
  );
});

test("hashes opaque tokens deterministically", () => {
  assert.deepEqual(secretHash("token"), secretHash("token"));
  assert.notDeepEqual(secretHash("token"), secretHash("other"));
});
