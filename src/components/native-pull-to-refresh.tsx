"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const PULL_THRESHOLD_PX = 64;
const MAX_PULL_DISTANCE_PX = 88;
const NATIVE_SHELL_READY_EVENT = "sandpi:native-shell-ready";
const EXCLUDED_PULL_TARGETS = [
  "input",
  "textarea",
  "select",
  "button",
  "a",
  "iframe",
  "canvas",
  "[contenteditable='true']",
  "[data-pull-refresh-disabled]",
  "[role='dialog']",
  ".terminal-dock",
].join(",");

interface NativeShellWindow extends Window {
  __sandpiNativeShellInstalled?: boolean;
}

interface PullGesture {
  identifier: number;
  startX: number;
  startY: number;
  scrollRoot?: HTMLElement;
}

function closestScrollable(target: Element) {
  let candidate: HTMLElement | null =
    target instanceof HTMLElement ? target : target.parentElement;
  while (candidate && !candidate.classList.contains("app-frame")) {
    const style = window.getComputedStyle(candidate);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      candidate.scrollHeight > candidate.clientHeight + 1
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return undefined;
}

export function NativePullToRefresh({
  language,
  onRefresh,
}: {
  language: "en" | "zh-CN";
  onRefresh: () => Promise<unknown>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const gestureRef = useRef<PullGesture | undefined>(undefined);
  const distanceRef = useRef(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const detectNativeShell = () => {
      setEnabled(
        Boolean(
          (window as NativeShellWindow).__sandpiNativeShellInstalled,
        ),
      );
    };
    detectNativeShell();
    window.addEventListener(NATIVE_SHELL_READY_EVENT, detectNativeShell);
    return () =>
      window.removeEventListener(
        NATIVE_SHELL_READY_EVENT,
        detectNativeShell,
      );
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const reset = () => {
      gestureRef.current = undefined;
      distanceRef.current = 0;
      setDistance(0);
    };
    const handleTouchStart = (event: TouchEvent) => {
      if (refreshing || event.touches.length !== 1) return;
      const target =
        event.target instanceof Element ? event.target : undefined;
      if (!target || target.closest(EXCLUDED_PULL_TARGETS)) return;
      const touch = event.touches[0];
      const scrollRoot = closestScrollable(target);
      if (!touch || (scrollRoot?.scrollTop ?? 0) > 0) return;
      setFailed(false);
      gestureRef.current = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        scrollRoot,
      };
    };
    const handleTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const touch = [...event.touches].find(
        (candidate) => candidate.identifier === gesture.identifier,
      );
      if (!touch || (gesture.scrollRoot?.scrollTop ?? 0) > 0) {
        reset();
        return;
      }
      const deltaX = Math.abs(touch.clientX - gesture.startX);
      const deltaY = touch.clientY - gesture.startY;
      if (deltaY <= 0 || deltaX > deltaY * 0.8) {
        reset();
        return;
      }
      event.preventDefault();
      const nextDistance = Math.min(
        MAX_PULL_DISTANCE_PX,
        deltaY * 0.52,
      );
      distanceRef.current = nextDistance;
      setDistance(nextDistance);
    };
    const handleTouchEnd = () => {
      const shouldRefresh = distanceRef.current >= PULL_THRESHOLD_PX;
      reset();
      if (!shouldRefresh) return;
      setRefreshing(true);
      setDistance(PULL_THRESHOLD_PX);
      void refreshRef
        .current()
        .then(() => setFailed(false))
        .catch(() => setFailed(true))
        .finally(() => {
          setRefreshing(false);
          setDistance(0);
        });
    };

    document.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    document.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    document.addEventListener("touchend", handleTouchEnd, {
      passive: true,
    });
    document.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", reset);
    };
  }, [enabled, refreshing]);

  if (!enabled) return null;
  const label = failed
    ? language === "zh-CN"
      ? "同步失败"
      : "Sync failed"
    : refreshing
      ? language === "zh-CN"
        ? "正在同步"
        : "Synchronizing"
      : language === "zh-CN"
        ? "下拉刷新"
        : "Pull to refresh";
  const style = {
    "--pull-refresh-distance": `${distance}px`,
    "--pull-refresh-progress": Math.min(
      1,
      distance / PULL_THRESHOLD_PX,
    ),
  } as CSSProperties;

  return (
    <div
      className={`native-pull-refresh ${
        refreshing ? "is-refreshing" : ""
      } ${failed ? "has-failed" : ""}`}
      data-testid="native-pull-refresh"
      style={style}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {refreshing ? (
        <LoaderCircle size={16} aria-hidden="true" />
      ) : (
        <RefreshCw size={16} aria-hidden="true" />
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}
