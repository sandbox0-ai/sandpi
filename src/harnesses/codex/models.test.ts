import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultMockCodexModel,
  getMockCodexModel,
  getMockCodexModels,
} from "./models";

test("keeps the mock model catalog inside the Codex integration", () => {
  assert.deepEqual(
    getMockCodexModels().map((model) => model.displayName),
    ["GPT-5.2 Codex", "GPT-5.1 Max", "GPT-5.1 Mini"],
  );
  assert.equal(getDefaultMockCodexModel().id, "gpt-5.2-codex");
  assert.equal(getMockCodexModel("unknown").id, getDefaultMockCodexModel().id);
});
