import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_ROLLOUT_MAX_RECORDS,
  CODEX_ROLLOUT_MAX_VALUE_STRING_LENGTH,
  parseCodexRolloutActivity,
  parseCodexRolloutSupplement,
} from "./rollout-activity";

const THREAD_ID = "019f-thread-native";

function jsonl(records: unknown[], trailingNewline = true) {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  return trailingNewline ? `${body}\n` : body;
}

function sessionMeta(id = THREAD_ID) {
  return {
    timestamp: "2026-07-18T00:00:00.000Z",
    type: "session_meta",
    payload: { id },
  };
}

function responseItem(
  timestamp: string,
  payload: Record<string, unknown>,
) {
  return { timestamp, type: "response_item", payload };
}

test("restores the latest persisted context-window usage", () => {
  const supplement = parseCodexRolloutSupplement(
    jsonl([
      sessionMeta(),
      {
        timestamp: "2026-07-18T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20_000,
              cached_input_tokens: 2_000,
              output_tokens: 2_000,
              reasoning_output_tokens: 1_000,
              total_tokens: 23_000,
            },
            last_token_usage: {
              input_tokens: 18_000,
              cached_input_tokens: 2_000,
              output_tokens: 2_000,
              reasoning_output_tokens: 1_000,
              total_tokens: 21_000,
            },
            model_context_window: 200_000,
          },
          rate_limits: null,
        },
      },
      {
        timestamp: "2026-07-18T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 30_000,
              cached_input_tokens: 3_000,
              output_tokens: 3_000,
              reasoning_output_tokens: 2_000,
              total_tokens: 35_000,
            },
            last_token_usage: {
              input_tokens: 24_000,
              cached_input_tokens: 3_000,
              output_tokens: 3_000,
              reasoning_output_tokens: 2_000,
              total_tokens: 29_000,
            },
            model_context_window: 200_000,
          },
          rate_limits: null,
        },
      },
    ]),
    THREAD_ID,
  );

  assert.equal(supplement.activity.availability, "available");
  assert.equal(supplement.tokenUsage?.total.totalTokens, 35_000);
  assert.equal(supplement.tokenUsage?.last.totalTokens, 29_000);
  assert.equal(supplement.tokenUsage?.modelContextWindow, 200_000);
});

