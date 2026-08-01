import {
  DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS,
  isEnvironmentMetricRangeSeconds,
  type EnvironmentMetricRangeSeconds,
} from "./environment-metrics";
import {
  DEFAULT_FILE_BROWSER_SIDEBAR_WIDTH,
  DEFAULT_INSPECTOR_WIDTH_RATIO,
  normalizeFileBrowserSidebarWidth,
  normalizeInspectorWidthRatio,
} from "./workspace-layout";
import {
  DEFAULT_BROWSER_DASHBOARD_VIEWPORT_MODE,
  type BrowserDashboardViewportMode,
} from "./environment-browser";

export const LOCAL_UI_PREFERENCES_STORAGE_KEY =
  "sandpi.local-ui-preferences.v1";
export const LOCAL_UI_PREFERENCES_CHANGED_EVENT =
  "sandpi:local-ui-preferences-changed";

export type LocalInspectorTab = "files" | "browser" | "activity" | "metrics";
export type LocalCodexSessionActivityFilter =
  "all" | "issues" | "external" | "commands" | "files" | "agents" | "system";

export interface LocalCodingAgentComposerPreference {
  environmentId: string;
  harness: string;
  sessionId?: string;
  modelId: string;
  reasoningEfforts: Record<string, string>;
  updatedAt: number;
}

export interface SandpiLocalUiPreferences {
  workspace: {
    sidebarCollapsed: boolean;
    inspectorOpen: boolean;
    inspectorTab: LocalInspectorTab;
    inspectorWidthRatio: number;
    fileBrowserSidebarCollapsed: boolean;
    fileBrowserSidebarWidth: number;
    browserViewportMode: BrowserDashboardViewportMode;
    metricsRangeSeconds: EnvironmentMetricRangeSeconds;
    terminalHeight: number;
  };
  filters: {
    codexSessionActivity: LocalCodexSessionActivityFilter;
  };
  dismissedSidebarTips: string[];
  codingAgentComposers: LocalCodingAgentComposerPreference[];
}

export const DEFAULT_LOCAL_UI_PREFERENCES: SandpiLocalUiPreferences = {
  workspace: {
    sidebarCollapsed: false,
    inspectorOpen: false,
    inspectorTab: "files",
    inspectorWidthRatio: DEFAULT_INSPECTOR_WIDTH_RATIO,
    fileBrowserSidebarCollapsed: false,
    fileBrowserSidebarWidth: DEFAULT_FILE_BROWSER_SIDEBAR_WIDTH,
    browserViewportMode: DEFAULT_BROWSER_DASHBOARD_VIEWPORT_MODE,
    metricsRangeSeconds: DEFAULT_ENVIRONMENT_METRIC_RANGE_SECONDS,
    terminalHeight: 320,
  },
  filters: {
    codexSessionActivity: "all",
  },
  dismissedSidebarTips: [],
  codingAgentComposers: [],
};

let cachedRawPreferences: string | null | undefined;
let cachedPreferences = DEFAULT_LOCAL_UI_PREFERENCES;

const INSPECTOR_TABS = ["files", "browser", "activity", "metrics"] as const;
const BROWSER_VIEWPORT_MODES = [
  "desktop",
  "responsive",
  "mobile",
] as const;
const CODEX_SESSION_ACTIVITY_FILTERS = [
  "all",
  "issues",
  "external",
  "commands",
  "files",
  "agents",
  "system",
] as const;
const MAX_CODING_AGENT_COMPOSER_PREFERENCES = 100;
const MAX_REASONING_EFFORTS_PER_COMPOSER = 50;
const MAX_DISMISSED_SIDEBAR_TIPS = 50;
const MIN_TERMINAL_HEIGHT = 190;
const MAX_STORED_TERMINAL_HEIGHT = 2_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
  fallback: T,
) {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : undefined;
}

function normalizedReasoningEfforts(value: unknown) {
  const source = record(value);
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, MAX_REASONING_EFFORTS_PER_COMPOSER)
      .flatMap(([modelId, effort]) => {
        const normalizedModelId = boundedString(modelId, 200);
        const normalizedEffort = boundedString(effort, 100);
        return normalizedModelId && normalizedEffort
          ? [[normalizedModelId, normalizedEffort]]
          : [];
      }),
  );
}

