export const CODEX_RUNTIME_RECOVERY_PROMPT_VERSION = 1;
export const CODEX_RUNTIME_RECOVERY_CLIENT_ID_PREFIX =
  "sandpi-runtime-recovery:";

const RECOVERY_PROMPTS: Record<number, string> = {
  1: [
    "Sandpi started this visible recovery Turn because the Sandbox or Codex",
    "runtime was replaced while the previous Turn was in progress. Recover the",
    "previous task without blindly repeating it. First inspect the persisted",
    "conversation, Workspace, Git state, and any relevant external state to",
    "determine what already completed. Continue only unfinished work that is safe",
    "to resume. Do not repeat an external side effect unless you can verify it did",
    "not already complete. If safe continuation cannot be established, explain",
    "what needs confirmation and wait for the user.",
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
