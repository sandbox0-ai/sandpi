import {
  BROWSER_DASHBOARD_COMMAND_MESSAGE,
  BROWSER_DASHBOARD_DESKTOP_MIN_WIDTH,
  BROWSER_DASHBOARD_LOADING_MESSAGE,
  BROWSER_DASHBOARD_MOBILE_VIEWPORT,
  BROWSER_DASHBOARD_READY_MESSAGE,
  BROWSER_DASHBOARD_SESSION_NAME,
  BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  BROWSER_DASHBOARD_TABS_MESSAGE,
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
  BROWSER_DASHBOARD_VIEWPORT_LIMITS,
  BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
  BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE,
  DEFAULT_BROWSER_DASHBOARD_VIEWPORT_MODE,
} from "@/lib/environment-browser";

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

const browserDashboardEmbedConfig = scriptJson({
  commandMessage: BROWSER_DASHBOARD_COMMAND_MESSAGE,
  defaultViewportMode: DEFAULT_BROWSER_DASHBOARD_VIEWPORT_MODE,
  desktopMinimumWidth: BROWSER_DASHBOARD_DESKTOP_MIN_WIDTH,
  loadingMessage: BROWSER_DASHBOARD_LOADING_MESSAGE,
  mobileViewport: BROWSER_DASHBOARD_MOBILE_VIEWPORT,
  readyMessage: BROWSER_DASHBOARD_READY_MESSAGE,
  sessionName: BROWSER_DASHBOARD_SESSION_NAME,
  sessionReadyMessage: BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  tabsMessage: BROWSER_DASHBOARD_TABS_MESSAGE,
  themeMessage: BROWSER_DASHBOARD_THEME_MESSAGE,
  tokenMap: BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  viewportAppliedMessage: BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
  viewportLimits: BROWSER_DASHBOARD_VIEWPORT_LIMITS,
  viewportMessage: BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
  viewportModeMessage: BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE,
});

export const BROWSER_DASHBOARD_WEBSOCKET_COMPAT_SCRIPT = `
  (() => {
    const NativeWebSocket = window.WebSocket;
    if (
      !NativeWebSocket ||
      NativeWebSocket.__sandpiRelativeUrlCompatibility
    ) {
      return;
    }

    class SandpiBrowserWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        let resolvedUrl = url;
        if (
          typeof url === "string" &&
          !/^[a-z][a-z0-9+.-]*:/i.test(url)
        ) {
          const target = new URL(url, window.location.href);
          target.protocol =
            target.protocol === "https:" ? "wss:" : "ws:";
          resolvedUrl = target.toString();
        }
        if (protocols === undefined) super(resolvedUrl);
        else super(resolvedUrl, protocols);
      }
    }

    Object.defineProperty(
      SandpiBrowserWebSocket,
      "__sandpiRelativeUrlCompatibility",
      { value: true },
    );
    window.WebSocket = SandpiBrowserWebSocket;
  })();
`;

