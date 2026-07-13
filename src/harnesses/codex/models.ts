export interface CodexModelOption {
  id: string;
  displayName: string;
}

interface NativeCodexModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
}

/** Preserve the Codex-owned `model/list` result shape at the harness UI boundary. */
export function codexModelOptionsFromNativeResult(result: unknown) {
  if (!result || typeof result !== "object") {
    return [];
  }
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((candidate): CodexModelOption[] => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const model = candidate as NativeCodexModel;
    const id =
      typeof model.id === "string"
        ? model.id
        : typeof model.model === "string"
          ? model.model
          : undefined;
    if (!id || model.hidden === true) {
      return [];
    }
    return [
      {
        id,
        displayName:
          typeof model.displayName === "string" ? model.displayName : id,
      },
    ];
  });
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
