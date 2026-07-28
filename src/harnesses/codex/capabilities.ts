import type { CodexNativeSnapshot } from "./types";
import type { SessionStatus } from "@/lib/types";

export interface CodexTurnCapabilitySets {
  forkableTurnIds: ReadonlySet<string>;
}

export interface CodexInterruptProjectionState {
  nativeActiveTurnId?: string;
  sessionRunning: boolean;
  localTurnPending: boolean;
}

export type CodexComposerSubmissionTarget =
  | { kind: "start" }
  | { kind: "steer"; turnId: string };

/**
 * Select the native Codex input operation for the current composer state.
 * Same-Turn input requires the exact active Turn id; it must never silently
 * fall back to starting a second Turn.
 */
export function codexComposerSubmissionTarget(input: {
  nativeReady: boolean;
  turnRunning: boolean;
  activeTurnId?: string;
  sessionStatus: SessionStatus;
}): CodexComposerSubmissionTarget | undefined {
  if (!input.nativeReady) return undefined;
  if (input.turnRunning) {
    return input.activeTurnId
      ? { kind: "steer", turnId: input.activeTurnId }
      : undefined;
  }
  return input.sessionStatus === "waiting" ? { kind: "start" } : undefined;
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
