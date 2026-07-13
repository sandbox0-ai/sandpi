import assert from "node:assert/strict";
import test from "node:test";

import {
  codexModelOptionsFromNativeResult,
  getDefaultMockCodexModel,
  getMockCodexModel,
  getMockCodexModels,
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
        },
        {
          id: "hidden-model",
          displayName: "Hidden",
          hidden: true,
        },
      ],
    }),
    [{ id: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" }],
  );
});

test("keeps the mock model catalog inside the Codex integration", () => {
  assert.deepEqual(
    getMockCodexModels().map((model) => model.displayName),
    ["GPT-5.2 Codex", "GPT-5.1 Max", "GPT-5.1 Mini"],
  );
  assert.equal(getDefaultMockCodexModel().id, "gpt-5.2-codex");
  assert.equal(getMockCodexModel("unknown").id, getDefaultMockCodexModel().id);
});
