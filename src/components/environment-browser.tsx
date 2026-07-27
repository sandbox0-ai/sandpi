"use client";

import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api-client";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const completedNavigationId = useRef<number | undefined>(undefined);
  const pendingRequest = useRef<{
    key: string;
    promise: Promise<void>;
  } | undefined>(undefined);
  const requestedNavigation =
    navigationRequest?.environmentId === environmentId
      ? navigationRequest
      : undefined;

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
          className="environment-browser-frame"
          src={apiUrl(
            `/api/v1/environments/${encodeURIComponent(environmentId)}/browser/`,
          )}
          title={copy.title}
          referrerPolicy="no-referrer"
          sandbox="allow-forms allow-same-origin allow-scripts"
        />
      ) : null}
      {!ready || error ? (
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
      {busy && ready && !error ? (
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
