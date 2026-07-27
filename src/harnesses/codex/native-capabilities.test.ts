import assert from "node:assert/strict";
import test from "node:test";

import {
  codexMemoriesFeatureToggleSettings,
  codexProjectGuidanceFromNativeResult,
} from "./native-capabilities";

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

test("projects native Codex instruction sources without exposing managed state", () => {
  assert.deepEqual(
    codexProjectGuidanceFromNativeResult({
      cwd: "/workspace/packages/web",
      instructionSources: [
        "/workspace/.sandpi/harnesses/codex/AGENTS.md",
        "/workspace/AGENTS.md",
        "/workspace/packages/web/AGENTS.override.md",
        "C:\\workspace\\AGENTS.md",
        null,
      ],
    }),
    {
      cwd: "/workspace/packages/web",
      instructionSources: [
        {
          path: "/workspace/.sandpi/harnesses/codex/AGENTS.md",
          workspacePath: null,
        },
        {
          path: "/workspace/AGENTS.md",
          workspacePath: "/workspace/AGENTS.md",
        },
        {
          path: "/workspace/packages/web/AGENTS.override.md",
          workspacePath: "/workspace/packages/web/AGENTS.override.md",
        },
        {
          path: "C:\\workspace\\AGENTS.md",
          workspacePath: null,
        },
      ],
    },
  );
});

test("keeps guidance optional for older native response shapes", () => {
  assert.deepEqual(codexProjectGuidanceFromNativeResult(undefined), {
    cwd: "/workspace",
    instructionSources: [],
  });
});
