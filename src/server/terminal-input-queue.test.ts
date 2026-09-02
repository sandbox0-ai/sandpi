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
    async authorizeAndForward(message) {
      await authorization;
      forwarded.push(message);
    },
    forward: (message) => {
      forwarded.push(message);
    },
    requiresAuthorization: () => true,
    onError: (error) => assert.fail(String(error)),
  });

  for (const message of ["A", "B", "C", "D"]) queue.enqueue(message);
  await Promise.resolve();
  assert.deepEqual(forwarded, []);

  releaseAuthorization?.();
  await queue.drain();
  assert.deepEqual(forwarded, ["A", "B", "C", "D"]);
});

test("authorizes every writable frame and bypasses resize-only frames", async () => {
  let authorizationCount = 0;
  const forwarded: string[] = [];
  const queue = new TerminalInputQueue<string>({
    authorizeAndForward: async (message) => {
      authorizationCount += 1;
      forwarded.push(message);
    },
    forward: (message) => {
      forwarded.push(message);
    },
    requiresAuthorization: (message) => message !== "resize",
    onError: (error) => assert.fail(String(error)),
  });

  queue.enqueue("A");
  queue.enqueue("resize");
  await queue.drain();
  queue.enqueue("B");
  queue.enqueue("C");
  await queue.drain();
  assert.equal(authorizationCount, 3);
  assert.deepEqual(forwarded, ["A", "resize", "B", "C"]);
});

test("stops forwarding after authorization fails", async () => {
  const failure = new Error("Session locked");
  const errors: unknown[] = [];
  const forwarded: string[] = [];
  const queue = new TerminalInputQueue<string>({
    authorizeAndForward: async () => {
      throw failure;
    },
    forward: (message) => {
      forwarded.push(message);
    },
    requiresAuthorization: () => true,
    onError: (error) => errors.push(error),
  });

  queue.enqueue("A");
  queue.enqueue("B");
  await queue.drain();
  queue.enqueue("C");
  await queue.drain();

  assert.deepEqual(forwarded, []);
  assert.deepEqual(errors, [failure]);
});

test("keeps a view-only Agent queue available after rejected input", async () => {
  const errors: string[] = [];
  const forwarded: string[] = [];
  let authorized = false;
  const queue = new TerminalInputQueue<string>({
    requiresAuthorization: () => true,
    async authorizeAndForward(message) {
      if (!authorized) throw new Error("view only");
      forwarded.push(message);
    },
    forward() {},
    closeOnError: false,
    onError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  queue.enqueue("first");
  await queue.drain();
  authorized = true;
  queue.enqueue("second");
  await queue.drain();

  assert.deepEqual(errors, ["view only"]);
  assert.deepEqual(forwarded, ["second"]);
});
