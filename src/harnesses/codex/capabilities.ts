import type { CodexNativeSnapshot } from "./types";

export interface CodexTurnCapabilitySets {
  forkableTurnIds: ReadonlySet<string>;
  rewindableTurnIds: ReadonlySet<string>;
}

/** Keep native Turn fork and destructive rewind capabilities independent. */
export function codexTurnCapabilitySets(
  snapshot: CodexNativeSnapshot | null | undefined,
): CodexTurnCapabilitySets {
  return {
    forkableTurnIds: new Set(snapshot?.forkableTurnIds ?? []),
    rewindableTurnIds: new Set(snapshot?.rewindableTurnIds ?? []),
  };
}
