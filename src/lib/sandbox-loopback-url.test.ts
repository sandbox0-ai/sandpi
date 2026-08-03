import assert from "node:assert/strict";
import test from "node:test";

import {
  sandboxLoopbackMatches,
  sandboxLoopbackTarget,
  sandboxLoopbackUrl,
} from "./sandbox-loopback-url";

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
    sandboxLoopbackUrl("http://%5B::1%5D:4173/"),
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

test("extracts the Sandbox preview protocol, port, and same-origin path", () => {
  assert.deepEqual(
    sandboxLoopbackTarget("https://localhost:8443/dashboard?q=1#logs"),
    {
      url: "https://localhost:8443/dashboard?q=1#logs",
      protocol: "https",
      port: 8443,
      path: "/dashboard?q=1#logs",
    },
  );
  assert.equal(sandboxLoopbackTarget("http://127.0.0.1")?.port, 80);
});

test("rejects external, credential-bearing and non-HTTP URLs", () => {
  assert.equal(sandboxLoopbackUrl("https://example.com"), undefined);
  assert.equal(
    sandboxLoopbackUrl("http://user:password@localhost:3000"),
    undefined,
  );
  assert.equal(sandboxLoopbackUrl("file:///workspace/index.html"), undefined);
  assert.equal(sandboxLoopbackUrl("localhost.example.com:3000"), undefined);
  assert.equal(sandboxLoopbackUrl("localhost:0"), undefined);
  assert.equal(sandboxLoopbackUrl("localhost:65536"), undefined);
  assert.equal(sandboxLoopbackUrl("not a url"), undefined);
});

test("finds bare explicit-port loopback URLs in prose", () => {
  assert.deepEqual(
    sandboxLoopbackMatches(
      "Open localhost:3000, 127.0.0.1:8080/health and [::1]:4173/app?q=1.",
    ),
    [
      {
        start: 5,
        end: 19,
        text: "localhost:3000",
        url: "http://localhost:3000/",
      },
      {
        start: 21,
        end: 42,
        text: "127.0.0.1:8080/health",
        url: "http://127.0.0.1:8080/health",
      },
      {
        start: 47,
        end: 65,
        text: "[::1]:4173/app?q=1",
        url: "http://[::1]:4173/app?q=1",
      },
    ],
  );
});

test("does not find embedded, already-schemed, or invalid loopback text", () => {
  assert.deepEqual(
    sandboxLoopbackMatches(
      "http://localhost:3000 xlocalhost:3000 localhost.example:3000 localhost:0 localhost:65536 localhost:123456 localhost:3000suffix",
    ),
    [],
  );
});
