"use client";

import { Minus, Plus, Scan } from "lucide-react";
import Image from "next/image";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { OperationLanguage } from "@/lib/operation-ui";

import styles from "./workspace-image-preview.module.css";

const IMAGE_ZOOM_LEVELS: readonly number[] = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4,
];
const FIT_ZOOM = 1;

const copy = {
  en: {
    viewer: (name: string) => `Image viewer: ${name}`,
    controls: "Image size controls",
    zoomIn: "Zoom in (+)",
    zoomOut: "Zoom out (−)",
    fit: "Fit image to viewport (0)",
    zoomLevel: "Image zoom level",
    dimensions: (width: number, height: number) =>
      `${width} by ${height} pixels`,
    keyboardHint:
      "Focus the image viewer, then use plus, minus, or zero to change its size.",
  },
  "zh-CN": {
    viewer: (name: string) => `图片查看器：${name}`,
    controls: "图片大小控制",
    zoomIn: "放大（+）",
    zoomOut: "缩小（−）",
    fit: "适配视口（0）",
    zoomLevel: "图片缩放比例",
    dimensions: (width: number, height: number) =>
      `${width} × ${height} 像素`,
    keyboardHint: "聚焦图片查看器后，可使用加号、减号或数字 0 调整大小。",
  },
} as const;

function adjacentZoom(current: number, direction: "in" | "out") {
  if (direction === "in") {
    return (
      IMAGE_ZOOM_LEVELS.find((candidate) => candidate > current) ??
      IMAGE_ZOOM_LEVELS.at(-1)!
    );
  }
  return (
    IMAGE_ZOOM_LEVELS.findLast((candidate) => candidate < current) ??
    IMAGE_ZOOM_LEVELS[0]!
  );
}

export function WorkspaceImagePreview({
  source,
  name,
  alt,
  language,
}: {
  source: string;
  name: string;
  alt: string;
  language: OperationLanguage;
}) {
  const ui = copy[language];
  const hintId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const pendingScrollFrame = useRef<number | null>(null);
  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  }>();

  useEffect(
    () => () => {
      if (pendingScrollFrame.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrame.current);
      }
    },
    [],
  );

  const updateZoom = useCallback(
    (nextZoom: number) => {
      if (nextZoom === zoom) return;

      const viewport = viewportRef.current;
      const centerX = viewport
        ? (viewport.scrollLeft + viewport.clientWidth / 2) /
          viewport.scrollWidth
        : 0.5;
      const centerY = viewport
        ? (viewport.scrollTop + viewport.clientHeight / 2) /
          viewport.scrollHeight
        : 0.5;

      setZoom(nextZoom);
      if (!viewport) return;
      if (pendingScrollFrame.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrame.current);
      }
      pendingScrollFrame.current = window.requestAnimationFrame(() => {
        const currentViewport = viewportRef.current;
        if (!currentViewport) return;
        currentViewport.scrollLeft =
          centerX * currentViewport.scrollWidth -
          currentViewport.clientWidth / 2;
        currentViewport.scrollTop =
          centerY * currentViewport.scrollHeight -
          currentViewport.clientHeight / 2;
        pendingScrollFrame.current = null;
      });
    },
    [zoom],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        updateZoom(adjacentZoom(zoom, "in"));
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        updateZoom(adjacentZoom(zoom, "out"));
      } else if (event.key === "0") {
        event.preventDefault();
        updateZoom(FIT_ZOOM);
      }
    },
    [updateZoom, zoom],
  );

  const canvasScale = Math.max(FIT_ZOOM, zoom);
  const zoomPercentage = Math.round(zoom * 100);
  const minimumZoom = IMAGE_ZOOM_LEVELS[0]!;
  const maximumZoom = IMAGE_ZOOM_LEVELS.at(-1)!;

  return (
    <div className={styles.viewer}>
      <div
        ref={viewportRef}
        className={styles.viewport}
        role="region"
        aria-label={ui.viewer(name)}
        aria-describedby={hintId}
        tabIndex={0}
        data-zoom={zoom}
        onKeyDown={handleKeyDown}
      >
        <span id={hintId} className={styles.srOnly}>
          {ui.keyboardHint}
        </span>
        <div
          className={styles.canvas}
          style={{
            width: `${canvasScale * 100}%`,
            height: `${canvasScale * 100}%`,
          }}
        >
          <div
            className={styles.imageFrame}
            style={{
              width: `${100 / canvasScale}%`,
              height: `${100 / canvasScale}%`,
              transform: `translate(-50%, -50%) scale(${zoom})`,
            }}
          >
            <Image
              src={source}
              alt={alt}
              fill
              sizes="100vw"
              unoptimized
              draggable={false}
              className={styles.image}
              onLoad={({ currentTarget }) => {
                const nextDimensions = {
                  width: currentTarget.naturalWidth,
                  height: currentTarget.naturalHeight,
                };
                setDimensions((current) =>
                  current?.width === nextDimensions.width &&
                  current.height === nextDimensions.height
                    ? current
                    : nextDimensions,
                );
              }}
            />
          </div>
        </div>
      </div>

      <div className={styles.toolbar} role="group" aria-label={ui.controls}>
        {dimensions ? (
          <span
            className={styles.dimensions}
            title={ui.dimensions(dimensions.width, dimensions.height)}
          >
            {dimensions.width} × {dimensions.height} px
          </span>
        ) : null}
        <button
          type="button"
          aria-label={ui.zoomOut}
          title={ui.zoomOut}
          disabled={zoom === minimumZoom}
          onClick={() => updateZoom(adjacentZoom(zoom, "out"))}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        <output className={styles.zoomLevel} aria-label={ui.zoomLevel}>
          {zoomPercentage}%
        </output>
        <button
          type="button"
          aria-label={ui.zoomIn}
          title={ui.zoomIn}
          disabled={zoom === maximumZoom}
          onClick={() => updateZoom(adjacentZoom(zoom, "in"))}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <button
          type="button"
          aria-label={ui.fit}
          title={ui.fit}
          disabled={zoom === FIT_ZOOM}
          onClick={() => updateZoom(FIT_ZOOM)}
        >
          <Scan size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
