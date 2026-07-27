import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX,
  CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
  codexRuntimeRecoveryPrompt,
  isCodexRuntimeRecoveryClientMessageId,
} from "./runtime-recovery";

test("recognizes only Sandpi runtime recovery client message ids", () => {
  assert.equal(
    isCodexRuntimeRecoveryClientMessageId(
      `${CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX}session:request`,
    ),
    true,
  );
  assert.equal(isCodexRuntimeRecoveryClientMessageId("user-message:one"), false);
  assert.equal(isCodexRuntimeRecoveryClientMessageId(null), false);
});

test("keeps the recovery instruction versioned and side-effect conservative", () => {
  const prompt = codexRuntimeRecoveryPrompt(
    CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
  );
  assert.match(prompt, /without blindly repeating/);
  assert.match(prompt, /Do not repeat an external side effect/);
  assert.match(prompt, /wait for the user/);
  assert.throws(() => codexRuntimeRecoveryPrompt(999), /Unsupported/);
});
