import assert from "node:assert/strict";
import test from "node:test";

import {
  codexModelOptionsFromNativeResult,
  codexReasoningEffortLabel,
} from "./models";

test("projects the native Codex model/list result without sharing a cross-harness catalog", () => {
  assert.deepEqual(
    codexModelOptionsFromNativeResult({
      data: [
        {
          id: "gpt-5.3-codex",
          model: "gpt-5.3-codex",
          displayName: "GPT-5.3 Codex",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "low",
              description: "Faster answers with lighter reasoning",
            },
            {
              reasoningEffort: "high",
              description: "Deeper reasoning for complex tasks",
            },
          ],
        },
        {
          id: "hidden-model",
          displayName: "Hidden",
          hidden: true,
        },
      ],
    }),
    [
      {
        id: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          {
            id: "low",
            description: "Faster answers with lighter reasoning",
          },
          {
            id: "high",
            description: "Deeper reasoning for complex tasks",
          },
        ],
      },
    ],
  );
});

test("keeps a future model-defined effort without requiring a Sandpi enum", () => {
  assert.deepEqual(
    codexModelOptionsFromNativeResult({
      data: [
        {
          id: "future-model",
          defaultReasoningEffort: "missing",
          supportedReasoningEfforts: [
            { reasoningEffort: "focused", description: "Focused" },
          ],
        },
      ],
    }),
    [
      {
        id: "future-model",
        displayName: "future-model",
        isDefault: false,
        defaultReasoningEffort: "focused",
        supportedReasoningEfforts: [
          { id: "focused", description: "Focused" },
        ],
      },
    ],
  );
});

test("uses the Codex CLI label for extra-high reasoning", () => {
  assert.equal(codexReasoningEffortLabel("xhigh"), "Extra high");
});
