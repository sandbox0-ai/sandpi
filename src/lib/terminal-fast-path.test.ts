import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalBinaryOpcode,
  TerminalFastPathMetrics,
  decodeTerminalBase64,
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryInput,
  encodeTerminalBinaryOutput,
  isTerminalEventBatchMessage,
} from "./terminal-fast-path";

test("round-trips a binary terminal input frame", () => {
  const payload = new TextEncoder().encode("arrow \u001b[A");
  const frame = encodeTerminalBinaryInput(42, payload);
  const decoded = decodeTerminalBinaryFrame(frame);

  assert.deepEqual(decoded, {
    opcode: TerminalBinaryOpcode.Input,
    sequence: 42,
    payload,
  });
});

test("round-trips a contiguous binary terminal output batch", () => {
  const payload = new TextEncoder().encode("\u001b[2Jhello");
  const frame = encodeTerminalBinaryOutput(101, 104, payload);
  const decoded = decodeTerminalBinaryFrame(frame);

  assert.deepEqual(decoded, {
    opcode: TerminalBinaryOpcode.Output,
    fromSeq: 101,
    toSeq: 104,
    payload,
  });
});

test("rejects malformed and truncated terminal binary frames", () => {
  assert.equal(decodeTerminalBinaryFrame(new Uint8Array(17)), undefined);
  assert.equal(
    decodeTerminalBinaryFrame(encodeTerminalBinaryInput(1, new Uint8Array([65])).slice(0, 16)),
    undefined,
  );
});

test("identifies JSON event batches and preserves exact decoded bytes", () => {
  const dataBase64 = Buffer.from("split \u001b[3", "utf8").toString("base64");
  assert.equal(
    isTerminalEventBatchMessage({
      type: "events",
      fromSeq: 7,
      toSeq: 8,
      attemptId: "attempt",
      stream: "pty",
      dataBase64,
    }),
    true,
  );
  assert.deepEqual(decodeTerminalBase64(dataBase64), new TextEncoder().encode("split \u001b[3"));
});

test("keeps bounded terminal latency diagnostics", () => {
  const metrics = new TerminalFastPathMetrics();
  metrics.setRenderer("webgl");
  metrics.recordOutputReceived(1, 10);
  metrics.markOutputDecoded(1);
  metrics.markOutputWriteQueued(1);
  metrics.recordInputSent("input-1", true);
  metrics.markInputAcknowledged("input-1");
  metrics.markOutputWriteComplete(1);

  assert.equal(metrics.snapshot().renderer, "webgl");
  assert.equal(metrics.snapshot().outputSamples, 1);
  assert.equal(metrics.snapshot().inputSamples, 1);
  assert.equal(metrics.snapshot().outputBytes, 10);
});
