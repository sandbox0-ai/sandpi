import type { CodexNativeSnapshot } from "./types";

export interface CodexTurnCapabilitySets {
  forkableTurnIds: ReadonlySet<string>;
}

/** Derive the native Turns through which Codex can create a child Thread. */
export function codexTurnCapabilitySets(
  snapshot: CodexNativeSnapshot | null | undefined,
): CodexTurnCapabilitySets {
  return {
    forkableTurnIds: new Set(snapshot?.forkableTurnIds ?? []),
  };
}
