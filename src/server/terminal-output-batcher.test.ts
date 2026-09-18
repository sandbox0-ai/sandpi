import assert from "node:assert/strict";
import test from "node:test";

import { TerminalOutputBatcher } from "./terminal-output-batcher";

interface ScheduledCallback {
  handle: number;
  callback: () => void;
}

function scheduler() {
  const scheduled: ScheduledCallback[] = [];
  let nextHandle = 1;
  const batcher = new TerminalOutputBatcher({
    attemptId: "attempt-current",
    send: (message) => messages.push(message),
    schedule: (callback) => {
      const handle = { handle: nextHandle++, callback };
      scheduled.push(handle);
      return handle;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as ScheduledCallback);
      if (index >= 0) scheduled.splice(index, 1);
    },
  });
  const messages: unknown[] = [];
  return {
    batcher,
    drain() {
      while (scheduled.length > 0) scheduled.shift()?.callback();
    },
    messages,
  };
}

function output(
  seq: number,
  value: string,
  extra: Partial<{ attemptId: string; stream: string }> = {},
) {
  return {
    type: "event" as const,
    event: {
      seq,
      attemptId: extra.attemptId ?? "attempt-current",
      stream: extra.stream ?? "pty",
      type: "output",
      dataBase64: Buffer.from(value, "utf8").toString("base64"),
    },
  };
}

test("combines only contiguous output from one attempt and stream", () => {
  const harness = scheduler();
  harness.batcher.push(output(1, "a"));
  harness.batcher.push(output(2, "b"));
  harness.batcher.push(output(3, "c", { stream: "stdout" }));
  harness.drain();
  harness.batcher.close();

  assert.deepEqual(harness.messages, [
    {
      type: "events",
      fromSeq: 1,
      toSeq: 2,
      attemptId: "attempt-current",
      stream: "pty",
      dataBase64: Buffer.from("ab", "utf8").toString("base64"),
    },
    {
      type: "events",
      fromSeq: 3,
      toSeq: 3,
      attemptId: "attempt-current",
      stream: "stdout",
      dataBase64: Buffer.from("c", "utf8").toString("base64"),
    },
  ]);
});

test("flushes pending output before lifecycle events", () => {
  const harness = scheduler();
  harness.batcher.push(output(10, "x"));
  harness.batcher.push({ type: "event", event: { seq: 11, type: "attempt.exited" } });
  harness.batcher.close();

  assert.deepEqual(harness.messages, [
    {
      type: "events",
      fromSeq: 10,
      toSeq: 10,
      attemptId: "attempt-current",
      stream: "pty",
      dataBase64: Buffer.from("x", "utf8").toString("base64"),
    },
    {
      type: "event",
      event: { seq: 11, type: "attempt.exited" },
    },
  ]);
});

test("never blends an output sequence gap or another attempt", () => {
  const harness = scheduler();
  harness.batcher.push(output(20, "a"));
  harness.batcher.push(output(23, "d", { attemptId: "attempt-next" }));
  harness.drain();
  harness.batcher.close();

  assert.deepEqual(harness.messages, [
    {
      type: "events",
      fromSeq: 20,
      toSeq: 20,
      attemptId: "attempt-current",
      stream: "pty",
      dataBase64: Buffer.from("a", "utf8").toString("base64"),
    },
    output(23, "d", { attemptId: "attempt-next" }),
  ]);
});
