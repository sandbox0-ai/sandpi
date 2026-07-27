"use client";

import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api-client";
import {
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
  type BrowserDashboardResolvedTheme,
  type BrowserDashboardTheme,
  type BrowserDashboardThemeMessage,
  type BrowserDashboardViewport,
  type BrowserDashboardViewportAppliedMessage,
  isBrowserDashboardReadyMessage,
  isBrowserDashboardSessionReadyMessage,
  isBrowserDashboardViewportMessage,
} from "@/lib/environment-browser";

const BROWSER_VIEWPORT_RESIZE_DEBOUNCE_MS = 150;

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
    retry: string;
  };
}

export function EnvironmentBrowser({
  environmentId,
  navigationRequest,
  onNavigationHandled,
  copy,
}: EnvironmentBrowserProps) {
  const [ready, setReady] = useState(false);
  const [dashboardReady, setDashboardReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewportError, setViewportError] = useState("");
  const [retry, setRetry] = useState(0);
  const dashboardFrame = useRef<HTMLIFrameElement>(null);
  const completedNavigationId = useRef<number | undefined>(undefined);
  const pendingRequest = useRef<{
    key: string;
    promise: Promise<void>;
  } | undefined>(undefined);
  const requestedNavigation =
    navigationRequest?.environmentId === environmentId
      ? navigationRequest
      : undefined;

  const sendDashboardTheme = useCallback(() => {
    const frame = dashboardFrame.current;
    if (!frame?.contentWindow) return;

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
    const targetOrigin = new URL(frame.src, window.location.href).origin;
    frame.contentWindow.postMessage(message, targetOrigin);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    let active = true;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let queuedViewport: BrowserDashboardViewport | undefined;
    let resizeInFlight = false;
    const sendViewportApplied = (viewport: BrowserDashboardViewport) => {
      const frame = dashboardFrame.current;
      if (!frame?.contentWindow) return;
      const message: BrowserDashboardViewportAppliedMessage = {
        type: BROWSER_DASHBOARD_VIEWPORT_APPLIED_MESSAGE,
        ...viewport,
      };
      const targetOrigin = new URL(frame.src, window.location.href).origin;
      frame.contentWindow.postMessage(message, targetOrigin);
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
      }
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
  }, [environmentId, sendDashboardTheme]);

  useEffect(() => {
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
    let request = pendingRequest.current;
    if (!request || request.key !== requestKey) {
      request = {
        key: requestKey,
        promise: requestedNavigation
          ? apiFetch<void>(`${base}/open`, {
              method: "POST",
              body: JSON.stringify({ url: requestedNavigation.url }),
            })
          : apiFetch<void>(`${base}/session`, { method: "POST" }),
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
    onNavigationHandled,
    ready,
    requestedNavigation,
    retry,
  ]);

  const visibleError = error || viewportError;

  return (
    <div className="environment-browser">
      {ready ? (
        <iframe
          ref={dashboardFrame}
          className="environment-browser-frame"
          src={apiUrl(
            `/api/v1/environments/${encodeURIComponent(environmentId)}/browser/?embed=1`,
          )}
          title={copy.title}
          referrerPolicy="no-referrer"
          sandbox="allow-forms allow-same-origin allow-scripts"
          onLoad={sendDashboardTheme}
        />
      ) : null}
      {!ready || !dashboardReady || visibleError ? (
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
      {busy && ready && dashboardReady && !visibleError ? (
        <span className="environment-browser-busy" role="status">
          <LoaderCircle
            className="environment-browser-spinner"
            size={14}
            aria-hidden="true"
          />
          {copy.starting}
        </span>
      ) : null}
    </div>
  );
}
