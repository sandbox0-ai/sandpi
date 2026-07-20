export interface CodexReasoningEffortOption {
  id: string;
  description: string;
}

export interface CodexModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
}

interface NativeCodexModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
}

function reasoningEffortOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): CodexReasoningEffortOption[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const option = candidate as {
      reasoningEffort?: unknown;
      description?: unknown;
    };
    if (
      typeof option.reasoningEffort !== "string" ||
      !option.reasoningEffort
    ) {
      return [];
    }
    return [
      {
        id: option.reasoningEffort,
        description:
          typeof option.description === "string"
            ? option.description
            : option.reasoningEffort,
      },
    ];
  });
}

/**
 * Project the live Codex-owned `model/list` response at the harness UI boundary.
 * Model ids, reasoning-effort ids, defaults and availability are runtime capabilities: never
 * enumerate them in Sandpi. Arbitrary future effort ids remain strings and pass through unchanged.
 */
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
    const supportedReasoningEfforts = reasoningEffortOptions(
      model.supportedReasoningEfforts,
    );
    const nativeDefaultReasoningEffort =
      typeof model.defaultReasoningEffort === "string"
        ? model.defaultReasoningEffort
        : "";
    return [
      {
        id,
        displayName:
          typeof model.displayName === "string" ? model.displayName : id,
        isDefault: model.isDefault === true,
        defaultReasoningEffort: supportedReasoningEfforts.some(
          (option) => option.id === nativeDefaultReasoningEffort,
        )
          ? nativeDefaultReasoningEffort
          : (supportedReasoningEfforts[0]?.id ?? ""),
        supportedReasoningEfforts,
      },
    ];
  });
}

export function codexDefaultModel(options: readonly CodexModelOption[]) {
  return options.find((model) => model.isDefault) ?? options[0];
}

export function codexReasoningEffortForModel(
  model: CodexModelOption | undefined,
  requestedEffort: string | undefined,
) {
  if (!model) return "";
  return model.supportedReasoningEfforts.some(
    (option) => option.id === requestedEffort,
  )
    ? requestedEffort!
    : model.defaultReasoningEffort;
}

/**
 * Reconciles an opaque browser preference against the current native catalog.
 * Coding-agent upgrades may remove or add models and effort values, so stored
 * strings never become a fallback catalog or bypass live capability discovery.
 */
export function reconcileCodexComposerPreference(
  models: readonly CodexModelOption[],
  preference?: {
    modelId?: string;
    reasoningEfforts?: Record<string, string>;
  },
) {
  const model =
    models.find((candidate) => candidate.id === preference?.modelId) ??
    codexDefaultModel(models);
  const reasoningEfforts = Object.fromEntries(
    models.map((candidate) => [
      candidate.id,
      codexReasoningEffortForModel(
        candidate,
        preference?.reasoningEfforts?.[candidate.id],
      ),
    ]),
  );
  return { model, reasoningEfforts };
}

export function codexReasoningEffortLabel(effort: string) {
  if (effort === "xhigh") return "Extra high";
  return effort
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
