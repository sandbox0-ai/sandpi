export interface CodexModelOption {
  id: string;
  displayName: string;
}

/**
 * Codex-only prototype data. The production adapter must call app-server `model/list` for the
 * authenticated Environment and retain the returned Codex fields such as reasoning efforts,
 * input modalities and service tiers. This catalog must never move into a shared harness layer.
 */
const mockCodexModels: CodexModelOption[] = [
  { id: "gpt-5.2-codex", displayName: "GPT-5.2 Codex" },
  { id: "gpt-5.1-codex-max", displayName: "GPT-5.1 Max" },
  { id: "gpt-5.1-codex-mini", displayName: "GPT-5.1 Mini" },
];

export function getMockCodexModels() {
  return mockCodexModels;
}

export function getDefaultMockCodexModel() {
  return mockCodexModels[0];
}

export function getMockCodexModel(modelId: string) {
  return mockCodexModels.find((model) => model.id === modelId) ?? getDefaultMockCodexModel();
}
