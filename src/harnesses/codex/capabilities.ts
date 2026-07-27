import type { CodexNativeSnapshot } from "./types";

export interface CodexTurnCapabilitySets {
  forkableTurnIds: ReadonlySet<string>;
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

/** Derive the native Turns through which Codex can create a child Thread. */
export function codexTurnCapabilitySets(
  snapshot: CodexNativeSnapshot | null | undefined,
): CodexTurnCapabilitySets {
  return {
    forkableTurnIds: new Set(snapshot?.forkableTurnIds ?? []),
  };
}