function normalizedComposerPreference(
  value: unknown,
): LocalCodingAgentComposerPreference | undefined {
  const source = record(value);
  const environmentId = boundedString(source.environmentId, 200);
  const harness = boundedString(source.harness, 64);
  const modelId = boundedString(source.modelId, 200);
  const sessionId =
    source.sessionId === undefined
      ? undefined
      : boundedString(source.sessionId, 200);
  const updatedAt =
    typeof source.updatedAt === "number" &&
    Number.isFinite(source.updatedAt) &&
    source.updatedAt > 0
      ? source.updatedAt
      : undefined;
  if (
    !environmentId ||
    !harness ||
    !modelId ||
    !updatedAt ||
    (source.sessionId !== undefined && !sessionId)
  ) {
    return undefined;
  }
  return {
    environmentId,
    harness,
    ...(sessionId ? { sessionId } : {}),
    modelId,
    reasoningEfforts: normalizedReasoningEfforts(source.reasoningEfforts),
    updatedAt,
  };
}

function composerPreferenceKey(
  preference: Pick<
    LocalCodingAgentComposerPreference,
    "environmentId" | "harness" | "sessionId"
  >,
) {
  return JSON.stringify([
    preference.environmentId,
    preference.harness,
    preference.sessionId ?? null,
  ]);
}

