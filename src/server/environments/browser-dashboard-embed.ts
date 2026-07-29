import {
  BROWSER_DASHBOARD_DESKTOP_MIN_WIDTH,
  BROWSER_DASHBOARD_LOADING_MESSAGE,
  BROWSER_DASHBOARD_MOBILE_VIEWPORT,
  BROWSER_DASHBOARD_READY_MESSAGE,
  BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
  BROWSER_DASHBOARD_VIEWPORT_LIMITS,
  BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
  BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE,
  DEFAULT_BROWSER_DASHBOARD_VIEWPORT_MODE,
} from "@/lib/environment-browser";
import { isEnvironmentBrowserSessionName } from "./browser-session";

export const BROWSER_DASHBOARD_EMBED_MARKER =
  "data-sandpi-browser-dashboard";

export const BROWSER_DASHBOARD_EMBED_STYLE = `
<style ${BROWSER_DASHBOARD_EMBED_MARKER}>
  html.sandpi-browser-dashboard,
  html.sandpi-browser-dashboard body,
  html.sandpi-browser-dashboard #root,
  html.sandpi-browser-dashboard #root > .split-view {
    width: 100%;
    height: 100%;
  }

  html.sandpi-browser-dashboard.sandpi-browser-dashboard-integrated #root > .split-view.horizontal.sidebar-first > .split-view-sidebar,
  html.sandpi-browser-dashboard.sandpi-browser-dashboard-integrated #root > .split-view.horizontal.sidebar-first > .split-view-resizer,
  html.sandpi-browser-dashboard .settings-button-container {
    display: none !important;
  }

  html.sandpi-browser-dashboard.sandpi-browser-dashboard-integrated #root > .split-view.horizontal.sidebar-first > .split-view-main,
  html.sandpi-browser-dashboard .dashboard-shell-main,
  html.sandpi-browser-dashboard .dashboard-view,
  html.sandpi-browser-dashboard .dashboard-main,
  html.sandpi-browser-dashboard .viewport-wrapper,
  html.sandpi-browser-dashboard .viewport-main {
    width: 100%;
    min-width: 0;
    min-height: 0;
  }

  html.sandpi-browser-dashboard .viewport-main {
    align-items: stretch;
    justify-content: stretch;
  }

  html.sandpi-browser-dashboard .browser-window {
    width: 100% !important;
    height: 100% !important;
    max-width: none !important;
    max-height: none !important;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
</style>`;

function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function browserDashboardEmbedConfig(sessionName: string) {
  return scriptJson({
    defaultViewportMode: DEFAULT_BROWSER_DASHBOARD_VIEWPORT_MODE,
    desktopMinimumWidth: BROWSER_DASHBOARD_DESKTOP_MIN_WIDTH,
    loadingMessage: BROWSER_DASHBOARD_LOADING_MESSAGE,
    mobileViewport: BROWSER_DASHBOARD_MOBILE_VIEWPORT,
    readyMessage: BROWSER_DASHBOARD_READY_MESSAGE,
    sessionName,
    sessionReadyMessage: BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
    themeMessage: BROWSER_DASHBOARD_THEME_MESSAGE,
    tokenMap: BROWSER_DASHBOARD_THEME_TOKEN_MAP,
    viewportAppliedMessage: BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
    viewportLimits: BROWSER_DASHBOARD_VIEWPORT_LIMITS,
    viewportMessage: BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
    viewportModeMessage: BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE,
  });
}

