export const CODEX_RUNTIME_RECOVERY_PROMPT_VERSION = 1;
export const CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX =
  "sandpi-runtime-recovery:";

const RECOVERY_PROMPTS: Record<number, string> = {
  1: [
    "Sandpi automatically started this recovery Turn because the Sandbox runtime",
    "restarted while the previous Turn was running. Inspect the persisted",
    "conversation, Workspace, Git state, and any relevant external state before",
    "continuing the original request. Do not repeat an external side effect unless",
    "you can verify that it did not already complete. If safe continuation cannot",
    "be established, explain what needs confirmation and wait for the user.",
  ].join(" "),
};

export function codexRuntimeRecoveryPrompt(version: number) {
  const prompt = RECOVERY_PROMPTS[version];
  if (!prompt) {
    throw new Error(`Unsupported Codex runtime recovery prompt version ${version}`);
  }
  return prompt;
}

export function isCodexRuntimeRecoveryClientMessageId(
  clientMessageId: string | null | undefined,
) {
  return clientMessageId?.startsWith(
    CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX,
  ) === true;
}

export function canInterruptCodexSession(input: {
  nativeActiveTurnId?: string;
  sessionRunning: boolean;
  localTurnPending: boolean;
}) {
  return Boolean(
    input.nativeActiveTurnId ||
      (input.sessionRunning && !input.localTurnPending),
  );
}