test("pairs native call/output families by turn, family, and call id", () => {
  const feed = parseCodexRolloutActivity(
    jsonl([
      sessionMeta(),
      // Forked Codex rollouts can retain an ancestor session_meta in history.
      sessionMeta("historical-parent-thread"),
      {
        timestamp: "2026-07-18T00:00:00.500Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-a" },
      },
      responseItem("2026-07-18T00:00:01.000Z", {
        type: "function_call",
        call_id: "shared-call",
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
      }),
      {
        timestamp: "2026-07-18T00:00:01.500Z",
        type: "turn_context",
        payload: { turn_id: "turn-b" },
      },
      responseItem("2026-07-18T00:00:02.000Z", {
        type: "function_call",
        call_id: "shared-call",
        name: "exec_command",
        arguments: '{"cmd":"date"}',
        internal_chat_message_metadata_passthrough: { turn_id: "turn-b" },
      }),
      responseItem("2026-07-18T00:00:03.000Z", {
        type: "function_call_output",
        call_id: "shared-call",
        output: "turn-a output",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-a" },
      }),
      responseItem("2026-07-18T00:00:04.000Z", {
        type: "function_call_output",
        call_id: "shared-call",
        output: "turn-b output",
      }),
      responseItem("2026-07-18T00:00:05.000Z", {
        type: "custom_tool_call",
        call_id: "patch-call",
        name: "apply_patch",
        input:
          "tools.workspace.read('a'); tools.workspace.write('b'); tools.workspace.read('c')",
        metadata: { turn_id: "turn-a" },
      }),
      responseItem("2026-07-18T00:00:06.000Z", {
        type: "custom_tool_call_output",
        call_id: "patch-call",
        name: "apply_patch",
        output: "patch progress",
        metadata: { turn_id: "turn-a" },
      }),
      responseItem("2026-07-18T00:00:06.500Z", {
        type: "custom_tool_call_output",
        call_id: "patch-call",
        name: "apply_patch",
        output: { output: "Done!", metadata: { exit_code: 0 } },
        metadata: { turn_id: "turn-a" },
      }),
      // Output-before-call is valid when records are assembled from chunks.
      responseItem("2026-07-18T00:00:08.000Z", {
        type: "tool_search_output",
        call_id: "search-call",
        tools: [{ type: "function", name: "search" }],
        metadata: { turn_id: "turn-a" },
      }),
      responseItem("2026-07-18T00:00:07.000Z", {
        type: "tool_search_call",
        call_id: "search-call",
        status: "completed",
        execution: "client",
        arguments: { query: "native tools", limit: 5 },
        metadata: { turn_id: "turn-a" },
      }),
    ]),
    THREAD_ID,
  );

  assert.equal(feed.availability, "available");
  assert.equal(feed.error, null);
  assert.equal(feed.records.length, 4);

  const [turnA, turnB, custom, toolSearch] = feed.records;
  assert.deepEqual(
    {
      turnId: turnA.turnId,
      callType: turnA.callType,
      outputType: turnA.outputs[0]?.outputType,
      output: (
        turnA.outputs[0]?.payload as { output?: unknown } | undefined
      )?.output,
      status: turnA.status,
      durationMs: turnA.durationMs,
    },
    {
      turnId: "turn-a",
      callType: "function_call",
      outputType: "function_call_output",
      output: "turn-a output",
      status: "completed",
      durationMs: 2_000,
    },
  );
  assert.equal(turnB.turnId, "turn-b");
  assert.equal(
    (turnB.outputs[0]?.payload as { output?: unknown }).output,
    "turn-b output",
  );
  assert.equal(turnB.durationMs, 2_000);
  assert.deepEqual(custom.codeModeTools, [
    "workspace.read",
    "workspace.write",
  ]);
  assert.equal(custom.outputs.length, 2);
  assert.equal(
    (custom.outputs[0]?.payload as { output?: unknown }).output,
    "patch progress",
  );
  assert.deepEqual(
    (custom.outputs[1]?.payload as { output?: unknown }).output,
    { output: "Done!", metadata: { exit_code: 0 } },
  );
  assert.equal(
    (custom.outputs[1]?.payload as { name?: unknown }).name,
    "apply_patch",
  );
  assert.equal(toolSearch.callType, "tool_search_call");
  assert.equal(toolSearch.outputs[0]?.outputType, "tool_search_output");
  assert.equal(
    (toolSearch.callPayload as { execution?: unknown }).execution,
    "client",
  );
  assert.deepEqual(
    (toolSearch.callPayload as { arguments?: unknown }).arguments,
    { query: "native tools", limit: 5 },
  );
  assert.deepEqual(
    (toolSearch.outputs[0]?.payload as { tools?: unknown }).tools,
    [{ type: "function", name: "search" }],
  );
  assert.equal(toolSearch.durationMs, 1_000);
});

