import assert from "node:assert/strict";
import test from "node:test";

import { sandboxLoopbackUrl } from "./sandbox-loopback-url";

test("accepts HTTP loopback URLs that resolve inside a Sandbox", () => {
  assert.equal(
    sandboxLoopbackUrl("http://localhost:3000/dashboard?mode=debug#result"),
    "http://localhost:3000/dashboard?mode=debug#result",
  );
  assert.equal(
    sandboxLoopbackUrl("https://127.0.0.1:8443"),
    "https://127.0.0.1:8443/",
  );
  assert.equal(
    sandboxLoopbackUrl("http://[::1]:4173/"),
    "http://[::1]:4173/",
  );
  assert.equal(
    sandboxLoopbackUrl("localhost:3000/dashboard"),
    "http://localhost:3000/dashboard",
  );
  assert.equal(
    sandboxLoopbackUrl("127.0.0.1:8080/health"),
    "http://127.0.0.1:8080/health",
  );
});

test("rejects external, credential-bearing and non-HTTP URLs", () => {
  assert.equal(sandboxLoopbackUrl("https://example.com"), undefined);
  assert.equal(
    sandboxLoopbackUrl("http://user:password@localhost:3000"),
    undefined,
  );
  assert.equal(sandboxLoopbackUrl("file:///workspace/index.html"), undefined);
  assert.equal(sandboxLoopbackUrl("localhost.example.com:3000"), undefined);
  assert.equal(sandboxLoopbackUrl("not a url"), undefined);
});
