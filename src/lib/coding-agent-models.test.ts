import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultMockCodingAgentModel,
  getMockCodingAgentModels,
} from "./coding-agent-models";

test("keeps mock model choices scoped to their native harness", () => {
  assert.deepEqual(
    getMockCodingAgentModels("codex").map((model) => model.label),
    ["GPT-5.2 Codex", "GPT-5.1 Max", "GPT-5.1 Mini"],
  );
  assert.deepEqual(
    getMockCodingAgentModels("claude-code").map((model) => model.label),
    ["Default", "Opus", "Sonnet", "Haiku"],
  );
  assert.equal(getDefaultMockCodingAgentModel("pi").label, "Default");
});
