import assert from "node:assert/strict";
import test from "node:test";

import type { RawData } from "ws";

import {
  BrowserWebSocketDownstreamRelay,
  isPlaywrightDashboardFrameMessage,
} from "./browser-websocket-relay";

function message(method: string, value: number) {
  return Buffer.from(
    JSON.stringify({ method, params: { value } }),
    "utf8",
  );
}

test("recognizes only Playwright text frame events", () => {
  assert.equal(
    isPlaywrightDashboardFrameMessage(message("frame", 1), false),
    true,
  );
  assert.equal(
    isPlaywrightDashboardFrameMessage(message("tabs", 1), false),
    false,
  );
  assert.equal(
    isPlaywrightDashboardFrameMessage(message("frame", 1), true),
    false,
  );
  assert.equal(
    isPlaywrightDashboardFrameMessage(
      Buffer.from('{"id":1,"result":{"method":"frame"}}'),
      false,
    ),
    false,
  );
});

test("coalesces stale frames while preserving control messages", () => {
  const sent: string[] = [];
  const completions: Array<(error?: Error) => void> = [];
  const relay = new BrowserWebSocketDownstreamRelay({
    maxQueuedBytes: 1024 * 1024,
    send(data: RawData, _isBinary, callback) {
      sent.push(Buffer.from(data as Buffer).toString("utf8"));
      completions.push(callback);
    },
    onOverflow() {
      assert.fail("relay unexpectedly overflowed");
    },
    onSendError(error) {
      assert.fail(error.message);
    },
  });

  relay.enqueue(message("frame", 1), false);
  relay.enqueue(message("frame", 2), false);
  relay.enqueue(message("frame", 3), false);
  relay.enqueue(message("tabs", 4), false);

  assert.deepEqual(
    sent.map((value) => JSON.parse(value).params.value),
    [1],
  );
  completions.shift()?.();
  assert.deepEqual(
    sent.map((value) => JSON.parse(value).params.value),
    [1, 4],
  );
  completions.shift()?.();
  assert.deepEqual(
    sent.map((value) => JSON.parse(value).params.value),
    [1, 4, 3],
  );
  completions.shift()?.();
  assert.deepEqual(relay.stats(), {
    receivedFrames: 3,
    forwardedFrames: 2,
    receivedFrameBytes:
      message("frame", 1).byteLength +
      message("frame", 2).byteLength +
      message("frame", 3).byteLength,
    coalescedFrames: 1,
    peakQueuedBytes:
      message("frame", 3).byteLength + message("tabs", 4).byteLength,
  });
});

test("bounds queued control traffic and reports send failures", () => {
  let overflows = 0;
  let sendError = "";
  const relay = new BrowserWebSocketDownstreamRelay({
    maxQueuedBytes: 64,
    send(_data, _isBinary, callback) {
      callback(new Error("downstream failed"));
    },
    onOverflow() {
      overflows += 1;
    },
    onSendError(error) {
      sendError = error.message;
    },
  });

  relay.enqueue(message("tabs", 1), false);
  assert.equal(sendError, "downstream failed");

  const blocked = new BrowserWebSocketDownstreamRelay({
    maxQueuedBytes: 4,
    send() {
      assert.fail("oversized traffic must not be sent");
    },
    onOverflow() {
      overflows += 1;
    },
    onSendError() {
      assert.fail("overflow is not a send error");
    },
  });
  blocked.enqueue(Buffer.from("oversized"), false);
  assert.equal(overflows, 1);
});
