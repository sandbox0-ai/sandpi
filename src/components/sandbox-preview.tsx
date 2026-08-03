"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";

interface EnvironmentPreviewGrant {
  id: string;
  url: string;
  targetUrl: string;
  expiresAt: number;
  runtimeGeneration: number;
}

interface SandboxPreviewCopy {
  loading: string;
  reload: string;
  openNewTab: string;
  empty: string;
  iframeTitle: string;
}

export function SandboxPreview({
  environmentId,
  sourceUrl,
  copy,
}: {
  environmentId: string;
  sourceUrl?: string;
  copy: SandboxPreviewCopy;
}) {
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const [grant, setGrant] = useState<EnvironmentPreviewGrant>();
  const [error, setError] = useState("");
  const [frameLoading, setFrameLoading] = useState(false);

  useEffect(() => {
    if (!sourceUrl) {
      setGrant(undefined);
      setError("");
      return;
    }
    let disposed = false;
    let previewId = "";
    let renewalTimer: number | undefined;
    const controller = new AbortController();
    setGrant(undefined);
    setError("");
    setFrameLoading(true);

    const endpoint = `/api/v1/environments/${encodeURIComponent(environmentId)}/previews`;
    const create = apiFetch<ApiEnvelope<EnvironmentPreviewGrant>>(endpoint, {
      method: "POST",
      body: JSON.stringify({ url: sourceUrl }),
      signal: controller.signal,
    });
    void create
      .then((response) => {
        previewId = response.data.id;
        if (disposed) {
          void apiFetch(`${endpoint}/${encodeURIComponent(previewId)}`, {
            method: "DELETE",
            keepalive: true,
          }).catch(() => undefined);
          return;
        }
        setGrant(response.data);
        renewalTimer = window.setInterval(() => {
          void apiFetch<ApiEnvelope<EnvironmentPreviewGrant>>(
            `${endpoint}/${encodeURIComponent(response.data.id)}`,
            { method: "PUT", body: JSON.stringify({ ttlSeconds: 900 }) },
          )
            .then((renewed) => {
              if (!disposed) {
                setGrant((current) =>
                  current
                    ? { ...renewed.data, url: current.url }
                    : renewed.data,
                );
              }
            })
            .catch(() => {
              if (!disposed) setReloadEpoch((current) => current + 1);
            });
        }, 8 * 60 * 1_000);
      })
      .catch((reason) => {
        if (!disposed && !controller.signal.aborted) {
          setFrameLoading(false);
          setError(
            reason instanceof Error
              ? reason.message
              : "The Sandbox preview could not be opened.",
          );
        }
      });

    return () => {
      disposed = true;
      controller.abort();
      if (renewalTimer !== undefined) window.clearInterval(renewalTimer);
      if (previewId) {
        void apiFetch(`${endpoint}/${encodeURIComponent(previewId)}`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [environmentId, reloadEpoch, sourceUrl]);

  const openNewTab = useCallback(() => {
    if (!sourceUrl) return;
    const popup = window.open("about:blank", "_blank");
    if (!popup) return;
    try {
      popup.opener = null;
    } catch {
      popup.close();
      setError("The browser could not isolate the preview tab.");
      return;
    }
    if (popup.opener !== null) {
      popup.close();
      setError("The browser could not isolate the preview tab.");
      return;
    }
    const endpoint = `/api/v1/environments/${encodeURIComponent(environmentId)}/previews`;
    void apiFetch<ApiEnvelope<EnvironmentPreviewGrant>>(endpoint, {
      method: "POST",
      body: JSON.stringify({ url: sourceUrl }),
    })
      .then((response) => {
        if (!popup.closed) {
          popup.location.replace(response.data.url);
          return;
        }
        void apiFetch(
          `${endpoint}/${encodeURIComponent(response.data.id)}`,
          { method: "DELETE", keepalive: true },
        ).catch(() => undefined);
      })
      .catch((reason) => {
        popup.close();
        setError(
          reason instanceof Error
            ? reason.message
            : "The Sandbox preview could not be opened.",
        );
      });
  }, [environmentId, sourceUrl]);

  if (!sourceUrl) {
    return <div className="sandbox-preview-empty">{copy.empty}</div>;
  }

  return (
    <div className="sandbox-preview">
      <div className="sandbox-preview-toolbar">
        <code title={sourceUrl}>{sourceUrl}</code>
        <button
          type="button"
          className="icon-button"
          aria-label={copy.reload}
          title={copy.reload}
          onClick={() => setReloadEpoch((current) => current + 1)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={copy.openNewTab}
          title={copy.openNewTab}
          onClick={openNewTab}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {error ? (
        <div className="sandbox-preview-status" role="alert">
          {error}
        </div>
      ) : null}
      {frameLoading ? (
        <div className="sandbox-preview-status" role="status">
          {copy.loading}
        </div>
      ) : null}
      {grant ? (
        <iframe
          key={grant.id}
          src={grant.url}
          title={copy.iframeTitle}
          referrerPolicy="no-referrer"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          allow="clipboard-read; clipboard-write"
          onLoad={() => setFrameLoading(false)}
        />
      ) : null}
    </div>
  );
}
