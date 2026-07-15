import type { CodexNativeSnapshot } from "./types";

export interface CodexTurnCapabilitySets {
  forkableTurnIds: ReadonlySet<string>;
  mutableTurnIds: ReadonlySet<string>;
}

/** Keep native Turn fork and in-place product history mutation independent. */
export function codexTurnCapabilitySets(
  snapshot: CodexNativeSnapshot | null | undefined,
): CodexTurnCapabilitySets {
  return {
    forkableTurnIds: new Set(snapshot?.forkableTurnIds ?? []),
    mutableTurnIds: new Set(snapshot?.mutableTurnIds ?? []),
  };
}
