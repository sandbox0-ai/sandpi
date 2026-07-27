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
  supportsPersonality: boolean;
  fastServiceTier?: {
    id: string;
    name: string;
    description: string;
  };
}

interface NativeCodexModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  defaultReasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
  additionalSpeedTiers?: unknown;
  serviceTiers?: unknown;
  supportsPersonality?: unknown;
}

function reasoningEffortOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate): CodexReasoningEffortOption[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const option = candidate as {
      reasoningEffort?: unknown;
      description?: unknown;
    };
    if (
      typeof option.reasoningEffort !== "string" ||
      !option.reasoningEffort ||
      seen.has(option.reasoningEffort)
    ) {
      return [];
    }
    seen.add(option.reasoningEffort);
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

function fastServiceTier(model: NativeCodexModel) {
  if (
    !Array.isArray(model.additionalSpeedTiers) ||
    !model.additionalSpeedTiers.some(
      (tier) => typeof tier === "string" && tier.toLowerCase() === "fast",
    ) ||
    !Array.isArray(model.serviceTiers)
  ) {
    return undefined;
  }
  const serviceTiers = model.serviceTiers.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const tier = candidate as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
    };
    if (typeof tier.id !== "string" || !tier.id) return [];
    return [
      {
        id: tier.id,
        name: typeof tier.name === "string" ? tier.name : tier.id,
        description:
          typeof tier.description === "string" ? tier.description : tier.id,
      },
    ];
  });
  return (
    serviceTiers.find(
      (tier) =>
        tier.id.toLowerCase() === "fast" ||
        tier.name.toLowerCase() === "fast",
    ) ?? (serviceTiers.length === 1 ? serviceTiers[0] : undefined)
  );
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
  const seen = new Set<string>();
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
    if (!id || model.hidden === true || seen.has(id)) {
      return [];
    }
    seen.add(id);
    const supportedReasoningEfforts = reasoningEffortOptions(
      model.supportedReasoningEfforts,
    );
    const nativeDefaultReasoningEffort =
      typeof model.defaultReasoningEffort === "string"
        ? model.defaultReasoningEffort
        : "";
    const nativeFastServiceTier = fastServiceTier(model);
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
        supportsPersonality: model.supportsPersonality === true,
        ...(nativeFastServiceTier
          ? { fastServiceTier: nativeFastServiceTier }
          : {}),
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
