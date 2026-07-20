import type { SandpiPreferences } from "./types";

export const CLIENT_PREFERENCES_STORAGE_KEY = "sandpi.preferences.v1";
export const CLIENT_PREFERENCES_CHANGED_EVENT = "sandpi:preferences-changed";
export const DEFAULT_CLIENT_PREFERENCES: SandpiPreferences = {
  general: {
    language: "en",
    timeZone: "auto",
    sendShortcut: "enter",
  },
  appearance: {
    theme: "system",
    density: "comfortable",
  },
};

const languageValues = ["en", "zh-CN"] as const;
const sendShortcutValues = ["enter", "mod-enter"] as const;
const themeValues = ["system", "light", "dark"] as const;
const densityValues = ["comfortable", "compact"] as const;

const themeVariables = {
  light: {
    "--canvas": "#f7f6f2",
    "--sidebar": "#efeee9",
    "--panel": "#fbfaf7",
    "--panel-strong": "#ffffff",
    "--ink": "#171716",
    "--ink-soft": "#62615c",
    "--ink-faint": "#8a8982",
    "--line": "#deddd7",
    "--line-soft": "#ebe9e3",
    "--hover": "#e8e6df",
    "--selected": "#dfddd5",
    "--green": "#258658",
    "--green-soft": "#e8f3ec",
    "--amber": "#a96d22",
    "--amber-soft": "#f6ecdc",
    "--red": "#b6483e",
    "--red-soft": "#f7e8e6",
    "--blue": "#416d9d",
    "--blue-soft": "#e8eef6",
  },
  dark: {
    "--canvas": "#181817",
    "--sidebar": "#20201e",
    "--panel": "#222220",
    "--panel-strong": "#292927",
    "--ink": "#f0efe9",
    "--ink-soft": "#b6b3aa",
    "--ink-faint": "#a7a49c",
    "--line": "#3b3a36",
    "--line-soft": "#302f2c",
    "--hover": "#31302d",
    "--selected": "#3b3a35",
    "--green": "#62bb88",
    "--green-soft": "#20382a",
    "--amber": "#d5a259",
    "--amber-soft": "#3b3020",
    "--red": "#df786f",
    "--red-soft": "#402724",
    "--blue": "#82a9d4",
    "--blue-soft": "#243548",
  },
} as const;

type ResolvedTheme = keyof typeof themeVariables;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function normalizeClientPreferences(
  value: unknown,
  defaults: SandpiPreferences,
): SandpiPreferences {
  const source = isRecord(value) ? value : {};
  const general = isRecord(source.general) ? source.general : {};
  const appearance = isRecord(source.appearance) ? source.appearance : {};

  return {
    general: {
      language: includes(languageValues, general.language)
        ? general.language
        : defaults.general.language,
      timeZone:
        typeof general.timeZone === "string" && general.timeZone.length > 0
          ? general.timeZone
          : defaults.general.timeZone,
      sendShortcut: includes(sendShortcutValues, general.sendShortcut)
        ? general.sendShortcut
        : defaults.general.sendShortcut,
    },
    appearance: {
      theme: includes(themeValues, appearance.theme)
        ? appearance.theme
        : defaults.appearance.theme,
      density: includes(densityValues, appearance.density)
        ? appearance.density
        : defaults.appearance.density,
    },
  };
}

export function parseClientPreferences(
  raw: string | null,
  defaults: SandpiPreferences,
): SandpiPreferences {
  if (!raw) {
    return normalizeClientPreferences(undefined, defaults);
  }

  try {
    return normalizeClientPreferences(JSON.parse(raw) as unknown, defaults);
  } catch {
    return normalizeClientPreferences(undefined, defaults);
  }
}

export function loadClientPreferences(
  defaults: SandpiPreferences,
): SandpiPreferences {
  if (typeof window === "undefined") {
    return normalizeClientPreferences(undefined, defaults);
  }

  try {
    return parseClientPreferences(
      window.localStorage.getItem(CLIENT_PREFERENCES_STORAGE_KEY),
      defaults,
    );
  } catch {
    return normalizeClientPreferences(undefined, defaults);
  }
}

