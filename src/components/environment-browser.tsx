"use client";

import {
  LoaderCircle,
  Plus,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api-client";
import {
  BROWSER_DASHBOARD_COMMAND_MESSAGE,
  BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE,
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
  type BrowserDashboardCommandMessage,
  type BrowserDashboardResolvedTheme,
  type BrowserDashboardTab,
  type BrowserDashboardTheme,
  type BrowserDashboardThemeMessage,
  type BrowserDashboardViewport,
  type BrowserDashboardViewportAppliedMessage,
  type BrowserDashboardViewportModeMessage,
  isBrowserDashboardLoadingMessage,
  isBrowserDashboardReadyMessage,
  isBrowserDashboardSessionReadyMessage,
  isBrowserDashboardTabsMessage,
  isBrowserDashboardViewportMessage,
  isBrowserDashboardViewportMode,
} from "@/lib/environment-browser";
import { updateLocalUiPreferences } from "@/lib/local-ui-preferences";
import { useLocalUiPreferences } from "@/lib/use-local-ui-preferences";

const BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MS = 300;
const BROWSER_DASHBOARD_STARTUP_TIMEOUT_MS = 30_000;

export interface EnvironmentBrowserNavigationRequest {
  id: number;
  environmentId: string;
  url: string;
}

interface EnvironmentBrowserProps {
  environmentId: string;
  navigationRequest?: EnvironmentBrowserNavigationRequest;
  onNavigationHandled?: (
    request: EnvironmentBrowserNavigationRequest,
  ) => void;
  copy: {
    title: string;
    starting: string;
    unavailable: string;
    retry: string;
    tabs: string;
    newTab: string;
    closeTab: (title: string) => string;
    untitledTab: string;
    loading: string;
    viewport: string;
    viewportDesktop: string;
    viewportResponsive: string;
    viewportMobile: string;
  };
}

function browserTabTitle(tab: BrowserDashboardTab, fallback: string) {
  if (tab.title && tab.title !== "about:blank") return tab.title;
  try {
    const url = new URL(tab.url);
    if (url.hostname) return url.hostname;
  } catch {
    // Browser-internal URLs intentionally fall back to a neutral tab name.
  }
  return fallback;
}

export function EnvironmentBrowser({
  environmentId,
  navigationRequest,
  onNavigationHandled,
  copy,
}: EnvironmentBrowserProps) {
  // Browser recovery and Dashboard startup run independently. The iframe is
  // mounted immediately below while this flag prevents duplicate recovery.
  const [ready, setReady] = useState(false);
  const [dashboardReady, setDashboardReady] = useState(false);
  const [dashboardIntegrated, setDashboardIntegrated] = useState(false);
  const [tabs, setTabs] = useState<BrowserDashboardTab[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [viewport, setViewport] = useState<BrowserDashboardViewport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewportError, setViewportError] = useState("");
  const [retry, setRetry] = useState(0);
  const dashboardFrame = useRef<HTMLIFrameElement>(null);
  const tabsRef = useRef<BrowserDashboardTab[]>([]);
  const pendingExternalTabBaseline = useRef<number | undefined>(undefined);
  const completedNavigationId = useRef<number | undefined>(undefined);
  const pendingRequest = useRef<{
    key: string;
    promise: Promise<void>;
  } | undefined>(undefined);
  const requestedNavigation =
    navigationRequest?.environmentId === environmentId
      ? navigationRequest
      : undefined;
  const viewportMode =
    useLocalUiPreferences().workspace.browserViewportMode;

  const postDashboardMessage = useCallback(
    (
      message:
        | BrowserDashboardThemeMessage
        | BrowserDashboardViewportAppliedMessage
        | BrowserDashboardViewportModeMessage
        | BrowserDashboardCommandMessage,
    ) => {
      const frame = dashboardFrame.current;
      if (!frame?.contentWindow) return;
      const targetOrigin = new URL(frame.src, window.location.href).origin;
      frame.contentWindow.postMessage(message, targetOrigin);
    },
    [],
  );

  const sendDashboardTheme = useCallback(() => {
    const root = document.documentElement;
    const theme: BrowserDashboardTheme =
      root.dataset.theme === "light" || root.dataset.theme === "dark"
        ? root.dataset.theme
        : "system";
    const resolvedTheme: BrowserDashboardResolvedTheme =
      root.dataset.resolvedTheme === "dark" ? "dark" : "light";
    const styles = getComputedStyle(root);
    const tokens: Record<string, string> = {};
    for (const name of Object.keys(BROWSER_DASHBOARD_THEME_TOKEN_MAP)) {
      const value = styles.getPropertyValue(name).trim();
      if (value) tokens[name] = value;
    }
    const message: BrowserDashboardThemeMessage = {
      type: BROWSER_DASHBOARD_THEME_MESSAGE,
      theme,
      resolvedTheme,
      tokens,
    };
    postDashboardMessage(message);
  }, [postDashboardMessage]);

  const sendDashboardViewportMode = useCallback(() => {
    postDashboardMessage({
      type: BROWSER_DASHBOARD_VIEWPORT_MODE_MESSAGE,
      mode: viewportMode,
    });
  }, [postDashboardMessage, viewportMode]);

  const sendDashboardCommand = useCallback(
    (action: BrowserDashboardCommandMessage["action"], index?: number) => {
      postDashboardMessage({
        type: BROWSER_DASHBOARD_COMMAND_MESSAGE,
        action,
        ...(index === undefined ? {} : { index }),
      });
    },
    [postDashboardMessage],
  );

  useEffect(() => {
    const root = document.documentElement;
    let active = true;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let queuedViewport: BrowserDashboardViewport | undefined;
    let resizeInFlight = false;
    const sendViewportApplied = (viewport: BrowserDashboardViewport) => {
      const message: BrowserDashboardViewportAppliedMessage = {
        type: BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
        ...viewport,
      };
      postDashboardMessage(message);
    };
    const flushViewport = async () => {
      if (!active || resizeInFlight || !queuedViewport) return;
      const viewport = queuedViewport;
      queuedViewport = undefined;
      resizeInFlight = true;
      try {
        await apiFetch<void>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/browser/viewport`,
          {
            method: "POST",
            body: JSON.stringify(viewport),
          },
        );
        if (!active) return;
        setViewportError("");
        sendViewportApplied(viewport);
      } catch (cause) {
        if (active) {
          setViewportError(
            cause instanceof Error
              ? cause.message
              : "The Environment browser viewport could not be resized.",
          );
        }
      } finally {
        resizeInFlight = false;
        if (active && queuedViewport) {
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            void flushViewport();
          }, BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MS);
        }
      }
    };
    const queueViewport = (viewport: BrowserDashboardViewport) => {
      queuedViewport = viewport;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        void flushViewport();
      }, BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MS);
    };
    const handleDashboardMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== dashboardFrame.current?.contentWindow) return;
      if (isBrowserDashboardReadyMessage(event.data)) {
        sendDashboardTheme();
        sendDashboardViewportMode();
      }
      if (isBrowserDashboardViewportMessage(event.data)) {
        setViewport({
          width: event.data.width,
          height: event.data.height,
        });
        queueViewport({
          width: event.data.width,
          height: event.data.height,
        });
      }
      if (isBrowserDashboardSessionReadyMessage(event.data)) {
        setDashboardReady(true);
      }
      if (isBrowserDashboardTabsMessage(event.data)) {
        tabsRef.current = event.data.tabs;
        setTabs(event.data.tabs);
        setDashboardIntegrated(event.data.integrated);
        const baseline = pendingExternalTabBaseline.current;
        if (baseline !== undefined && event.data.tabs.length > baseline) {
          pendingExternalTabBaseline.current = undefined;
          sendDashboardCommand("select", event.data.tabs.length - 1);
        }
      }
      if (isBrowserDashboardLoadingMessage(event.data)) {
        setRemoteLoading(event.data.loading);
      }
    };
    const observer = new MutationObserver(sendDashboardTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-resolved-theme"],
    });
    window.addEventListener("message", handleDashboardMessage);
    return () => {
      active = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      window.removeEventListener("message", handleDashboardMessage);
    };
  }, [
    environmentId,
    postDashboardMessage,
    sendDashboardCommand,
    sendDashboardTheme,
    sendDashboardViewportMode,
  ]);

  useEffect(() => {
    if (dashboardReady) sendDashboardViewportMode();
  }, [dashboardReady, sendDashboardViewportMode]);

  useEffect(() => {
    if (dashboardReady || error) return;
    const timeout = setTimeout(() => {
      setError(copy.unavailable);
    }, BROWSER_DASHBOARD_STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [copy.unavailable, dashboardReady, error, retry]);

  useEffect(() => {
    // The Dashboard AppService starts the default persistent browser in its
    // own Sandbox-native lifetime. Avoid a separate control API command on the
    // normal mount; the session endpoint is reserved for explicit recovery.
    if (!requestedNavigation && retry === 0) return;
    if (requestedNavigation && !dashboardReady) return;
    if (!requestedNavigation && ready) return;
    if (
      requestedNavigation &&
      requestedNavigation.id === completedNavigationId.current
    ) {
      return;
    }
    const base = `/api/v1/environments/${encodeURIComponent(environmentId)}/browser`;
    const requestKey = requestedNavigation
      ? `open:${requestedNavigation.id}`
      : `session:${environmentId}:${retry}`;
    setBusy(true);
    setError("");
    setViewportError("");
    if (requestedNavigation) {
      pendingExternalTabBaseline.current = tabsRef.current.length;
    }
    let request = pendingRequest.current;
    if (!request || request.key !== requestKey) {
      request = {
        key: requestKey,
        promise: requestedNavigation
          ? apiFetch<void>(`${base}/open`, {
              method: "POST",
              body: JSON.stringify({ url: requestedNavigation.url }),
            })
          : apiFetch<void>(`${base}/session`, {
              method: "POST",
              body: JSON.stringify({ force: retry > 0 }),
            }),
      };
      pendingRequest.current = request;
      const clearPendingRequest = () => {
        if (pendingRequest.current === request) {
          pendingRequest.current = undefined;
        }
      };
      void request.promise.then(clearPendingRequest, clearPendingRequest);
    }
    let active = true;
    void request
      .promise
      .then(() => {
        if (!active) return;
        setReady(true);
        if (requestedNavigation) {
          completedNavigationId.current = requestedNavigation.id;
          onNavigationHandled?.(requestedNavigation);
        }
      })
      .catch((cause) => {
        pendingExternalTabBaseline.current = undefined;
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The Environment browser is unavailable.",
          );
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [
    environmentId,
    dashboardReady,
    onNavigationHandled,
    ready,
    requestedNavigation,
    retry,
  ]);

  const visibleError = error || viewportError;
  const loading = busy || remoteLoading;

  return (
    <div className="environment-browser">
      <div
        className={`environment-browser-toolbar ${loading ? "is-loading" : ""}`}
      >
        {dashboardIntegrated ? (
          <div
            className="environment-browser-tabs"
            role="tablist"
            aria-label={copy.tabs}
          >
            {tabs.map((tab) => {
              const title = browserTabTitle(tab, copy.untitledTab);
              return (
                <div
                  className={`environment-browser-tab ${tab.selected ? "is-selected" : ""}`}
                  key={`${tab.index}:${tab.url}`}
                >
                  <button
                    type="button"
                    className="environment-browser-tab-select"
                    role="tab"
                    aria-selected={tab.selected}
                    title={tab.url ? `${title}\n${tab.url}` : title}
                    onClick={() => sendDashboardCommand("select", tab.index)}
                  >
                    <span>{title}</span>
                  </button>
                  {tabs.length > 1 ? (
                    <button
                      type="button"
                      className="environment-browser-tab-close"
                      aria-label={copy.closeTab(title)}
                      onClick={() => sendDashboardCommand("close", tab.index)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              );
            })}
            <button
              type="button"
              className="environment-browser-new-tab"
              aria-label={copy.newTab}
              title={copy.newTab}
              onClick={() => sendDashboardCommand("new")}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <span className="environment-browser-toolbar-title">
            {copy.title}
          </span>
        )}
        <span
          className={`environment-browser-loading ${loading ? "is-visible" : ""}`}
          role="status"
          aria-live="polite"
        >
          {loading ? (
            <LoaderCircle
              className="environment-browser-spinner"
              size={13}
              aria-hidden="true"
            />
          ) : null}
          <span>{loading ? copy.loading : ""}</span>
        </span>
        {viewport ? (
          <span className="environment-browser-viewport-size">
            {viewport.width} × {viewport.height}
          </span>
        ) : null}
        <label className="environment-browser-viewport-mode">
          <span className="sr-only">{copy.viewport}</span>
          <select
            aria-label={copy.viewport}
            value={viewportMode}
            onChange={(event) => {
              const mode = event.target.value;
              if (!isBrowserDashboardViewportMode(mode)) return;
              updateLocalUiPreferences((current) => ({
                ...current,
                workspace: {
                  ...current.workspace,
                  browserViewportMode: mode,
                },
              }));
            }}
          >
            <option value="desktop">{copy.viewportDesktop}</option>
            <option value="responsive">{copy.viewportResponsive}</option>
            <option value="mobile">{copy.viewportMobile}</option>
          </select>
        </label>
      </div>
      <div className="environment-browser-stage">
        {retry === 0 || ready ? (
          <iframe
            key={retry}
            ref={dashboardFrame}
            className="environment-browser-frame"
            src={apiUrl(
              `/api/v1/environments/${encodeURIComponent(environmentId)}/browser/?embed=1`,
            )}
            title={copy.title}
            referrerPolicy="no-referrer"
            sandbox="allow-forms allow-same-origin allow-scripts"
            onLoad={() => {
              sendDashboardTheme();
              sendDashboardViewportMode();
            }}
          />
        ) : null}
        {!dashboardReady || visibleError ? (
          <div
            className={`environment-browser-state ${visibleError ? "is-error" : ""}`}
            role={visibleError ? "alert" : "status"}
          >
            {visibleError ? (
              <TriangleAlert size={22} aria-hidden="true" />
            ) : (
              <LoaderCircle
                className="environment-browser-spinner"
                size={22}
                aria-hidden="true"
              />
            )}
            <span>{visibleError || copy.starting}</span>
            {visibleError ? (
              <button
                type="button"
                onClick={() => {
                  setReady(false);
                  setDashboardReady(false);
                  setDashboardIntegrated(false);
                  setTabs([]);
                  tabsRef.current = [];
                  setRemoteLoading(false);
                  setError("");
                  setViewportError("");
                  setRetry((value) => value + 1);
                }}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {copy.retry}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