export function normalizeLocalUiPreferences(
  value: unknown,
): SandpiLocalUiPreferences {
  const source = record(value);
  const workspace = record(source.workspace);
  const filters = record(source.filters);
  const seenComposerKeys = new Set<string>();
  const dismissedSidebarTips = Array.from(
    new Set(
      (Array.isArray(source.dismissedSidebarTips)
        ? source.dismissedSidebarTips
        : []
      ).flatMap((candidate) => {
        const id = boundedString(candidate, 100);
        return id ? [id] : [];
      }),
    ),
  ).slice(0, MAX_DISMISSED_SIDEBAR_TIPS);
  const codingAgentComposers = (
    Array.isArray(source.codingAgentComposers)
      ? source.codingAgentComposers
      : []
  )
    .flatMap((candidate) => {
      const preference = normalizedComposerPreference(candidate);
      return preference ? [preference] : [];
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .filter((preference) => {
      const key = composerPreferenceKey(preference);
      if (seenComposerKeys.has(key)) return false;
      seenComposerKeys.add(key);
      return true;
    })
    .slice(0, MAX_CODING_AGENT_COMPOSER_PREFERENCES);
  const terminalHeight =
    typeof workspace.terminalHeight === "number" &&
    Number.isFinite(workspace.terminalHeight)
      ? Math.min(
          MAX_STORED_TERMINAL_HEIGHT,
          Math.max(MIN_TERMINAL_HEIGHT, Math.round(workspace.terminalHeight)),
        )
      : DEFAULT_LOCAL_UI_PREFERENCES.workspace.terminalHeight;
  const metricsRangeSeconds = Number(workspace.metricsRangeSeconds);

  return {
    workspace: {
      sidebarCollapsed:
        typeof workspace.sidebarCollapsed === "boolean"
          ? workspace.sidebarCollapsed
          : DEFAULT_LOCAL_UI_PREFERENCES.workspace.sidebarCollapsed,
      inspectorOpen:
        typeof workspace.inspectorOpen === "boolean"
          ? workspace.inspectorOpen
          : DEFAULT_LOCAL_UI_PREFERENCES.workspace.inspectorOpen,
      inspectorTab: oneOf(
        INSPECTOR_TABS,
        workspace.inspectorTab,
        DEFAULT_LOCAL_UI_PREFERENCES.workspace.inspectorTab,
      ),
      inspectorWidthRatio: normalizeInspectorWidthRatio(
        workspace.inspectorWidthRatio,
      ),
      fileBrowserSidebarCollapsed:
        typeof workspace.fileBrowserSidebarCollapsed === "boolean"
          ? workspace.fileBrowserSidebarCollapsed
          : DEFAULT_LOCAL_UI_PREFERENCES.workspace
              .fileBrowserSidebarCollapsed,
      fileBrowserSidebarWidth: normalizeFileBrowserSidebarWidth(
        workspace.fileBrowserSidebarWidth,
      ),
      browserViewportMode: oneOf(
        BROWSER_VIEWPORT_MODES,
        workspace.browserViewportMode,
        DEFAULT_LOCAL_UI_PREFERENCES.workspace.browserViewportMode,
      ),
      metricsRangeSeconds: isEnvironmentMetricRangeSeconds(metricsRangeSeconds)
        ? metricsRangeSeconds
        : DEFAULT_LOCAL_UI_PREFERENCES.workspace.metricsRangeSeconds,
      terminalHeight,
    },
    filters: {
      codexSessionActivity: oneOf(
        CODEX_SESSION_ACTIVITY_FILTERS,
        filters.codexSessionActivity,
        DEFAULT_LOCAL_UI_PREFERENCES.filters.codexSessionActivity,
      ),
    },
    dismissedSidebarTips,
    codingAgentComposers,
  };
}

export function parseLocalUiPreferences(raw: string | null) {
  if (!raw) return normalizeLocalUiPreferences(undefined);
  try {
    return normalizeLocalUiPreferences(JSON.parse(raw) as unknown);
  } catch {
    return normalizeLocalUiPreferences(undefined);
  }
}

export function loadLocalUiPreferences() {
  if (typeof window === "undefined") {
    return DEFAULT_LOCAL_UI_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_UI_PREFERENCES_STORAGE_KEY);
    if (raw === cachedRawPreferences) return cachedPreferences;
    cachedRawPreferences = raw;
    cachedPreferences = parseLocalUiPreferences(raw);
    return cachedPreferences;
  } catch {
    return DEFAULT_LOCAL_UI_PREFERENCES;
  }
}

export function saveLocalUiPreferences(value: unknown) {
  const preferences = normalizeLocalUiPreferences(value);
  if (typeof window === "undefined") return preferences;
  try {
    const serialized = JSON.stringify(preferences);
    window.localStorage.setItem(
      LOCAL_UI_PREFERENCES_STORAGE_KEY,
      serialized,
    );
    cachedRawPreferences = serialized;
    cachedPreferences = preferences;
    window.dispatchEvent(
      new CustomEvent<SandpiLocalUiPreferences>(
        LOCAL_UI_PREFERENCES_CHANGED_EVENT,
        { detail: preferences },
      ),
    );
  } catch {
    // Browser privacy settings and exhausted quotas must not break controls.
  }
  return preferences;
}

export function subscribeLocalUiPreferences(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (event.key === LOCAL_UI_PREFERENCES_STORAGE_KEY) listener();
  };
  window.addEventListener(LOCAL_UI_PREFERENCES_CHANGED_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(LOCAL_UI_PREFERENCES_CHANGED_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function updateLocalUiPreferences(
  update: (current: SandpiLocalUiPreferences) => SandpiLocalUiPreferences,
) {
  return saveLocalUiPreferences(update(loadLocalUiPreferences()));
}

export function dismissSidebarTip(tipId: string) {
  if (!boundedString(tipId, 100)) return loadLocalUiPreferences();
  return updateLocalUiPreferences((current) => ({
    ...current,
    dismissedSidebarTips: current.dismissedSidebarTips.includes(tipId)
      ? current.dismissedSidebarTips
      : [tipId, ...current.dismissedSidebarTips],
  }));
}

export function codingAgentComposerPreference(input: {
  environmentId: string;
  harness: string;
  sessionId?: string;
}) {
  const key = composerPreferenceKey(input);
  return loadLocalUiPreferences().codingAgentComposers.find(
    (preference) => composerPreferenceKey(preference) === key,
  );
}

export function rememberCodingAgentComposerPreference(input: {
  environmentId: string;
  harness: string;
  sessionId?: string;
  modelId: string;
  reasoningEfforts: Record<string, string>;
}) {
  const preference = normalizedComposerPreference({
    ...input,
    updatedAt: Date.now(),
  });
  if (!preference) return loadLocalUiPreferences();
  const key = composerPreferenceKey(preference);
  return updateLocalUiPreferences((current) => ({
    ...current,
    codingAgentComposers: [
      preference,
      ...current.codingAgentComposers.filter(
        (candidate) => composerPreferenceKey(candidate) !== key,
      ),
    ],
  }));
}
