import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCodexSupervisorEvents,
  EMPTY_CODEX_DECODER_STATE,
  type SupervisorOutputEvent,
} from "./jsonl";

function event(
  seq: number,
  content: Buffer | string,
  overrides: Partial<SupervisorOutputEvent> = {},
): SupervisorOutputEvent {
  return {
    seq,
    runtimeGeneration: 1,
    attemptId: "attempt-1",
    type: "output",
    stream: "stdout",
    dataBase64: Buffer.from(content).toString("base64"),
    occurredAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

test("decodes records split across arbitrary Supervisor chunks", () => {
  const first = decodeCodexSupervisorEvents(EMPTY_CODEX_DECODER_STATE, [
    event(1, '{"id":1,"result":{"thr'),
  ]);
  assert.equal(first.records.length, 0);

  const second = decodeCodexSupervisorEvents(first.state, [
    event(2, 'ead":{"id":"thr_1"}}}\n{"method":"turn/started","params":{}}\n'),
  ]);
  assert.deepEqual(second.records.map((record) => record.message), [
    { id: 1, result: { thread: { id: "thr_1" } } },
    { method: "turn/started", params: {} },
  ]);
  assert.equal(second.state.tailBase64, "");
  assert.equal(second.state.supervisorCursor, 2);
});

test("preserves split multibyte UTF-8 bytes", () => {
  const bytes = Buffer.from('{"method":"item","params":{"text":"你好"}}\n');
  const split = bytes.indexOf(Buffer.from("你")) + 1;
  const first = decodeCodexSupervisorEvents(EMPTY_CODEX_DECODER_STATE, [
    event(1, bytes.subarray(0, split)),
  ]);
  const second = decodeCodexSupervisorEvents(first.state, [
    event(2, bytes.subarray(split)),
  ]);
  assert.equal(
    (second.records[0]?.message.params as { text: string }).text,
    "你好",
  );
});

test("drops an unfinished record when the process attempt changes", () => {
  const first = decodeCodexSupervisorEvents(EMPTY_CODEX_DECODER_STATE, [
    event(1, '{"old":'),
  ]);
  const second = decodeCodexSupervisorEvents(first.state, [
    event(2, '{"new":true}\n', {
      attemptId: "attempt-2",
      runtimeGeneration: 2,
    }),
  ]);
  assert.deepEqual(second.records[0]?.message, { new: true });
});

test("ignores stderr and already committed sequences", () => {
  const result = decodeCodexSupervisorEvents(
    { ...EMPTY_CODEX_DECODER_STATE, supervisorCursor: 3 },
    [
      event(3, '{"duplicate":true}\n'),
      event(4, "not json\n", { stream: "stderr" }),
    ],
  );
  assert.equal(result.records.length, 0);
  assert.equal(result.invalidRecords.length, 0);
  assert.equal(result.state.supervisorCursor, 4);
});