export function browserDashboardEmbedScript(sessionName: string) {
  if (!isEnvironmentBrowserSessionName(sessionName)) {
    throw new Error("Invalid Sandpi Browser session name.");
  }
  return `
<script ${BROWSER_DASHBOARD_EMBED_MARKER}>
  (() => {
    const config = ${browserDashboardEmbedConfig(sessionName)};
    const root = document.documentElement;
    root.classList.add("sandpi-browser-dashboard");
    let selectedTargetTab;
    let observedScreen;
    let observedDisplay;
    let desiredViewport;
    let viewportMode = config.defaultViewportMode;
    let sessionReady = false;
    let loading = false;
    let loadingStartedAt = 0;
    let loadingFinishTimer;
    let loadingFallbackTimer;

    const post = (message) => window.parent.postMessage(message, "*");

    const setLoading = (nextLoading) => {
      if (loadingFinishTimer) {
        clearTimeout(loadingFinishTimer);
        loadingFinishTimer = undefined;
      }
      if (loadingFallbackTimer) {
        clearTimeout(loadingFallbackTimer);
        loadingFallbackTimer = undefined;
      }
      if (nextLoading) {
        loadingStartedAt = performance.now();
        loadingFallbackTimer = setTimeout(() => setLoading(false), 15_000);
      }
      if (loading === nextLoading) return;
      loading = nextLoading;
      post({ type: config.loadingMessage, loading });
    };

    const finishLoadingAfterFrame = () => {
      if (!loading) return;
      const remaining = Math.max(0, 240 - (performance.now() - loadingStartedAt));
      if (loadingFinishTimer) clearTimeout(loadingFinishTimer);
      loadingFinishTimer = setTimeout(() => setLoading(false), remaining);
    };

    const targetSession = () => {
      const sessions = document.querySelectorAll(".sidebar-session");
      return Array.from(sessions).find(
        (candidate) =>
          candidate.querySelector(".session-chip-name")?.textContent?.trim() ===
          config.sessionName,
      );
    };

    const selectTargetSession = () => {
      const session = targetSession();
      const options = session
        ? Array.from(session.querySelectorAll('[role="option"]'))
        : [];
      const selectedTab = session?.querySelector(
        '[role="option"][aria-selected="true"]',
      );
      const firstTab = options[0];
      const integrated = Boolean(session && firstTab);
      root.classList.toggle(
        "sandpi-browser-dashboard-integrated",
        integrated,
      );
      if (
        !sessionReady &&
        !selectedTab &&
        firstTab &&
        firstTab !== selectedTargetTab
      ) {
        selectedTargetTab = firstTab;
        firstTab.click();
      }
      // Each named Playwright attachment owns one current page pointer. The
      // official Dashboard remains the renderer; Sandpi only selects that
      // Session's assigned page and hides its global session/tab sidebar.
      if (!sessionReady && session && firstTab) {
        sessionReady = true;
        post({ type: config.sessionReadyMessage });
      }
    };

    const clampViewportDimension = (value, minimum, maximum) =>
      Math.min(maximum, Math.max(minimum, Math.round(value)));

    const viewportForBounds = (bounds) => {
      if (viewportMode === "mobile") return { ...config.mobileViewport };
      if (viewportMode === "responsive") {
        return {
          width: clampViewportDimension(
            bounds.width,
            config.viewportLimits.minWidth,
            config.viewportLimits.maxWidth,
          ),
          height: clampViewportDimension(
            bounds.height,
            config.viewportLimits.minHeight,
            config.viewportLimits.maxHeight,
          ),
        };
      }
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const desiredScale = Math.max(
        1,
        config.desktopMinimumWidth / width,
      );
      const maximumScale = Math.min(
        config.viewportLimits.maxWidth / width,
        config.viewportLimits.maxHeight / height,
      );
      const scale = Math.min(desiredScale, maximumScale);
      return {
        width: clampViewportDimension(
          width * scale,
          config.viewportLimits.minWidth,
          config.viewportLimits.maxWidth,
        ),
        height: clampViewportDimension(
          height * scale,
          config.viewportLimits.minHeight,
          config.viewportLimits.maxHeight,
        ),
      };
    };

    const reportViewport = () => {
      if (!observedScreen) return;
      const bounds = observedScreen.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const viewport = viewportForBounds(bounds);
      if (
        desiredViewport?.width === viewport.width &&
        desiredViewport?.height === viewport.height
      ) {
        return;
      }
      desiredViewport = viewport;
      setLoading(true);
      post({ type: config.viewportMessage, ...viewport });
      selectTargetSession();
    };

    const viewportObserver = new ResizeObserver(reportViewport);
    const observeScreen = () => {
      const screen = document.querySelector(".screen");
      if (screen !== observedScreen) {
        if (observedScreen) viewportObserver.unobserve(observedScreen);
        observedScreen = screen;
        if (observedScreen) {
          viewportObserver.observe(observedScreen);
          reportViewport();
        }
      }
      const display = document.querySelector("#display");
      if (display !== observedDisplay) {
        if (observedDisplay) {
          observedDisplay.removeEventListener("load", finishLoadingAfterFrame);
        }
        observedDisplay = display;
        if (observedDisplay) {
          observedDisplay.addEventListener("load", finishLoadingAfterFrame);
          if (observedDisplay.complete) finishLoadingAfterFrame();
        }
      }
    };

    const updateDashboardState = () => {
      observeScreen();
      selectTargetSession();
    };

    const sessionObserver = new MutationObserver(updateDashboardState);
    sessionObserver.observe(root, {
      attributes: true,
      attributeFilter: ["aria-selected", "src"],
      childList: true,
      subtree: true,
    });
    queueMicrotask(updateDashboardState);

    document.addEventListener(
      "click",
      (event) => {
        const target =
          event.target instanceof Element ? event.target : undefined;
        if (
          target?.closest(
            ".nav-btn",
          )
        ) {
          setLoading(true);
        }
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Enter" &&
          event.target instanceof Element &&
          event.target.closest(".omnibox")
        ) {
          setLoading(true);
        }
      },
      true,
    );

    const applyTheme = (message) => {
      if (
        !message ||
        message.type !== config.themeMessage ||
        !["system", "light", "dark"].includes(message.theme) ||
        !["light", "dark"].includes(message.resolvedTheme)
      ) {
        return;
      }

      const storedTheme =
        message.theme === "system" ? "system" : message.theme + "-mode";
      try {
        localStorage.setItem("theme", storedTheme);
      } catch {}

      root.classList.remove("light-mode", "dark-mode");
      root.classList.add(message.resolvedTheme + "-mode");
      root.style.colorScheme = message.resolvedTheme;

      const tokens =
        message.tokens && typeof message.tokens === "object"
          ? message.tokens
          : {};
      for (const [sourceName, targetNames] of Object.entries(config.tokenMap)) {
        const value = tokens[sourceName];
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 256
        ) {
          continue;
        }
        for (const targetName of targetNames)
          root.style.setProperty(targetName, value);
      }
    };

    const applyViewport = (message) => {
      if (
        !message ||
        message.type !== config.viewportAppliedMessage ||
        !Number.isInteger(message.width) ||
        message.width < config.viewportLimits.minWidth ||
        message.width > config.viewportLimits.maxWidth ||
        !Number.isInteger(message.height) ||
        message.height < config.viewportLimits.minHeight ||
        message.height > config.viewportLimits.maxHeight
      ) {
        return;
      }
      selectTargetSession();
    };

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      applyTheme(event.data);
      applyViewport(event.data);
      if (
        event.data?.type === config.viewportModeMessage &&
        ["desktop", "responsive", "mobile"].includes(event.data.mode)
      ) {
        viewportMode = event.data.mode;
        desiredViewport = undefined;
        reportViewport();
      }
    });
    post({ type: config.readyMessage });
  })();
</script>`;
}

export function embedBrowserDashboard(html: string, sessionName: string) {
  if (
    html.includes(BROWSER_DASHBOARD_EMBED_MARKER) ||
    !/<\/head\s*>/i.test(html)
  ) {
    return html;
  }
  const markup =
    browserDashboardEmbedScript(sessionName) + BROWSER_DASHBOARD_EMBED_STYLE;
  return html.replace(
    /<\/head\s*>/i,
    `${markup}\n</head>`,
  );
}
