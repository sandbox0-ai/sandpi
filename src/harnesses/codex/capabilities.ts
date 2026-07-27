import type { CodexNativeSnapshot } from "./types";

export interface CodexTurnCapabilitySets {
  forkableTurnIds: ReadonlySet<string>;
}

export interface CodexInterruptProjectionState {
  nativeActiveTurnId?: string;
  sessionRunning: boolean;
  localTurnPending: boolean;
}

export function canInterruptCodexSession(
  input: CodexInterruptProjectionState,
) {
  return (
    input.sessionRunning &&
    Boolean(input.nativeActiveTurnId || !input.localTurnPending)
  );
}

/** Detect a completed Session whose browser-native projection is still active. */
export function shouldRefreshSettledCodexProjection(
  input: CodexInterruptProjectionState,
) {
  return Boolean(
    input.nativeActiveTurnId &&
      !input.sessionRunning &&
      !input.localTurnPending,
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
