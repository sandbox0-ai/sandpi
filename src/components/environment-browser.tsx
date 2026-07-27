"use client";

import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api-client";
import {
  BROWSER_DASHBOARD_THEME_MESSAGE,
  BROWSER_DASHBOARD_THEME_TOKEN_MAP,
  type BrowserDashboardResolvedTheme,
  type BrowserDashboardTheme,
  type BrowserDashboardThemeMessage,
  isBrowserDashboardReadyMessage,
  isBrowserDashboardSessionReadyMessage,
} from "@/lib/environment-browser";

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
    const handleDashboardMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source === dashboardFrame.current?.contentWindow &&
        isBrowserDashboardReadyMessage(event.data)
      ) {
        sendDashboardTheme();
      }
      if (
        event.source === dashboardFrame.current?.contentWindow &&
        isBrowserDashboardSessionReadyMessage(event.data)
      ) {
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
      observer.disconnect();
      window.removeEventListener("message", handleDashboardMessage);
    };
  }, [sendDashboardTheme]);

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
      {!ready || !dashboardReady || error ? (
        <div
          className={`environment-browser-state ${error ? "is-error" : ""}`}
          role={error ? "alert" : "status"}
        >
          {error ? (
            <TriangleAlert size={22} aria-hidden="true" />
          ) : (
            <LoaderCircle
              className="environment-browser-spinner"
              size={22}
              aria-hidden="true"
            />
          )}
          <span>{error || copy.starting}</span>
          {error ? (
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              <RefreshCw size={13} aria-hidden="true" />
              {copy.retry}
            </button>
          ) : null}
        </div>
      ) : null}
      {busy && ready && dashboardReady && !error ? (
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
