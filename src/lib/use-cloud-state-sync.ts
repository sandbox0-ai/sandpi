"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  apiFetchConditional,
  type ApiEnvelope,
} from "@/lib/api-client";
import {
  CLOUD_SYNC_STALE_MS,
  NATIVE_APP_RESUME_EVENT,
} from "@/lib/cloud-state-sync";
import type { SandpiCloudSnapshot } from "@/lib/types";

export type CloudSyncReason =
  | "foreground"
  | "focus"
  | "network"
  | "pageshow"
  | "pull";

export type CloudSyncOutcome = "skipped" | "unchanged" | "updated";

interface CloudStateSyncOptions {
  applySnapshot: (snapshot: SandpiCloudSnapshot) => void;
  getLocalStateVersion?: () => number;
  onSynchronized?: () => void;
}

export function useCloudStateSync({
  applySnapshot,
  getLocalStateVersion = () => 0,
  onSynchronized,
}: CloudStateSyncOptions) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const applySnapshotRef = useRef(applySnapshot);
  const getLocalStateVersionRef = useRef(getLocalStateVersion);
  const onSynchronizedRef = useRef(onSynchronized);
  const etagRef = useRef<string | undefined>(undefined);
  const lastSynchronizedAtRef = useRef(Date.now());
  const activeRefreshRef = useRef<
    Promise<CloudSyncOutcome> | undefined
  >(undefined);

  useEffect(() => {
    applySnapshotRef.current = applySnapshot;
    getLocalStateVersionRef.current = getLocalStateVersion;
    onSynchronizedRef.current = onSynchronized;
  }, [applySnapshot, getLocalStateVersion, onSynchronized]);

  const refresh = useCallback(
    (
      reason: CloudSyncReason,
      options: { force?: boolean } = {},
    ): Promise<CloudSyncOutcome> => {
      const now = Date.now();
      if (
        !options.force &&
        now - lastSynchronizedAtRef.current < CLOUD_SYNC_STALE_MS
      ) {
        return Promise.resolve("skipped");
      }
      const active = activeRefreshRef.current;
      if (active) return active;

      const operation = (async () => {
        setRefreshing(true);
        setError("");
        try {
          const localVersion = getLocalStateVersionRef.current();
          let response = await apiFetchConditional<
            ApiEnvelope<SandpiCloudSnapshot>
          >("/api/v1/sync", etagRef.current);

          // A local mutation that completed during the request may otherwise be
          // replaced by a response that started before that mutation.
          if (
            !response.notModified &&
            localVersion !== getLocalStateVersionRef.current()
          ) {
            response = await apiFetchConditional<
              ApiEnvelope<SandpiCloudSnapshot>
            >("/api/v1/sync", etagRef.current);
          }

          if (response.etag) etagRef.current = response.etag;
          if (!response.notModified) {
            applySnapshotRef.current(response.data.data);
          }
          lastSynchronizedAtRef.current = Date.now();
          onSynchronizedRef.current?.();
          return response.notModified ? "unchanged" : "updated";
        } catch (refreshError) {
          const message =
            refreshError instanceof Error
              ? refreshError.message
              : "Sandpi could not synchronize cloud state.";
          setError(message);
          throw refreshError;
        } finally {
          setRefreshing(false);
        }
      })();

      activeRefreshRef.current = operation;
      const clearActive = () => {
        if (activeRefreshRef.current === operation) {
          activeRefreshRef.current = undefined;
        }
      };
      void operation.then(clearActive, clearActive);
      return operation;
    },
    [],
  );
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const synchronize = (
      reason: Exclude<CloudSyncReason, "pull">,
      force = false,
    ) => {
      void refreshRef.current(reason, { force }).catch(() => undefined);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        synchronize("foreground");
      }
    };
    const handleFocus = () => synchronize("focus");
    const handleOnline = () => synchronize("network", true);
    const handlePageShow = () => synchronize("pageshow");
    const handleNativeResume = () => synchronize("foreground");

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener(NATIVE_APP_RESUME_EVENT, handleNativeResume);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener(
        NATIVE_APP_RESUME_EVENT,
        handleNativeResume,
      );
    };
  }, []);

  return { error, refresh, refreshing };
}
