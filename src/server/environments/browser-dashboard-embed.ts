import {
  BROWSER_DASHBOARD_READY_MESSAGE,
  BROWSER_DASHBOARD_SESSION_NAME,
  BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
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
  }

  html.sandpi-browser-dashboard #root > .split-view.horizontal.sidebar-first > .split-view-sidebar,
  html.sandpi-browser-dashboard #root > .split-view.horizontal.sidebar-first > .split-view-resizer,
  html.sandpi-browser-dashboard .settings-button-container {
    display: none !important;
  }

  html.sandpi-browser-dashboard #root > .split-view.horizontal.sidebar-first > .split-view-main,
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
  readyMessage: BROWSER_DASHBOARD_READY_MESSAGE,
  sessionName: BROWSER_DASHBOARD_SESSION_NAME,
  sessionReadyMessage: BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  themeMessage: BROWSER_DASHBOARD_THEME_MESSAGE,
  tokenMap: BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  viewportAppliedMessage: BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
  viewportLimits: BROWSER_DASHBOARD_VIEWPORT_LIMITS,
  viewportMessage: BROWSER_DASHBOARD_VIEWPORT_MESSAGE,
});

export const BROWSER_DASHBOARD_EMBED_SCRIPT = `
<script ${BROWSER_DASHBOARD_EMBED_MARKER}>
  (() => {
    const config = ${browserDashboardEmbedConfig};
    const root = document.documentElement;
    root.classList.add("sandpi-browser-dashboard");
    let selectedDefaultTab;
    let observedScreen;
    let desiredViewport;
    let appliedViewport;
    let sessionReady = false;

    const liveFrameMatchesViewport = (liveFrame, viewport) => {
      const naturalWidth = liveFrame?.naturalWidth ?? 0;
      const naturalHeight = liveFrame?.naturalHeight ?? 0;
      if (naturalWidth <= 0 || naturalHeight <= 0) return false;
      const crossProductDifference = Math.abs(
        naturalWidth * viewport.height -
          naturalHeight * viewport.width,
      );
      return (
        crossProductDifference <=
        2 *
          Math.max(
            naturalWidth,
            naturalHeight,
            viewport.width,
            viewport.height,
          )
      );
    };

    const selectDefaultSession = () => {
      if (sessionReady) return;
      const sessions = document.querySelectorAll(".sidebar-session");
      const session = Array.from(sessions).find(
        (candidate) =>
          candidate.querySelector(".session-chip-name")?.textContent?.trim() ===
          config.sessionName,
      );
      if (!session) return;

      const selectedTab = session.querySelector(
        '[role="option"][aria-selected="true"]',
      );
      const liveFrame = document.querySelector("#display");
      if (
        selectedTab &&
        desiredViewport &&
        appliedViewport &&
        desiredViewport.width === appliedViewport.width &&
        desiredViewport.height === appliedViewport.height &&
        liveFrame?.getAttribute("src")?.startsWith("data:image/") &&
        liveFrame.complete &&
        liveFrameMatchesViewport(liveFrame, appliedViewport)
      ) {
        sessionReady = true;
        sessionObserver.disconnect();
        sessionObserver.observe(root, {
          childList: true,
          subtree: true,
        });
        document.removeEventListener("load", selectDefaultSession, true);
        window.parent.postMessage(
          {
            type: config.sessionReadyMessage,
            width: appliedViewport.width,
            height: appliedViewport.height,
          },
          "*",
        );
        return;
      }

      const firstTab = session.querySelector('[role="option"]');
      if (!selectedTab && firstTab && firstTab !== selectedDefaultTab) {
        selectedDefaultTab = firstTab;
        firstTab.click();
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
      window.parent.postMessage(
        { type: config.viewportMessage, ...viewport },
        "*",
      );
      selectDefaultSession();
    };

    const viewportObserver = new ResizeObserver(reportViewport);
    const observeScreen = () => {
      const screen = document.querySelector(".screen");
      if (screen === observedScreen) return;
      if (observedScreen) viewportObserver.unobserve(observedScreen);
      observedScreen = screen;
      if (observedScreen) {
        viewportObserver.observe(observedScreen);
        reportViewport();
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
    document.addEventListener("load", selectDefaultSession, true);
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
      appliedViewport = {
        width: message.width,
        height: message.height,
      };
      selectDefaultSession();
    };

    window.addEventListener("message", (event) => {
      if (event.source === window.parent) {
        applyTheme(event.data);
        applyViewport(event.data);
      }
    });
    window.parent.postMessage({ type: config.readyMessage }, "*");
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
