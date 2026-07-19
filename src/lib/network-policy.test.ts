import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNetworkDomain } from "./network-policy";

test("normalizes exact and wildcard network domains", () => {
  assert.equal(normalizeNetworkDomain(" GitHub.COM. "), "github.com");
  assert.equal(normalizeNetworkDomain("*.Example.COM"), "*.example.com");
  assert.equal(normalizeNetworkDomain("localhost"), "localhost");
});

test("rejects URLs, paths, ports, and invalid wildcard domains", () => {
  assert.equal(normalizeNetworkDomain("https://github.com"), undefined);
  assert.equal(normalizeNetworkDomain("github.com/api"), undefined);
  assert.equal(normalizeNetworkDomain("github.com:443"), undefined);
  assert.equal(normalizeNetworkDomain("*."), undefined);
  assert.equal(normalizeNetworkDomain("-example.com"), undefined);
});