export const BROWSER_DASHBOARD_EMBED_SCRIPT = `
<script ${BROWSER_DASHBOARD_EMBED_MARKER}>
  ${BROWSER_DASHBOARD_WEBSOCKET_COMPAT_SCRIPT}
  (() => {
    const config = ${browserDashboardEmbedConfig};
    const root = document.documentElement;
    root.classList.add("sandpi-browser-dashboard");
    let selectedDefaultTab;
    let observedScreen;
    let observedDisplay;
    let desiredViewport;
    let viewportMode = config.defaultViewportMode;
    let sessionReady = false;
    let pendingCommand;
    let lastTabsPayload = "";
    let lastSelectedLocation;
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

    const defaultSession = () => {
      const sessions = document.querySelectorAll(".sidebar-session");
      return Array.from(sessions).find(
        (candidate) =>
          candidate.querySelector(".session-chip-name")?.textContent?.trim() ===
          config.sessionName,
      );
    };

    const cleanText = (value, maximumLength) =>
      typeof value === "string"
        ? value.trim().slice(0, maximumLength)
        : "";

    const collectTabs = () => {
      const session = defaultSession();
      const options = session
        ? Array.from(session.querySelectorAll('[role="option"]'))
        : [];
      const newTabButton = session?.querySelector(
        '.sidebar-session-new-tab, button[aria-label="New tab"]',
      );
      const closeControlsAvailable = options.every((option) =>
        option.querySelector(
          '.sidebar-tab-close, button[aria-label^="Close"]',
        ),
      );
      const integrated = Boolean(
        session &&
          newTabButton &&
          options.length &&
          closeControlsAvailable,
      );
      root.classList.toggle(
        "sandpi-browser-dashboard-integrated",
        integrated,
      );
      const tabs = options.slice(0, 100).map((option, index) => {
        const title = cleanText(
          option.querySelector(".sidebar-tab-title")?.textContent ||
            option.getAttribute("aria-label") ||
            option.getAttribute("title") ||
            "",
          2_000,
        );
        const url = cleanText(
          option.querySelector(".sidebar-tab-url")?.textContent || "",
          8_192,
        );
        return {
          index,
          title,
          url,
          selected: option.getAttribute("aria-selected") === "true",
        };
      });
      const selected = tabs.find((tab) => tab.selected);
      const selectedLocation = selected
        ? selected.index + ":" + selected.url
        : undefined;
      if (
        lastSelectedLocation !== undefined &&
        selectedLocation !== undefined &&
        selectedLocation !== lastSelectedLocation
      ) {
        setLoading(true);
      }
      lastSelectedLocation = selectedLocation;
      const payload = JSON.stringify({ integrated, tabs });
      if (payload !== lastTabsPayload) {
        lastTabsPayload = payload;
        post({ type: config.tabsMessage, integrated, tabs });
      }
      return { session, options, integrated };
    };

    const applyPendingCommand = () => {
      if (!pendingCommand) return;
      const { session, options, integrated } = collectTabs();
      if (!integrated || !session) return;
      let target;
      if (pendingCommand.action === "new") {
        target = session.querySelector(
          '.sidebar-session-new-tab, button[aria-label="New tab"]',
        );
      } else if (
        Number.isInteger(pendingCommand.index) &&
        pendingCommand.index >= 0 &&
        pendingCommand.index < options.length
      ) {
        const option = options[pendingCommand.index];
        target =
          pendingCommand.action === "select"
            ? option
            : option.querySelector(
                '.sidebar-tab-close, button[aria-label^="Close"]',
              );
      }
      if (!target || typeof target.click !== "function") return;
      pendingCommand = undefined;
      setLoading(true);
      target.click();
    };

    const selectDefaultSession = () => {
      const { session, options } = collectTabs();
      const selectedTab = session?.querySelector(
        '[role="option"][aria-selected="true"]',
      );
      const firstTab = options[0];
      if (
        !sessionReady &&
        !selectedTab &&
        firstTab &&
        firstTab !== selectedDefaultTab
      ) {
        selectedDefaultTab = firstTab;
        firstTab.click();
      }
      // Viewport reconciliation runs in the background. Reveal the official
      // Dashboard as soon as its shared session exists instead of holding a
      // fixed overlay until a resized screencast frame happens to arrive.
      if (!sessionReady && session && firstTab) {
        sessionReady = true;
        post({ type: config.sessionReadyMessage });
      }
      applyPendingCommand();
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
      selectDefaultSession();
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
      selectDefaultSession();
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
            ".nav-btn, .sidebar-session-new-tab, .sidebar-tab-close",
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
      selectDefaultSession();
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
      if (
        event.data?.type === config.commandMessage &&
        ["new", "select", "close"].includes(event.data.action) &&
        (event.data.index === undefined ||
          (Number.isInteger(event.data.index) &&
            event.data.index >= 0 &&
            event.data.index < 100))
      ) {
        pendingCommand = {
          action: event.data.action,
          index: event.data.index,
        };
        applyPendingCommand();
      }
    });
    // Keep the official Dashboard usable if an upstream markup change makes
    // Sandpi's optional session projection unavailable.
    setTimeout(() => {
      if (sessionReady) return;
      sessionReady = true;
      post({ type: config.sessionReadyMessage });
    }, 5_000);
    post({ type: config.readyMessage });
  })();
</script>`;

export const BROWSER_DASHBOARD_EMBED_MARKUP =
  BROWSER_DASHBOARD_EMBED_SCRIPT + BROWSER_DASHBOARD_EMBED_STYLE;

export function embedBrowserDashboard(html: string) {
  if (
    html.includes(BROWSER_DASHBOARD_EMBED_MARKER) ||
    !/<\/head\s*>/i.test(html)
  ) {
    return html;
  }
  return html.replace(
    /<\/head\s*>/i,
    `${BROWSER_DASHBOARD_EMBED_MARKUP}\n</head>`,
  );
}