test("preserves standalone and future native call shapes", () => {
  const feed = parseCodexRolloutActivity(
    jsonl([
      sessionMeta(),
      {
        type: "turn_context",
        payload: { turn_id: "turn-native" },
      },
      responseItem("2026-07-18T00:00:01.000Z", {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "Sandpi" },
      }),
      responseItem("2026-07-18T00:00:02.000Z", {
        type: "local_shell_call",
        id: "shell-native-id",
        status: "failed",
        action: { type: "exec", command: ["false"] },
      }),
      responseItem("2026-07-18T00:00:03.000Z", {
        type: "image_generation_call",
        id: "image-native-id",
        status: "generating",
        revised_prompt: "pixel UI",
        result: "base64-result",
      }),
      responseItem("2026-07-18T00:00:04.000Z", {
        type: "browser_call",
        call_id: "browser-call",
        name: "navigate",
        namespace: "browser",
        status: "running",
        input: { url: "https://example.test" },
        action: { type: "open" },
        future_extension: { trace: "native-value" },
      }),
      responseItem("2026-07-18T00:00:05.500Z", {
        type: "browser_call_output",
        call_id: "browser-call",
        status: "completed",
        output: { title: "Example" },
      }),
    ]),
    THREAD_ID,
  );

  assert.equal(feed.availability, "available");
  const [web, shell, image, browser] = feed.records;
  assert.equal(web.callType, "web_search_call");
  assert.equal(web.name, "web_search");
  assert.deepEqual(
    (web.callPayload as { action?: unknown }).action,
    { type: "search", query: "Sandpi" },
  );
  assert.equal(web.status, "completed");

  assert.equal(shell.callId, "shell-native-id");
  assert.equal(shell.nativeStatus, "failed");
  assert.equal(shell.status, "failed");
  assert.deepEqual(
    (shell.callPayload as { action?: unknown }).action,
    { type: "exec", command: ["false"] },
  );

  assert.equal(image.callType, "image_generation_call");
  assert.equal(image.nativeStatus, "generating");
  assert.equal(image.status, "completed");
  assert.equal(
    (image.callPayload as { revised_prompt?: unknown }).revised_prompt,
    "pixel UI",
  );
  assert.equal(
    (image.callPayload as { result?: unknown }).result,
    "base64-result",
  );

  assert.equal(browser.name, "navigate");
  assert.equal(browser.namespace, "browser");
  assert.equal(browser.outputs[0]?.outputType, "browser_call_output");
  assert.deepEqual(
    (browser.callPayload as { input?: unknown }).input,
    { url: "https://example.test" },
  );
  assert.deepEqual(
    (browser.callPayload as { future_extension?: unknown }).future_extension,
    { trace: "native-value" },
  );
  assert.deepEqual(
    (browser.outputs[0]?.payload as { output?: unknown }).output,
    { title: "Example" },
  );
  assert.equal(browser.durationMs, 1_500);
});

test("attributes nested parallel recipients without normalizing their tools", () => {
  const feed = parseCodexRolloutActivity(
    jsonl([
      sessionMeta(),
      { type: "turn_context", payload: { turn_id: "turn-parallel" } },
      responseItem("2026-07-18T00:00:01.000Z", {
        type: "custom_tool_call",
        call_id: "parallel-call",
        name: "exec",
        input: [
          "const results = await tools.multi_tool_use.parallel({",
          '  tool_uses: [{ recipient_name: "web.run", parameters: {} },',
          '    { "recipient_name": "functions.exec_command", "parameters": {} }],',
          "});",
        ].join("\n"),
      }),
    ]),
    THREAD_ID,
  );

  assert.equal(feed.availability, "available");
  assert.deepEqual(feed.records[0]?.codeModeTools, [
    "multi_tool_use.parallel",
    "web.run",
    "functions.exec_command",
  ]);
});

test("reports malformed complete lines but ignores an unfinished tail", () => {
  const text = [
    JSON.stringify(sessionMeta()),
    "not-json",
    JSON.stringify({ type: "response_item", payload: "invalid" }),
    JSON.stringify({
      type: "turn_context",
      payload: { turn_id: "turn-a" },
    }),
    JSON.stringify(
      responseItem("2026-07-18T00:00:01.000Z", {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "safe tail" },
      }),
    ),
    '{"type":"response_item","payload":',
  ].join("\n");

  const feed = parseCodexRolloutActivity(text, THREAD_ID);

  assert.equal(feed.availability, "partial");
  assert.equal(feed.records.length, 1);
  assert.equal(feed.error?.code, "codex_rollout_parse_partial");
  assert.match(feed.error?.message ?? "", /1 complete JSONL line is malformed/);
  assert.match(feed.error?.message ?? "", /1 record has an invalid rollout shape/);
  assert.doesNotMatch(feed.error?.message ?? "", /2 complete JSONL/);
});

