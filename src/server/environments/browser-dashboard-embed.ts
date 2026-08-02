import {
  BROWSER_DASHBOARD_READY_MESSAGE,
  BROWSER_DASHBOARD_SESSION_NAME,
  BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  BROWSER_DASHBOARD_VIEWPORT_LIMITS,
  BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
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
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  html.sandpi-browser-dashboard #root {
    visibility: hidden;
  }

  html.sandpi-browser-dashboard.sandpi-browser-dashboard-ready #root {
    visibility: visible;
  }

  html.sandpi-browser-dashboard #root > .split-view.horizontal.sidebar-first > .split-view-sidebar,
  html.sandpi-browser-dashboard #root > .split-view.horizontal.sidebar-first > .split-view-resizer,
  html.sandpi-browser-dashboard .dashboard-main > .toolbar,
  html.sandpi-browser-dashboard .browser-window > .browser-chrome,
  html.sandpi-browser-dashboard .dashboard-view > :not(.dashboard-main),
  html.sandpi-browser-dashboard .settings-button-container {
    display: none !important;
  }

  html.sandpi-browser-dashboard #root > .split-view.horizontal.sidebar-first > .split-view-main,
  html.sandpi-browser-dashboard .dashboard-shell-main,
  html.sandpi-browser-dashboard .dashboard-view,
  html.sandpi-browser-dashboard .dashboard-main,
  html.sandpi-browser-dashboard .viewport-wrapper,
  html.sandpi-browser-dashboard .viewport-main,
  html.sandpi-browser-dashboard .browser-window,
  html.sandpi-browser-dashboard .screen {
    width: 100% !important;
    height: 100% !important;
    min-width: 0;
    min-height: 0;
  }

  html.sandpi-browser-dashboard #root > .split-view.horizontal.sidebar-first > .split-view-main,
  html.sandpi-browser-dashboard .dashboard-main,
  html.sandpi-browser-dashboard .viewport-wrapper,
  html.sandpi-browser-dashboard .viewport-main,
  html.sandpi-browser-dashboard .screen {
    flex: 1 1 auto;
  }

  html.sandpi-browser-dashboard .viewport-main {
    align-items: stretch;
    justify-content: stretch;
  }

  html.sandpi-browser-dashboard .browser-window {
    max-width: none !important;
    max-height: none !important;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  html.sandpi-browser-dashboard .screen,
  html.sandpi-browser-dashboard .screen-overlay {
    pointer-events: none !important;
    user-select: none;
  }

  html.sandpi-browser-dashboard #display {
    width: 100% !important;
    height: 100% !important;
    object-fit: contain;
  }
</style>`;

function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const browserDashboardEmbedConfig = scriptJson({
  readyMessage: BROWSER_DASHBOARD_READY_MESSAGE,
  sessionName: BROWSER_DASHBOARD_SESSION_NAME,
  sessionReadyMessage: BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  themeMessage: BROWSER_DASHBOARD_THEME_MESSAGE,
  tokenMap: BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  viewportLimits: BROWSER_DASHBOARD_VIEWPORT_LIMITS,
  viewportMessage: BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
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
    let desiredViewport;
    let sessionReady = false;

    const post = (message) => window.parent.postMessage(message, "*");

    const defaultSession = () => {
      const sessions = document.querySelectorAll(".sidebar-session");
      return Array.from(sessions).find(
        (candidate) =>
          candidate.querySelector(".session-chip-name")?.textContent?.trim() ===
          config.sessionName,
      );
    };

    const selectDefaultSession = () => {
      const session = defaultSession();
      const options = session
        ? Array.from(session.querySelectorAll('[role="option"]'))
        : [];
      const selectedTab = session?.querySelector(
        '[role="option"][aria-selected="true"]',
      );
      const firstTab = options[0];
      if (
        !selectedTab &&
        firstTab &&
        firstTab !== selectedDefaultTab
      ) {
        selectedDefaultTab = firstTab;
        firstTab.click();
      }
      const screenBounds = observedScreen?.getBoundingClientRect();
      if (
        !sessionReady &&
        session &&
        firstTab &&
        screenBounds &&
        screenBounds.width > 0 &&
        screenBounds.height > 0
      ) {
        sessionReady = true;
        root.classList.add("sandpi-browser-dashboard-ready");
        post({ type: config.sessionReadyMessage });
      }
    };

    const clampViewportDimension = (value, minimum, maximum) =>
      Math.min(maximum, Math.max(minimum, Math.round(value)));

    const reportViewport = () => {
      if (!observedScreen) return;
      const bounds = observedScreen.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const viewport = {
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
      if (
        desiredViewport?.width === viewport.width &&
        desiredViewport?.height === viewport.height
      ) {
        return;
      }
      desiredViewport = viewport;
      post({ type: config.viewportMessage, ...viewport });
    };

    const viewportObserver = new ResizeObserver(() => {
      reportViewport();
      selectDefaultSession();
    });
    const updateDashboardState = () => {
      const screen = document.querySelector(".screen");
      if (screen !== observedScreen) {
        if (observedScreen) viewportObserver.unobserve(observedScreen);
        observedScreen = screen;
        if (observedScreen) {
          observedScreen.setAttribute("tabindex", "-1");
          viewportObserver.observe(observedScreen);
          reportViewport();
        }
      }
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

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      applyTheme(event.data);
    });
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
