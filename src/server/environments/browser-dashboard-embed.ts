import {
  BROWSER_DASHBOARD_READY_MESSAGE,
  BROWSER_DASHBOARD_SESSION_NAME,
  BROWSER_DASHBOARD_SESSION_READY_MESSAGE,
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
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
});

export const BROWSER_DASHBOARD_EMBED_SCRIPT = `
<script ${BROWSER_DASHBOARD_EMBED_MARKER}>
  (() => {
    const config = ${browserDashboardEmbedConfig};
    const root = document.documentElement;
    root.classList.add("sandpi-browser-dashboard");
    let selectedDefaultTab;
    let sessionReady = false;

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
        liveFrame?.getAttribute("src")?.startsWith("data:image/")
      ) {
        sessionReady = true;
        sessionObserver.disconnect();
        window.parent.postMessage(
          { type: config.sessionReadyMessage },
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

    const sessionObserver = new MutationObserver(selectDefaultSession);
    sessionObserver.observe(root, {
      attributes: true,
      attributeFilter: ["aria-selected", "src"],
      childList: true,
      subtree: true,
    });
    queueMicrotask(selectDefaultSession);

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
      if (event.source === window.parent)
        applyTheme(event.data);
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
