"use client";

import { useEffect, useState } from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import {
  ENVIRONMENT_RESOURCE_METRIC_POLL_INTERVAL_MS,
  ENVIRONMENT_RESOURCE_METRIC_RETRY_INTERVAL_MS,
} from "@/lib/environment-metrics";
import type { EnvironmentResourceMetrics } from "@/lib/types";

interface ResourceMetricSnapshot {
  environmentId: string;
  metrics: EnvironmentResourceMetrics | null;
}

/**
 * Poll the compact Environment resource projection only while this page is visible.
 * Missing or unavailable runtime metrics are intentionally silent in the composer.
 */
export function useEnvironmentResourceMetrics(environmentId: string) {
  const [snapshot, setSnapshot] = useState<ResourceMetricSnapshot | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const schedule = (delay: number) => {
      if (disposed || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => void load(), delay);
    };

    const load = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") {
        return;
      }
      inFlight = true;
      controller = new AbortController();
      let nextDelay = ENVIRONMENT_RESOURCE_METRIC_POLL_INTERVAL_MS;
      try {
        const response = await apiFetch<
          ApiEnvelope<EnvironmentResourceMetrics>
        >(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/metrics/current`,
          { signal: controller.signal },
        );
        if (!disposed) {
          setSnapshot({ environmentId, metrics: response.data });
        }
      } catch {
        if (!disposed && !controller.signal.aborted) {
          setSnapshot({ environmentId, metrics: null });
          nextDelay = ENVIRONMENT_RESOURCE_METRIC_RETRY_INTERVAL_MS;
        }
      } finally {
        inFlight = false;
        controller = undefined;
        schedule(nextDelay);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      void load();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void load();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [environmentId]);

  return snapshot?.environmentId === environmentId ? snapshot.metrics : null;
}
