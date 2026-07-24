import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX,
  CODEX_RUNTIME_RECOVERY_PROMPT_VERSION,
  canInterruptCodexSession,
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
  assert.match(prompt, /Sandbox runtime restarted/);
  assert.match(prompt, /Do not repeat an external side effect/);
  assert.match(prompt, /wait for the user/);
  assert.throws(() => codexRuntimeRecoveryPrompt(999), /Unsupported/);
});

test("keeps server-running Sessions interruptible before a native snapshot arrives", () => {
  assert.equal(
    canInterruptCodexSession({
      nativeActiveTurnId: "turn-active",
      sessionRunning: true,
      localTurnPending: true,
    }),
    true,
  );
  assert.equal(
    canInterruptCodexSession({
      sessionRunning: true,
      localTurnPending: false,
    }),
    true,
  );
  assert.equal(
    canInterruptCodexSession({
      sessionRunning: true,
      localTurnPending: true,
    }),
    false,
  );
  assert.equal(
    canInterruptCodexSession({
      sessionRunning: false,
      localTurnPending: false,
    }),
    false,
  );
});