test("accepts a complete final record without a trailing newline", () => {
  const feed = parseCodexRolloutActivity(
    jsonl(
      [
        sessionMeta(),
        { type: "turn_context", payload: { turn_id: "turn-a" } },
        responseItem("2026-07-18T00:00:01.000Z", {
          type: "web_search_call",
          status: "completed",
          action: { type: "open_page", url: "https://example.test" },
        }),
      ],
      false,
    ),
    THREAD_ID,
  );

  assert.equal(feed.availability, "available");
  assert.equal(feed.records.length, 1);
});

test("rejects missing or mismatched native session metadata", () => {
  const mismatched = parseCodexRolloutActivity(
    jsonl([sessionMeta("another-thread")]),
    THREAD_ID,
  );
  assert.deepEqual(mismatched, {
    source: "codex-rollout",
    availability: "unavailable",
    records: [],
    error: {
      code: "codex_rollout_thread_mismatch",
      message:
        "The Codex rollout session id does not match the requested native thread.",
    },
  });

  const missing = parseCodexRolloutActivity("", THREAD_ID);
  assert.equal(missing.availability, "unavailable");
  assert.equal(missing.error?.code, "codex_rollout_session_meta_missing");

  const invalidPreamble = parseCodexRolloutActivity(
    jsonl([
      { type: "turn_context", payload: { turn_id: "turn-a" } },
      sessionMeta(),
      responseItem("2026-07-18T00:00:01.000Z", {
        type: "future_call",
        call_id: "must-not-accept",
      }),
    ]),
    THREAD_ID,
  );
  assert.equal(invalidPreamble.availability, "unavailable");
  assert.equal(
    invalidPreamble.error?.code,
    "codex_rollout_session_meta_invalid",
  );
  assert.deepEqual(invalidPreamble.records, []);
});

test("skips reasoning secrets and bounds native payload values and record count", () => {
  const longValue = "x".repeat(CODEX_ROLLOUT_MAX_VALUE_STRING_LENGTH + 100);
  const bounded = parseCodexRolloutActivity(
    jsonl([
      sessionMeta(),
      { type: "turn_context", payload: { turn_id: "turn-a" } },
      responseItem("2026-07-18T00:00:00.500Z", {
        type: "reasoning",
        encrypted_content: "must-not-leak",
      }),
      responseItem("2026-07-18T00:00:01.000Z", {
        type: "custom_tool_call",
        call_id: "bounded",
        name: "opaque",
        status: "completed",
        input: {
          text: longValue,
          encrypted_content: "also-must-not-leak",
        },
      }),
    ]),
    THREAD_ID,
  );

  assert.equal(bounded.records.length, 1);
  assert.equal(bounded.records[0].payloadTruncated, true);
  assert.equal(JSON.stringify(bounded).includes("must-not-leak"), false);
  const boundedInput = (
    bounded.records[0].callPayload as { input: { text: string } }
  ).input;
  assert.equal(
    boundedInput.text.length,
    CODEX_ROLLOUT_MAX_VALUE_STRING_LENGTH,
  );
  assert.match(boundedInput.text, /\.\.\.\[truncated\]$/);

  const overLimit: unknown[] = [
    sessionMeta(),
    { type: "turn_context", payload: { turn_id: "turn-limit" } },
  ];
  for (let index = 0; index <= CODEX_ROLLOUT_MAX_RECORDS; index += 1) {
    overLimit.push(
      responseItem("2026-07-18T00:00:01.000Z", {
        type: "future_call",
        call_id: `call-${index}`,
        status: "completed",
      }),
    );
  }
  const limited = parseCodexRolloutActivity(jsonl(overLimit), THREAD_ID);
  assert.equal(limited.records.length, CODEX_ROLLOUT_MAX_RECORDS);
  assert.equal(limited.availability, "partial");
  assert.equal(limited.error?.code, "codex_rollout_activity_limit");
});
