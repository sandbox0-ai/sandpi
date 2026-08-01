"use client";

import { useEffect, useRef } from "react";

import { apiUrl } from "@/lib/api-client";

interface EnvironmentBrowserVncProps {
  environmentId: string;
  revision: number;
  onReady: () => void;
  onError: (message: string) => void;
}

export function EnvironmentBrowserVnc({
  environmentId,
  revision,
  onReady,
  onError,
}: EnvironmentBrowserVncProps) {
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let active = true;
    let connected = false;
    let rfb: import("@novnc/novnc/lib/rfb").default | undefined;

    void import("@novnc/novnc/lib/rfb")
      .then(({ default: Rfb }) => {
        if (!active) return;
        const endpoint = new URL(
          apiUrl(
            `/api/v1/environments/${encodeURIComponent(environmentId)}/browser/ws/vnc`,
          ),
          window.location.href,
        );
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        rfb = new Rfb(element, endpoint.toString(), { shared: true });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = true;
        rfb.showDotCursor = true;
        rfb.qualityLevel = 6;
        rfb.compressionLevel = 2;
        rfb.addEventListener("connect", () => {
          connected = true;
          onReady();
        });
        rfb.addEventListener("securityfailure", (event) => {
          if (!active) return;
          onError(
            event.detail.reason ||
              "The interactive browser rejected the secure viewer connection.",
          );
        });
        rfb.addEventListener("disconnect", (event) => {
          if (!active || event.detail.clean) return;
          onError(
            connected
              ? "The interactive browser connection closed unexpectedly."
              : "The interactive browser could not be reached.",
          );
        });
      })
      .catch(() => {
        if (active) {
          onError("The interactive browser viewer could not be loaded.");
        }
      });

    return () => {
      active = false;
      rfb?.disconnect();
      element.replaceChildren();
    };
  }, [environmentId, onError, onReady, revision]);

  return (
    <div
      ref={target}
      className="environment-browser-vnc"
      tabIndex={0}
      aria-label="Interactive Environment browser"
    />
  );
}
