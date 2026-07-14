import assert from "node:assert/strict";
import test from "node:test";

import { codexModelOptionsFromNativeResult } from "./models";

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
      },
    ],
  );
});
