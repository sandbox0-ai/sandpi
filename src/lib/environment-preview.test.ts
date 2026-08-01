import assert from "node:assert/strict";
import test from "node:test";

import { sandboxPreviewTarget, sandboxPreviewUrl } from "./environment-preview";

test("normalizes Sandbox loopback HTTP targets", () => {
  assert.deepEqual(sandboxPreviewTarget("localhost:3000/dashboard?q=1#top"), {
    url: "http://localhost:3000/dashboard?q=1#top",
    hostname: "localhost",
    port: 3000,
    pathname: "/dashboard",
    search: "?q=1",
    hash: "#top",
  });
  assert.equal(
    sandboxPreviewUrl("http://127.0.0.1:8080/health"),
    "http://127.0.0.1:8080/health",
  );
  assert.equal(sandboxPreviewTarget("localhost")?.port, 80);
});

test("rejects targets outside the narrow Preview boundary", () => {
  for (const target of [
    "https://localhost:3000",
    "http://[::1]:3000",
    "http://0.0.0.0:3000",
    "http://example.com",
    "http://user:password@localhost:3000",
    "file:///workspace/index.html",
    "localhost:0",
    "localhost:65536",
    "not a url",
  ]) {
    assert.equal(sandboxPreviewTarget(target), undefined, target);
  }
});
