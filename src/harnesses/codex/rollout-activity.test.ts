import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCodexRolloutActivityFeed,
  type CodexRolloutActivityFeed,
} from "./rollout-activity";

const availableFeed: CodexRolloutActivityFeed = {
  source: "codex-rollout",
  availability: "available",
  records: [
    {
      kind: "rolloutToolCall",
      id: "turn-a:function:call-a",
      turnId: "turn-a",
      createdAt: 1,
      completedAt: 2,
      durationMs: 1_000,
      status: "completed",
      callId: "call-a",
      callType: "function_call",
      name: "exec_command",
      namespace: null,
      nativeStatus: null,
      callPayload: {
        type: "function_call",
        call_id: "call-a",
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
      },
      outputs: [
        {
          outputType: "function_call_output",
          createdAt: 2,
          nativeStatus: null,
          payload: {
            type: "function_call_output",
            call_id: "call-a",
            output: "ok",
          },
        },
      ],
      codeModeTools: [],
      payloadTruncated: false,
    },
  ],
  error: null,
};

test("keeps a valid Codex rollout Activity feed", () => {
  assert.equal(normalizeCodexRolloutActivityFeed(availableFeed), availableFeed);
});

test("turns missing or malformed supplemental Activity into a scoped error", () => {
  assert.equal(
    normalizeCodexRolloutActivityFeed(undefined).error?.code,
    "codex_rollout_activity_missing",
  );
  const invalid = normalizeCodexRolloutActivityFeed({
    ...availableFeed,
    records: [{ ...availableFeed.records[0], codeModeTools: null }],
  });
  assert.equal(invalid.availability, "unavailable");
  assert.equal(invalid.error?.code, "codex_rollout_activity_invalid");
});
