"use client";

import {
  Bot,
  Hand,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { EnvironmentBrowserVnc } from "@/components/environment-browser-vnc";
import { apiFetch, apiUrl } from "@/lib/api-client";
import type { ApiEnvelope } from "@/lib/api-client";
import {
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  type BrowserDashboardResolvedTheme,
  type BrowserDashboardTheme,
  type BrowserDashboardThemeMessage,
  type BrowserDashboardViewport,
  type EnvironmentBrowserControl,
  type EnvironmentBrowserOwner,
  isBrowserDashboardReadyMessage,
  isBrowserDashboardSessionReadyMessage,
  isBrowserDashboardViewportMessage,
} from "@/lib/environment-browser";

const BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MS = 300;
const BROWSER_DASHBOARD_STARTUP_TIMEOUT_MS = 30_000;

interface EnvironmentBrowserProps {
  environmentId: string;
  copy: {
    title: string;
    starting: string;
    unavailable: string;
    retry: string;
    loading: string;
    takeControl: string;
    takeControlUnavailable: string;
    returnToAgent: string;
    humanControl: string;
    switchingControl: string;
    humanStarting: string;
  };
}

export function EnvironmentBrowser({
  environmentId,
  copy,
}: EnvironmentBrowserProps) {
  // The initial AppService starts independently from the page. A forced retry
  // waits for explicit recovery before remounting the read-only Dashboard.
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [dashboardReady, setDashboardReady] = useState(false);
  const [vncReady, setVncReady] = useState(false);
  const [control, setControl] = useState<EnvironmentBrowserControl>();
  const [controlBusy, setControlBusy] = useState(false);
  const [controlReload, setControlReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewportError, setViewportError] = useState("");
  const [retry, setRetry] = useState(0);
  const dashboardFrame = useRef<HTMLIFrameElement>(null);
  const pendingRecovery = useRef<{
    retry: number;
    promise: Promise<void>;
  } | undefined>(undefined);
  const browserBase =
    `/api/v1/environments/${encodeURIComponent(environmentId)}/browser`;

  const resetTransportState = useCallback(() => {
    setRecoveryReady(false);
    setDashboardReady(false);
    setVncReady(false);
    setViewportError("");
  }, []);

  const updateBrowserControl = useCallback(
    async (owner: EnvironmentBrowserOwner, force = false) => {
      setControlBusy(true);
      setError("");
      try {
        const response = await apiFetch<ApiEnvelope<EnvironmentBrowserControl>>(
          `${browserBase}/control`,
          {
            method: "PUT",
            body: JSON.stringify({ owner, ...(force ? { force: true } : {}) }),
          },
        );
        resetTransportState();
        setControl(response.data);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Browser control could not be transferred.",
        );
      } finally {
        setControlBusy(false);
      }
    },
    [browserBase, resetTransportState],
  );

  const handleVncReady = useCallback(() => {
    setVncReady(true);
    setError("");
  }, []);
  const handleVncError = useCallback((message: string) => {
    setVncReady(false);
    setError(message);
  }, []);

  useEffect(() => {
    let active = true;
    setControl(undefined);
    setControlBusy(true);
    setError("");
    resetTransportState();
    void apiFetch<ApiEnvelope<EnvironmentBrowserControl>>(
      `${browserBase}/control`,
    )
      .then((response) => {
        if (active) setControl(response.data);
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Browser control could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) setControlBusy(false);
      });
    return () => {
      active = false;
    };
  }, [browserBase, controlReload, resetTransportState]);

  const postDashboardMessage = useCallback(
    (message: BrowserDashboardThemeMessage) => {
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
    postDashboardMessage({
      type: BROWSER_DASHBOARD_THEME_MESSAGE,
      theme,
      resolvedTheme,
      tokens,
    });
  }, [postDashboardMessage]);

  useEffect(() => {
    const root = document.documentElement;
    let active = true;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let queuedViewport: BrowserDashboardViewport | undefined;
    let resizeInFlight = false;
    const flushViewport = async () => {
      if (!active || resizeInFlight || !queuedViewport) return;
      const viewport = queuedViewport;
      queuedViewport = undefined;
      resizeInFlight = true;
      try {
        await apiFetch<void>(`${browserBase}/viewport`, {
          method: "POST",
          body: JSON.stringify(viewport),
        });
        if (active) setViewportError("");
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
      const frame = dashboardFrame.current;
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
      if (event.origin !== new URL(frame.src, window.location.href).origin) {
        return;
      }
      if (isBrowserDashboardReadyMessage(event.data)) sendDashboardTheme();
      if (isBrowserDashboardViewportMessage(event.data)) {
        queueViewport({
          width: event.data.width,
          height: event.data.height,
        });
      }
      if (isBrowserDashboardSessionReadyMessage(event.data)) {
        setDashboardReady(true);
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
  }, [browserBase, sendDashboardTheme]);

  const transportReady =
    control?.owner === "human" ? vncReady : dashboardReady;

  useEffect(() => {
    if (!control || transportReady || error || controlBusy) return;
    const timeout = setTimeout(() => {
      setError(copy.unavailable);
    }, BROWSER_DASHBOARD_STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [control, controlBusy, copy.unavailable, error, retry, transportReady]);

  useEffect(() => {
    if (control?.owner !== "agent" || retry === 0 || recoveryReady) return;
    setBusy(true);
    setError("");
    setViewportError("");
    let request = pendingRecovery.current;
    if (!request || request.retry !== retry) {
      request = {
        retry,
        promise: apiFetch<void>(`${browserBase}/session`, {
          method: "POST",
          body: JSON.stringify({ force: true }),
        }),
      };
      pendingRecovery.current = request;
      const clearPendingRequest = () => {
        if (pendingRecovery.current === request) {
          pendingRecovery.current = undefined;
        }
      };
      void request.promise.then(clearPendingRequest, clearPendingRequest);
    }
    let active = true;
    void request.promise
      .then(() => {
        if (active) setRecoveryReady(true);
      })
      .catch((cause) => {
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
  }, [browserBase, control?.owner, recoveryReady, retry]);

  const visibleError = error || viewportError;
  const loading = busy || controlBusy;
  const takeoverUnavailable =
    control?.owner === "agent" && !control.takeoverAvailable;
  const controlActionLabel = control
    ? control.owner === "human"
      ? copy.returnToAgent
      : takeoverUnavailable
        ? copy.takeControlUnavailable
        : copy.takeControl
    : "";

  return (
    <div className="environment-browser">
      <div
        className={`environment-browser-toolbar ${loading ? "is-loading" : ""}`}
      >
        <span className="environment-browser-toolbar-title">
          {control?.owner === "human" ? copy.humanControl : copy.title}
        </span>
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
          <span>
            {loading
              ? controlBusy
                ? copy.switchingControl
                : copy.loading
              : ""}
          </span>
        </span>
        {control ? (
          <button
            type="button"
            className={`environment-browser-control ${takeoverUnavailable ? "is-unavailable" : ""}`}
            disabled={controlBusy || takeoverUnavailable}
            aria-label={controlActionLabel}
            title={controlActionLabel}
            onClick={() =>
              void updateBrowserControl(
                control.owner === "human" ? "agent" : "human",
              )
            }
          >
            {control.owner === "human" ? (
              <Bot size={14} aria-hidden="true" />
            ) : (
              <Hand size={14} aria-hidden="true" />
            )}
            <span>{controlActionLabel}</span>
          </button>
        ) : null}
      </div>
      <div className="environment-browser-stage">
        {control?.owner === "agent" && (retry === 0 || recoveryReady) ? (
          <iframe
            key={`${control.revision}:${retry}`}
            ref={dashboardFrame}
            className="environment-browser-frame"
            src={apiUrl(
              `/api/v1/environments/${encodeURIComponent(environmentId)}/browser/?embed=1`,
            )}
            title={copy.title}
            aria-hidden="true"
            tabIndex={-1}
            referrerPolicy="no-referrer"
            sandbox="allow-same-origin allow-scripts"
            onLoad={sendDashboardTheme}
          />
        ) : null}
        {control?.owner === "human" ? (
          <EnvironmentBrowserVnc
            environmentId={environmentId}
            revision={control.revision}
            onReady={handleVncReady}
            onError={handleVncError}
          />
        ) : null}
        {!transportReady || visibleError ? (
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
            <span>
              {visibleError ||
                (control?.owner === "human"
                  ? copy.humanStarting
                  : copy.starting)}
            </span>
            {visibleError ? (
              <button
                type="button"
                onClick={() => {
                  setError("");
                  resetTransportState();
                  if (!control) {
                    setControlReload((value) => value + 1);
                  } else if (control.owner === "human") {
                    void updateBrowserControl("human", true);
                  } else {
                    setRetry((value) => value + 1);
                  }
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
