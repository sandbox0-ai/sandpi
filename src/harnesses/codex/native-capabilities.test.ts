import assert from "node:assert/strict";
import test from "node:test";

import { codexMemoriesFeatureToggleSettings } from "./native-capabilities";

test("enables or disables memory reading and writing with the feature", () => {
  assert.deepEqual(codexMemoriesFeatureToggleSettings(true), {
    featureEnabled: true,
    useMemories: true,
    generateMemories: true,
  });
  assert.deepEqual(codexMemoriesFeatureToggleSettings(false), {
    featureEnabled: false,
    useMemories: false,
    generateMemories: false,
  });
});