export function buildAppearancePreviewPreferences(
  baseline: SandpiPreferences,
  appearance: SandpiPreferences["appearance"],
): SandpiPreferences {
  return {
    ...baseline,
    appearance: { ...appearance },
  };
}

let stopWatchingSystemTheme: (() => void) | undefined;

function setThemeVariables(
  root: HTMLElement,
  resolvedTheme: ResolvedTheme,
) {
  for (const [name, value] of Object.entries(themeVariables[resolvedTheme])) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = resolvedTheme;
  root.dataset.resolvedTheme = resolvedTheme;
}

export function applyClientPreferences(preferences: SandpiPreferences) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.lang = preferences.general.language;
  root.dataset.language = preferences.general.language;
  root.dataset.theme = preferences.appearance.theme;
  root.dataset.density = preferences.appearance.density;
  root.dataset.timeZone = preferences.general.timeZone;
  root.dataset.sendShortcut = preferences.general.sendShortcut;

  stopWatchingSystemTheme?.();
  stopWatchingSystemTheme = undefined;

  if (
    preferences.appearance.theme === "system" &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () =>
      setThemeVariables(root, query.matches ? "dark" : "light");
    applySystemTheme();
    query.addEventListener("change", applySystemTheme);
    stopWatchingSystemTheme = () =>
      query.removeEventListener("change", applySystemTheme);
    return;
  }

  setThemeVariables(
    root,
    preferences.appearance.theme === "dark" ? "dark" : "light",
  );
}

export function saveClientPreferences(preferences: SandpiPreferences) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    CLIENT_PREFERENCES_STORAGE_KEY,
    JSON.stringify(preferences),
  );
  applyClientPreferences(preferences);
  window.dispatchEvent(
    new CustomEvent<SandpiPreferences>(CLIENT_PREFERENCES_CHANGED_EVENT, {
      detail: preferences,
    }),
  );
}

function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function getClientPreferencesBootstrapScript(
  defaults: SandpiPreferences,
) {
  return `(() => {
    const defaults = ${scriptJson(defaults)};
    const themes = ${scriptJson(themeVariables)};
    const allowed = {
      language: ${scriptJson(languageValues)},
      sendShortcut: ${scriptJson(sendShortcutValues)},
      theme: ${scriptJson(themeValues)},
      density: ${scriptJson(densityValues)}
    };
    const includes = (values, value) => typeof value === "string" && values.includes(value);
    const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
    try {
      const stored = record(JSON.parse(localStorage.getItem(${scriptJson(CLIENT_PREFERENCES_STORAGE_KEY)}) || "{}"));
      const general = record(stored.general);
      const appearance = record(stored.appearance);
      const preferences = {
        general: {
          language: includes(allowed.language, general.language) ? general.language : defaults.general.language,
          timeZone: typeof general.timeZone === "string" && general.timeZone ? general.timeZone : defaults.general.timeZone,
          sendShortcut: includes(allowed.sendShortcut, general.sendShortcut) ? general.sendShortcut : defaults.general.sendShortcut
        },
        appearance: {
          theme: includes(allowed.theme, appearance.theme) ? appearance.theme : defaults.appearance.theme,
          density: includes(allowed.density, appearance.density) ? appearance.density : defaults.appearance.density
        }
      };
      const root = document.documentElement;
      const applyTheme = () => {
        const resolved = preferences.appearance.theme === "system"
          ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
          : preferences.appearance.theme;
        Object.entries(themes[resolved]).forEach(([name, value]) => root.style.setProperty(name, value));
        root.style.colorScheme = resolved;
        root.dataset.resolvedTheme = resolved;
      };
      root.lang = preferences.general.language;
      root.dataset.language = preferences.general.language;
      root.dataset.theme = preferences.appearance.theme;
      root.dataset.density = preferences.appearance.density;
      root.dataset.timeZone = preferences.general.timeZone;
      root.dataset.sendShortcut = preferences.general.sendShortcut;
      applyTheme();
      if (preferences.appearance.theme === "system") {
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
      }
    } catch {}
  })();`;
}
