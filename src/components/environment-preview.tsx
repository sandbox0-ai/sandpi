"use client";

import { ArrowRight, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { sandboxPreviewUrl } from "@/lib/environment-preview";

export interface EnvironmentPreviewNavigationRequest {
  id: number;
  environmentId: string;
  url: string;
}

interface PreviewSession {
  url: string;
  target: string;
}

interface EnvironmentPreviewProps {
  environmentId: string;
  active: boolean;
  navigationRequest?: EnvironmentPreviewNavigationRequest;
  onNavigationHandled?: (
    request: EnvironmentPreviewNavigationRequest,
  ) => void;
  copy: {
    title: string;
    address: string;
    open: string;
    reload: string;
    openNewTab: string;
    empty: string;
    loading: string;
    invalid: string;
    unavailable: string;
  };
}

function cleanPreviewUrl(value: string) {
  const url = new URL(value);
  url.searchParams.delete("__sandpi_ticket");
  return url.toString();
}

export function EnvironmentPreview({
  environmentId,
  active,
  navigationRequest,
  onNavigationHandled,
  copy,
}: EnvironmentPreviewProps) {
  const [address, setAddress] = useState("");
  const [session, setSession] = useState<PreviewSession>();
  const [frameUrl, setFrameUrl] = useState("");
  const [frameRevision, setFrameRevision] = useState(0);
  const [ticketExchanged, setTicketExchanged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const handledNavigationId = useRef<number | undefined>(undefined);

  const open = useCallback(
    async (value: string) => {
      const normalized = sandboxPreviewUrl(value);
      if (!normalized) {
        setError(copy.invalid);
        return false;
      }
      const sequence = ++requestSequence.current;
      setAddress(normalized);
      setLoading(true);
      setError("");
      try {
        const response = await apiFetch<ApiEnvelope<PreviewSession>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/preview/session`,
          { method: "POST", body: JSON.stringify({ url: normalized }) },
        );
        if (sequence !== requestSequence.current) return false;
        setSession(response.data);
        setAddress(response.data.target);
        setTicketExchanged(false);
        setFrameUrl(response.data.url);
        setFrameRevision((revision) => revision + 1);
        return true;
      } catch (cause) {
        if (sequence !== requestSequence.current) return false;
        setLoading(false);
        setError(cause instanceof Error ? cause.message : copy.unavailable);
        return false;
      }
    },
    [copy.invalid, copy.unavailable, environmentId],
  );

  useEffect(() => {
    const requested =
      navigationRequest?.environmentId === environmentId
        ? navigationRequest
        : undefined;
    if (!requested || handledNavigationId.current === requested.id) return;
    handledNavigationId.current = requested.id;
    void open(requested.url).finally(() => onNavigationHandled?.(requested));
  }, [environmentId, navigationRequest, onNavigationHandled, open]);

  useEffect(() => {
    if (!active && ticketExchanged && frameUrl.includes("__sandpi_ticket=")) {
      setFrameUrl(cleanPreviewUrl(frameUrl));
    }
  }, [active, frameUrl, ticketExchanged]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void open(address);
  }

  return (
    <div className="environment-preview">
      <form className="environment-preview-toolbar" onSubmit={submit}>
        <label className="sr-only" htmlFor={`preview-address-${environmentId}`}>
          {copy.address}
        </label>
        <input
          id={`preview-address-${environmentId}`}
          value={address}
          placeholder="http://localhost:3000"
          spellCheck={false}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button type="submit" aria-label={copy.open} title={copy.open}>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={copy.reload}
          title={copy.reload}
          disabled={!session}
          onClick={() => {
            if (!session) return;
            setLoading(true);
            if (frameUrl.includes("__sandpi_ticket=")) {
              setFrameUrl(cleanPreviewUrl(frameUrl));
            }
            setFrameRevision((revision) => revision + 1);
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={copy.openNewTab}
          title={copy.openNewTab}
          disabled={!frameUrl}
          onClick={() => {
            if (frameUrl) {
              window.open(
                cleanPreviewUrl(frameUrl),
                "_blank",
                "noopener,noreferrer",
              );
            }
          }}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </button>
      </form>

      <div className="environment-preview-stage">
        {active && frameUrl ? (
          <iframe
            key={frameRevision}
            className="environment-preview-frame"
            src={frameUrl}
            title={copy.title}
            referrerPolicy="no-referrer"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            onLoad={() => {
              setLoading(false);
              setError("");
              if (frameUrl.includes("__sandpi_ticket=")) {
                setTicketExchanged(true);
              }
            }}
          />
        ) : null}
        {!frameUrl ? (
          <div className="environment-preview-state">
            <span>{copy.empty}</span>
          </div>
        ) : null}
        {loading ? (
          <div className="environment-preview-state is-loading" role="status">
            <LoaderCircle className="environment-preview-spinner" size={18} />
            <span>{copy.loading}</span>
          </div>
        ) : null}
        {error ? (
          <div className="environment-preview-state is-error" role="alert">
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
