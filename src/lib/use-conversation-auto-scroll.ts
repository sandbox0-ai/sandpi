"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
  type UIEventHandler,
} from "react";

interface ScrollGeometry {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

interface ConversationAutoScrollOptions {
  /** A different conversation must always start at its latest content. */
  resetKey: string;
  /** Distance that counts as returning to the bottom by hand. */
  bottomThreshold?: number;
}

interface ConversationAutoScroll {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  scrollToBottom: () => void;
}

export function isNearConversationBottom(
  geometry: ScrollGeometry,
  threshold = 8,
) {
  const distance =
    geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop;
  return distance <= Math.max(0, threshold);
}

/**
 * Follow content growth until the user scrolls away, then resume only after
 * they return to the bottom. ResizeObserver makes this independent of any
 * coding-agent event schema and also covers streaming text and loaded images.
 */
export function useConversationAutoScroll({
  resetKey,
  bottomThreshold = 8,
}: ConversationAutoScrollOptions): ConversationAutoScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const frameRef = useRef<number | null>(null);

  const scheduleScrollToBottom = useCallback((force = false) => {
    if (force) followingRef.current = true;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (!followingRef.current) return;
      const scrollRegion = scrollRef.current;
      if (scrollRegion) scrollRegion.scrollTop = scrollRegion.scrollHeight;
    });
  }, []);

  useLayoutEffect(() => {
    followingRef.current = true;
    scheduleScrollToBottom();

    const scrollRegion = scrollRef.current;
    const content = contentRef.current;
    if (!scrollRegion || !content || typeof ResizeObserver === "undefined") {
      return () => {
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      };
    }

    const resizeObserver = new ResizeObserver(() => scheduleScrollToBottom());
    resizeObserver.observe(scrollRegion);
    resizeObserver.observe(content);
    return () => {
      resizeObserver.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [resetKey, scheduleScrollToBottom]);

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      followingRef.current = isNearConversationBottom(
        event.currentTarget,
        bottomThreshold,
      );
    },
    [bottomThreshold],
  );

  const scrollToBottom = useCallback(
    () => scheduleScrollToBottom(true),
    [scheduleScrollToBottom],
  );

  return { scrollRef, contentRef, onScroll, scrollToBottom };
}
