/**
 * Browser projections of native Codex v2 responses. Keep these aligned with
 * the Sandbox0-pinned @openai/codex 0.144.1 protocol; they normalize native
 * values but must not introduce alternate harness behavior.
 */
export interface CodexMemoriesSettings {
  featureEnabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
}

export function codexMemoriesFeatureToggleSettings(
  featureEnabled: boolean,
): CodexMemoriesSettings {
  return {
    featureEnabled,
    useMemories: featureEnabled,
    generateMemories: featureEnabled,
  };
}
