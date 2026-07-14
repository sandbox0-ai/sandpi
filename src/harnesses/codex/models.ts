export interface CodexModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
}

interface NativeCodexModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
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
        isDefault: model.isDefault === true,
      },
    ];
  });
}
