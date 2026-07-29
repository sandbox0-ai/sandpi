const SANDBOX_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export const BROWSER_DASHBOARD_READY_MESSAGE =
  "sandpi:browser-dashboard-ready";
export const BROWSER_DASHBOARD_SESSION_READY_MESSAGE =
  "sandpi:browser-dashboard-session-ready";
export const BROWSER_DASHBOARD_THEME_MESSAGE =
  "sandpi:browser-dashboard-theme";
export const BROWSER_DASHBOARD_VIEWPORT_MESSAGE =
  "sandpi:browser-dashboard-viewport";
export const BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE =
  "sandpi:browser-dashboard-viewport-applied";
export const BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE =
  "sandpi:browser-dashboard-viewport-mode";
export const BROWSER_DASHBOARD_LOADING_MESSAGE =
  "sandpi:browser-dashboard-loading";
export const DEFAULT_BROWSER_DASHBOARD_VIEWPORT_MODE = "desktop";
export const BROWSER_DASHBOARD_DESKTOP_MIN_WIDTH = 1_280;
export const BROWSER_DASHBOARD_MOBILE_VIEWPORT = {
  width: 390,
  height: 844,
} as const;
export const BROWSER_DASHBOARD_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3_840,
  minHeight: 240,
  maxHeight: 2_160,
} as const;

export const BROWSER_DASHBOARD_THEME_TOKEN_MAP = {
  "--canvas": ["--color-canvas-default"],
  "--sidebar": ["--color-canvas-inset", "--color-canvas-subtle"],
  "--panel": ["--color-canvas-overlay"],
  "--panel-strong": ["--color-btn-bg"],
  "--ink": ["--color-fg-default"],
  "--ink-soft": ["--color-fg-muted"],
  "--ink-faint": ["--color-fg-subtle"],
  "--line": ["--color-border-default", "--vscode-panel-border"],
  "--line-soft": ["--color-border-muted"],
  "--hover": ["--color-neutral-subtle"],
  "--selected": ["--color-neutral-muted"],
  "--green": ["--color-success-fg"],
  "--green-soft": ["--color-success-subtle"],
  "--amber": ["--color-attention-fg"],
  "--amber-soft": ["--color-attention-subtle"],
  "--red": ["--color-danger-fg"],
  "--red-soft": ["--color-danger-subtle"],
  "--blue": ["--color-accent-emphasis", "--color-accent-fg"],
  "--blue-soft": ["--color-accent-muted", "--color-accent-subtle"],
  "--shadow-lg": ["--color-overlay-shadow"],
} as const;

export type BrowserDashboardTheme = "system" | "light" | "dark";
export type BrowserDashboardResolvedTheme = "light" | "dark";
export type BrowserDashboardViewportMode =
  | "desktop"
  | "responsive"
  | "mobile";
export interface BrowserDashboardThemeMessage {
  type: typeof BROWSER_DASHBOARD_THEME_MESSAGE;
  theme: BrowserDashboardTheme;
  resolvedTheme: BrowserDashboardResolvedTheme;
  tokens: Record<string, string>;
}

export interface BrowserDashboardViewport {
  width: number;
  height: number;
}

export interface BrowserDashboardViewportMessage
  extends BrowserDashboardViewport {
  type: typeof BROWSER_DASHBOARD_VIEWPORT_MESSAGE;
}

export interface BrowserDashboardViewportAppliedMessage
  extends BrowserDashboardViewport {
  type: typeof BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE;
}

export interface BrowserDashboardViewportModeMessage {
  type: typeof BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE;
  mode: BrowserDashboardViewportMode;
}

export interface BrowserDashboardLoadingMessage {
  type: typeof BROWSER_DASHBOARD_LOADING_MESSAGE;
  loading: boolean;
}

export function isBrowserDashboardViewportMode(
  value: unknown,
): value is BrowserDashboardViewportMode {
  return (
    value === "desktop" || value === "responsive" || value === "mobile"
  );
}

export function resolveBrowserDashboardViewport(
  bounds: BrowserDashboardViewport,
  mode: BrowserDashboardViewportMode,
): BrowserDashboardViewport {
  if (mode === "mobile") return { ...BROWSER_DASHBOARD_MOBILE_VIEWPORT };

  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(maximum, Math.max(minimum, Math.round(value)));
  if (mode === "responsive") {
    return {
      width: clamp(
        bounds.width,
        BROWSER_DASHBOARD_VIEWPORT_LIMITS.minWidth,
        BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxWidth,
      ),
      height: clamp(
        bounds.height,
        BROWSER_DASHBOARD_VIEWPORT_LIMITS.minHeight,
        BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxHeight,
      ),
    };
  }

  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const desiredScale = Math.max(
    1,
    BROWSER_DASHBOARD_DESKTOP_MIN_WIDTH / width,
  );
  const maximumScale = Math.min(
    BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxWidth / width,
    BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxHeight / height,
  );
  const scale = Math.min(desiredScale, maximumScale);
  return {
    width: clamp(
      width * scale,
      BROWSER_DASHBOARD_VIEWPORT_LIMITS.minWidth,
      BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxWidth,
    ),
    height: clamp(
      height * scale,
      BROWSER_DASHBOARD_VIEWPORT_LIMITS.minHeight,
      BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxHeight,
    ),
  };
}

export function isBrowserDashboardViewport(
  value: unknown,
): value is BrowserDashboardViewport {
  if (typeof value !== "object" || value === null) return false;
  const viewport = value as Record<string, unknown>;
  return (
    typeof viewport.width === "number" &&
    Number.isInteger(viewport.width) &&
    viewport.width >= BROWSER_DASHBOARD_VIEWPORT_LIMITS.minWidth &&
    viewport.width <= BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxWidth &&
    typeof viewport.height === "number" &&
    Number.isInteger(viewport.height) &&
    viewport.height >= BROWSER_DASHBOARD_VIEWPORT_LIMITS.minHeight &&
    viewport.height <= BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxHeight
  );
}

export function isBrowserDashboardViewportMessage(
  value: unknown,
): value is BrowserDashboardViewportMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === BROWSER_DASHBOARD_VIEWPORT_MESSAGE &&
    isBrowserDashboardViewport(value)
  );
}

export function isBrowserDashboardReadyMessage(
  value: unknown,
): value is { type: typeof BROWSER_DASHBOARD_READY_MESSAGE } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === BROWSER_DASHBOARD_READY_MESSAGE
  );
}

export function isBrowserDashboardSessionReadyMessage(
  value: unknown,
): value is { type: typeof BROWSER_DASHBOARD_SESSION_READY_MESSAGE } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === BROWSER_DASHBOARD_SESSION_READY_MESSAGE
  );
}

export function isBrowserDashboardLoadingMessage(
  value: unknown,
): value is BrowserDashboardLoadingMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === BROWSER_DASHBOARD_LOADING_MESSAGE &&
    "loading" in value &&
    typeof value.loading === "boolean"
  );
}

/**
 * Returns an HTTP URL that intentionally resolves inside the Environment
 * browser, not on the Sandpi user's device.
 */
export function sandboxLoopbackUrl(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  const candidate =
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(
      trimmed,
    )
      ? `http://${trimmed}`
      : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !SANDBOX_LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    return undefined;
  }
  return url.toString();
}
