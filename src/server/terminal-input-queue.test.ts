import assert from "node:assert/strict";
import test from "node:test";

import { TerminalInputQueue } from "./terminal-input-queue";

test("forwards terminal input in arrival order across an asynchronous check", async () => {
  let releaseAuthorization: (() => void) | undefined;
  const authorization = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  const forwarded: string[] = [];
  const queue = new TerminalInputQueue<string>({
    authorize: () => authorization,
    forward: (message) => forwarded.push(message),
    requiresAuthorization: () => true,
    onError: (error) => assert.fail(String(error)),
    authorizationLeaseMs: 250,
    now: () => 1_000,
  });

  for (const message of ["A", "B", "C", "D"]) queue.enqueue(message);
  await Promise.resolve();
  assert.deepEqual(forwarded, []);

  releaseAuthorization?.();
  await queue.drain();
  assert.deepEqual(forwarded, ["A", "B", "C", "D"]);
});

test("leases successful authorization without bypassing later revalidation", async () => {
  let now = 1_000;
  let authorizationCount = 0;
  const forwarded: string[] = [];
  const queue = new TerminalInputQueue<string>({
    authorize: async () => {
      authorizationCount += 1;
    },
    forward: (message) => forwarded.push(message),
    requiresAuthorization: (message) => message !== "resize",
    onError: (error) => assert.fail(String(error)),
    authorizationLeaseMs: 250,
    initiallyAuthorized: true,
    now: () => now,
  });

  queue.enqueue("A");
  queue.enqueue("resize");
  await queue.drain();
  assert.equal(authorizationCount, 0);

  now = 1_251;
  queue.enqueue("B");
  queue.enqueue("C");
  await queue.drain();
  assert.equal(authorizationCount, 1);
  assert.deepEqual(forwarded, ["A", "resize", "B", "C"]);
});

test("stops forwarding after authorization fails", async () => {
  const failure = new Error("Session locked");
  const errors: unknown[] = [];
  const forwarded: string[] = [];
  const queue = new TerminalInputQueue<string>({
    authorize: async () => {
      throw failure;
    },
    forward: (message) => forwarded.push(message),
    requiresAuthorization: () => true,
    onError: (error) => errors.push(error),
    authorizationLeaseMs: 0,
  });

  queue.enqueue("A");
  queue.enqueue("B");
  await queue.drain();
  queue.enqueue("C");
  await queue.drain();

  assert.deepEqual(forwarded, []);
  assert.deepEqual(errors, [failure]);
});
