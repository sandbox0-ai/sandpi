"use client";

import {
  Download,
  FileAudio,
  FileSpreadsheet,
  LoaderCircle,
  Minus,
  Plus,
  Presentation,
  Search,
} from "lucide-react";
import Image from "next/image";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type { OperationLanguage } from "@/lib/operation-ui";
import type { WorkspaceIdeFile } from "@/lib/types";
import { parseWorkspaceDelimitedPreview } from "@/lib/workspace-csv-preview";
import { workspaceTextPresentationForName } from "@/lib/workspace-file-presentation";
import { userVisibleWorkspacePath } from "@/lib/workspace-path-policy";

import { MarkdownContent } from "./markdown-content";
import { WorkspaceImagePreview } from "./workspace-image-preview";
import styles from "./workspace-file-viewer.module.css";

const SOURCE_PREVIEW_CHARACTER_LIMIT = 750_000;
const SOURCE_PREVIEW_LINE_LIMIT = 4_000;
const CSV_PAGE_SIZE = 100;

const copy = {
  en: {
    loading: "Loading preview…",
    empty: "This file is empty.",
    truncatedSource: (lines: number) =>
      `Preview limited to the first ${lines.toLocaleString()} lines. Open the editor to inspect the full file.`,
    previewUnavailable: "Your browser cannot preview this format.",
    download: "Download file",
    csvTable: "Table",
    csvRaw: "Raw",
    csvSearch: "Filter rows",
    csvSearchPlaceholder: "Search visible data…",
    csvNoRows: "No matching rows.",
    csvMore: (count: number) => `Show ${count.toLocaleString()} more rows`,
    csvSummary: (visible: number, total: number) =>
      `${visible.toLocaleString()} of ${total.toLocaleString()} rows`,
    csvTruncated: "Large CSV preview was safely limited. Download or edit for the complete data.",
    imageLoading: (name: string) => `Loading ${name}…`,
    imageUnavailable: "Image unavailable",
    openImage: (name: string) => `Open ${name}`,
    presentationLoading: "Preparing presentation…",
    presentationProgress: (progress: number) => `Rendering slides · ${progress}%`,
    presentationReady: "Presentation ready",
    presentationError: "This presentation could not be previewed.",
    presentationZoom: "Presentation zoom",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    previewLabel: (kind: string, name: string) =>
      `${kind === "pdf" ? "PDF" : `${kind[0]?.toUpperCase()}${kind.slice(1)}`} preview: ${name}`,
  },
  "zh-CN": {
    loading: "正在加载预览…",
    empty: "此文件为空。",
    truncatedSource: (lines: number) =>
      `预览仅显示前 ${lines.toLocaleString()} 行；如需查看完整文件，请打开编辑器。`,
    previewUnavailable: "当前浏览器无法预览此格式。",
    download: "下载文件",
    csvTable: "表格",
    csvRaw: "原始文本",
    csvSearch: "筛选行",
    csvSearchPlaceholder: "搜索可见数据…",
    csvNoRows: "没有匹配的行。",
    csvMore: (count: number) => `再显示 ${count.toLocaleString()} 行`,
    csvSummary: (visible: number, total: number) =>
      `已显示 ${visible.toLocaleString()} / ${total.toLocaleString()} 行`,
    csvTruncated: "大型 CSV 已进行安全截断；可下载或编辑以查看完整数据。",
    imageLoading: (name: string) => `正在加载 ${name}…`,
    imageUnavailable: "图片无法加载",
    openImage: (name: string) => `打开 ${name}`,
    presentationLoading: "正在准备演示文稿…",
    presentationProgress: (progress: number) => `正在渲染幻灯片 · ${progress}%`,
    presentationReady: "演示文稿已就绪",
    presentationError: "无法预览此演示文稿。",
    presentationZoom: "演示文稿缩放",
    zoomIn: "放大",
    zoomOut: "缩小",
    previewLabel: (kind: string, name: string) => `${name} ${kind}预览`,
  },
} as const;

function decodeBase64Bytes(content: string) {
  const raw = window.atob(content);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function useWorkspacePreviewUrl(file: WorkspaceIdeFile) {
  const [source, setSource] = useState<string>();
  const mimeType =
    file.preview?.mimeType ??
    (file.kind === "binary" ? "application/octet-stream" : undefined);

  useEffect(() => {
    if (!mimeType) return;
    const objectUrl = URL.createObjectURL(
      new Blob([decodeBase64Bytes(file.content)], { type: mimeType }),
    );
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file.content, mimeType]);

  return source;
}

function sourcePreviewLines(content: string) {
  const bounded = content.slice(0, SOURCE_PREVIEW_CHARACTER_LIMIT);
  const allLines = bounded.split(/\r?\n/);
  const lines = allLines.slice(0, SOURCE_PREVIEW_LINE_LIMIT);
  return {
    lines: lines.length > 0 ? lines : [""],
    truncated:
      bounded.length < content.length || allLines.length > lines.length,
  };
}

function WorkspaceSourcePreview({
  file,
  text,
  language,
}: {
  file: WorkspaceIdeFile;
  text: string;
  language: OperationLanguage;
}) {
  const ui = copy[language];
  const preview = useMemo(() => sourcePreviewLines(text), [text]);
  const lineChanges = useMemo(
    () => new Map(file.lineChanges.map((change) => [change.line, change.kind])),
    [file.lineChanges],
  );

  if (text.length === 0) {
    return <div className={styles.emptyState}>{ui.empty}</div>;
  }

  return (
    <div className={styles.sourcePreview} data-testid="workspace-source-preview">
      {preview.truncated ? (
        <div className={styles.limitNotice} role="status">
          {ui.truncatedSource(preview.lines.length)}
        </div>
      ) : null}
      <div className={styles.sourceScroller}>
        <div className={styles.sourceLines}>
          {preview.lines.map((line, index) => {
            const lineNumber = index + 1;
            const change = lineChanges.get(lineNumber);
            return (
              <div
                key={lineNumber}
                className={`${styles.sourceLine}${
                  change ? ` sandpi-line-${change}` : ""
                }`}
              >
                <span className={styles.lineNumber} aria-hidden="true">
                  {lineNumber}
                </span>
                <code>{line || "\u00a0"}</code>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WorkspaceCsvPreview({
  file,
  text,
  language,
}: {
  file: WorkspaceIdeFile;
  text: string;
  language: OperationLanguage;
}) {
  const ui = copy[language];
  const [view, setView] = useState<"raw" | "table">("table");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [visibleCount, setVisibleCount] = useState(CSV_PAGE_SIZE);
  const preview = useMemo(
    () => parseWorkspaceDelimitedPreview(file.name, text),
    [file.name, text],
  );
  const header = preview.rows[0] ?? [];
  const dataRows = useMemo(() => {
    const rows = preview.rows.slice(1);
    if (!deferredQuery) return rows;
    return rows.filter((row) =>
      row.some((cell) => cell.toLocaleLowerCase().includes(deferredQuery)),
    );
  }, [deferredQuery, preview.rows]);
  const visibleRows = dataRows.slice(0, visibleCount);

  useEffect(() => setVisibleCount(CSV_PAGE_SIZE), [deferredQuery, text]);

  if (view === "raw") {
    return (
      <div className={styles.csvPreview} data-testid="workspace-csv-preview">
        <CsvToolbar
          language={language}
          view={view}
          onViewChange={setView}
        />
        <WorkspaceSourcePreview file={file} text={text} language={language} />
      </div>
    );
  }

  return (
    <div className={styles.csvPreview} data-testid="workspace-csv-preview">
      <CsvToolbar language={language} view={view} onViewChange={setView}>
        <label className={styles.csvSearch}>
          <Search size={13} aria-hidden="true" />
          <span className={styles.srOnly}>{ui.csvSearch}</span>
          <input
            value={query}
            type="search"
            placeholder={ui.csvSearchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </CsvToolbar>
      {preview.truncated ? (
        <div className={styles.csvNotice} role="status">
          {ui.csvTruncated}
        </div>
      ) : null}
      <div className={styles.tableScroller}>
        {header.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th className={styles.rowNumber}>#</th>
                {header.map((cell, index) => (
                  <th key={index}>{cell || `Column ${index + 1}`}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th className={styles.rowNumber}>{rowIndex + 1}</th>
                  {Array.from({ length: preview.columnCount }, (_, index) => (
                    <td key={index} title={row[index]}>
                      {row[index] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={styles.emptyState}>{ui.empty}</div>
        )}
        {header.length > 0 && visibleRows.length === 0 ? (
          <div className={styles.emptyState}>{ui.csvNoRows}</div>
        ) : null}
      </div>
      <div className={styles.csvFooter}>
        <span>{ui.csvSummary(visibleRows.length, dataRows.length)}</span>
        {visibleRows.length < dataRows.length ? (
          <button
            type="button"
            onClick={() =>
              setVisibleCount((current) => current + CSV_PAGE_SIZE)
            }
          >
            {ui.csvMore(
              Math.min(CSV_PAGE_SIZE, dataRows.length - visibleRows.length),
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CsvToolbar({
  language,
  view,
  onViewChange,
  children,
}: {
  language: OperationLanguage;
  view: "raw" | "table";
  onViewChange: (view: "raw" | "table") => void;
  children?: ReactNode;
}) {
  const ui = copy[language];
  return (
    <div className={styles.csvToolbar}>
      <div className={styles.segmentedControl}>
        <button
          type="button"
          aria-pressed={view === "table"}
          onClick={() => onViewChange("table")}
        >
          <FileSpreadsheet size={13} aria-hidden="true" /> {ui.csvTable}
        </button>
        <button
          type="button"
          aria-pressed={view === "raw"}
          onClick={() => onViewChange("raw")}
        >
          {ui.csvRaw}
        </button>
      </div>
      {children}
    </div>
  );
}

function MarkdownWorkspaceImage({
  environmentId,
  path,
  alt,
  language,
  onOpenWorkspacePath,
}: {
  environmentId: string;
  path: string;
  alt: string;
  language: OperationLanguage;
  onOpenWorkspacePath: (path: string) => void;
}) {
  const ui = copy[language];
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const name = path.split("/").at(-1) ?? path;

  useEffect(() => {
    const target = containerRef.current;
    if (!target || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setFailed(false);
    const query = new URLSearchParams({ path });
    void apiFetch<ApiEnvelope<WorkspaceIdeFile>>(
      `/api/v1/environments/${encodeURIComponent(environmentId)}/ide/file?${query.toString()}`,
      { signal: controller.signal },
    )
      .then((response) => {
        const responsePath = userVisibleWorkspacePath(response.data.path);
        if (
          responsePath !== path ||
          response.data.preview?.kind !== "image"
        ) {
          throw new Error("Workspace image response was not previewable.");
        }
        objectUrl = URL.createObjectURL(
          new Blob([decodeBase64Bytes(response.data.content)], {
            type: response.data.preview.mimeType,
          }),
        );
        setSource(objectUrl);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [environmentId, path, visible]);

  return (
    <div ref={containerRef} className={styles.markdownImage}>
      {source ? (
        <button
          type="button"
          aria-label={ui.openImage(name)}
          onClick={() => onOpenWorkspacePath(path)}
        >
          <Image src={source} alt={alt} width={1280} height={720} unoptimized />
        </button>
      ) : (
        <button type="button" onClick={() => onOpenWorkspacePath(path)}>
          {failed ? (
            ui.imageUnavailable
          ) : (
            <>
              <LoaderCircle className={styles.spin} size={14} aria-hidden="true" />
              {ui.imageLoading(name)}
            </>
          )}
        </button>
      )}
    </div>
  );
}

const PRESENTATION_FRAME_HTML = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; media-src blob: data:; style-src 'unsafe-inline'; font-src blob: data:">
<style>html,body{min-height:100%;margin:0;background:#e9e9e4;color:#222;font-family:system-ui,sans-serif}body{overflow:auto}</style>
</head><body><div id="sandpi-presentation-root"></div></body></html>`;

type PresentationViewerHandle = {
  destroy: () => void;
  setZoom: (percent: number) => Promise<void>;
};

function presentationErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { detail?: unknown; message?: unknown };
  if (typeof candidate.message === "string") return candidate.message;
  if (typeof candidate.detail === "string") return candidate.detail;
  return undefined;
}

function sanitizePresentationSlide(element: Element | null) {
  if (!element) return;
  for (const unsafe of element.querySelectorAll(
    "script, iframe, object, embed, form, input, button, textarea, select, link, meta, base",
  )) {
    unsafe.remove();
  }
  for (const node of [element, ...element.querySelectorAll("*")]) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || /^\s*(?:javascript|vbscript):/i.test(value)) {
        node.removeAttribute(attribute.name);
      }
      if (
        ["href", "src", "poster", "xlink:href"].includes(name) &&
        !/^(?:blob:|data:|#)/i.test(value)
      ) {
        node.removeAttribute(attribute.name);
      }
      if (name === "srcset") node.removeAttribute(attribute.name);
    }
  }
}

function WorkspacePresentationPreview({
  file,
  language,
}: {
  file: WorkspaceIdeFile;
  language: OperationLanguage;
}) {
  const ui = copy[language];
  const frameRef = useRef<HTMLIFrameElement>(null);
  const viewerRef = useRef<PresentationViewerHandle | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [zoom, setZoom] = useState(100);
  const downloadSource = `data:${file.preview?.mimeType ?? "application/octet-stream"};base64,${file.content}`;

  useEffect(() => {
    if (!frameReady) return;
    const frameDocument = frameRef.current?.contentDocument;
    const mount = frameDocument?.getElementById("sandpi-presentation-root");
    if (!frameDocument || !mount) return;
    const shadow = mount.shadowRoot ?? mount.attachShadow({ mode: "open" });
    const customStyle = frameDocument.createElement("style");
    customStyle.textContent = `
      :host { display: block; min-height: 100vh; }
      .sandpi-pptx-target { box-sizing: border-box; width: 100%; min-height: 100vh; padding: 26px; }
      @media (max-width: 600px) { .sandpi-pptx-target { padding: 12px; } }
    `;
    const target = frameDocument.createElement("div");
    target.className = "sandpi-pptx-target";
    shadow.replaceChildren(customStyle, target);
    let disposed = false;
    let viewer: PresentationViewerHandle | undefined;
    setProgress(0);
    setReady(false);
    setError(undefined);

    void import("@file-viewer/pptx")
      .then(async ({ PptxViewer }) => {
        const bytes = decodeBase64Bytes(file.content);
        viewer = await PptxViewer.open(bytes.buffer as ArrayBuffer, target, {
          styleRoot: shadow,
          fitMode: "contain",
          zoomPercent: 100,
          zipLimits: { maxFileBytes: 5 * 1024 * 1024 },
          lazySlides: true,
          lazyMedia: true,
          listOptions: {
            windowed: true,
            initialSlides: 3,
            batchSize: 4,
            overscanViewport: 1.25,
          },
          onProgress(nextProgress) {
            if (!disposed) {
              setProgress(Math.max(0, Math.min(100, Math.round(nextProgress))));
            }
          },
          onSlideRendered(_slideIndex, element) {
            sanitizePresentationSlide(element);
          },
          onRenderComplete() {
            if (!disposed) {
              setProgress(100);
              setReady(true);
            }
          },
          onError(cause) {
            if (!disposed) {
              setError(presentationErrorMessage(cause) ?? ui.presentationError);
            }
          },
        });
        if (disposed) {
          viewer.destroy();
          return;
        }
        viewerRef.current = viewer;
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setError(presentationErrorMessage(cause) ?? ui.presentationError);
        }
      });

    return () => {
      disposed = true;
      viewerRef.current = null;
      viewer?.destroy();
      shadow.replaceChildren();
    };
  }, [file.content, file.revision, frameReady, ui.presentationError]);

  const updateZoom = useCallback((nextZoom: number) => {
    const bounded = Math.max(50, Math.min(200, nextZoom));
    setZoom(bounded);
    void viewerRef.current?.setZoom(bounded);
  }, []);

  return (
    <div className={styles.presentationPreview} data-testid="workspace-presentation-preview">
      <iframe
        ref={frameRef}
        title={`${file.name} presentation preview`}
        sandbox="allow-same-origin"
        srcDoc={PRESENTATION_FRAME_HTML}
        onLoad={() => setFrameReady(true)}
      />
      <div className={styles.presentationStatus} role="status">
        {error ? (
          <>
            <Presentation size={15} aria-hidden="true" />
            <span>{error}</span>
            <a href={downloadSource} download={file.name}>
              <Download size={13} aria-hidden="true" /> {ui.download}
            </a>
          </>
        ) : ready ? (
          <span>{ui.presentationReady}</span>
        ) : (
          <>
            <LoaderCircle className={styles.spin} size={14} aria-hidden="true" />
            <span>
              {progress > 0
                ? ui.presentationProgress(progress)
                : ui.presentationLoading}
            </span>
          </>
        )}
      </div>
      {!error ? (
        <div className={styles.presentationToolbar} role="group" aria-label={ui.presentationZoom}>
          <button
            type="button"
            aria-label={ui.zoomOut}
            disabled={zoom <= 50}
            onClick={() => updateZoom(zoom - 25)}
          >
            <Minus size={13} aria-hidden="true" />
          </button>
          <output>{zoom}%</output>
          <button
            type="button"
            aria-label={ui.zoomIn}
            disabled={zoom >= 200}
            onClick={() => updateZoom(zoom + 25)}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function mediaTypeLabel(file: WorkspaceIdeFile) {
  const mimeType = file.preview?.mimeType ?? "";
  return (
    {
      "audio/aac": "AAC audio",
      "audio/aiff": "AIFF audio",
      "audio/flac": "FLAC audio",
      "audio/midi": "MIDI audio",
      "audio/mp4": "MPEG-4 audio",
      "audio/mpeg": "MP3 audio",
      "audio/ogg": "Ogg audio",
      "audio/wav": "WAV audio",
      "audio/webm": "WebM audio",
    }[mimeType] ?? mimeType
  );
}

function WorkspaceBrowserMediaPreview({
  file,
  language,
}: {
  file: WorkspaceIdeFile;
  language: OperationLanguage;
}) {
  const ui = copy[language];
  const source = useWorkspacePreviewUrl(file);
  const preview = file.preview!;
  if (!source) {
    return (
      <div className={styles.emptyState} role="status">
        <LoaderCircle className={styles.spin} size={15} aria-hidden="true" />
        {ui.loading}
      </div>
    );
  }
  const label = ui.previewLabel(preview.kind, file.name);
  if (preview.kind === "image") {
    return (
      <div className={`${styles.filePreview} ${styles.imagePreview}`}>
        <WorkspaceImagePreview
          key={`${file.path}:${file.revision}`}
          source={source}
          name={file.name}
          alt={label}
          language={language}
        />
      </div>
    );
  }
  if (preview.kind === "audio") {
    return (
      <div className={`${styles.filePreview} ${styles.audioPreview}`}>
        <div className={styles.audioIdentity}>
          <FileAudio size={30} aria-hidden="true" />
          <strong>{file.name}</strong>
          <span>{mediaTypeLabel(file)}</span>
        </div>
        <audio aria-label={label} controls preload="metadata" src={source}>
          {ui.previewUnavailable}
        </audio>
      </div>
    );
  }
  if (preview.kind === "video") {
    return (
      <div className={`${styles.filePreview} ${styles.videoPreview}`}>
        <video aria-label={label} controls preload="metadata" src={source}>
          {ui.previewUnavailable}
        </video>
      </div>
    );
  }
  return (
    <div className={`${styles.filePreview} ${styles.pdfPreview}`}>
      <object aria-label={label} data={source} type={preview.mimeType}>
        <p>
          {ui.previewUnavailable}{" "}
          <a href={source} download={file.name}>
            {ui.download}
          </a>
        </p>
      </object>
    </div>
  );
}

function WorkspaceBinaryPreview({
  file,
  language,
}: {
  file: WorkspaceIdeFile;
  language: OperationLanguage;
}) {
  const ui = copy[language];
  if (!file.preview) {
    const source = `data:application/octet-stream;base64,${file.content}`;
    return (
      <div className={styles.emptyState}>
        <span>{ui.previewUnavailable}</span>
        <a href={source} download={file.name}>
          <Download size={13} aria-hidden="true" /> {ui.download}
        </a>
      </div>
    );
  }
  if (file.preview.kind === "presentation") {
    return <WorkspacePresentationPreview file={file} language={language} />;
  }
  return <WorkspaceBrowserMediaPreview file={file} language={language} />;
}

export function WorkspaceFileViewer({
  environmentId,
  file,
  text,
  language,
  onOpenWorkspacePath,
}: {
  environmentId: string;
  file: WorkspaceIdeFile;
  text?: string;
  language: OperationLanguage;
  onOpenWorkspacePath: (path: string) => void;
}) {
  const renderWorkspaceImage = useCallback(
    (path: string, alt: string) => (
      <MarkdownWorkspaceImage
        key={path}
        environmentId={environmentId}
        path={path}
        alt={alt}
        language={language}
        onOpenWorkspacePath={onOpenWorkspacePath}
      />
    ),
    [environmentId, language, onOpenWorkspacePath],
  );

  if (file.kind === "binary") {
    return <WorkspaceBinaryPreview file={file} language={language} />;
  }

  const content = text ?? "";
  const presentation = workspaceTextPresentationForName(file.name);
  if (presentation === "markdown") {
    return (
      <div className={styles.markdownPreview} data-testid="workspace-markdown-preview">
        <MarkdownContent
          content={content}
          baseWorkspacePath={file.path}
          onOpenWorkspacePath={onOpenWorkspacePath}
          renderWorkspaceImage={renderWorkspaceImage}
        />
      </div>
    );
  }
  if (presentation === "csv") {
    return <WorkspaceCsvPreview file={file} text={content} language={language} />;
  }
  return <WorkspaceSourcePreview file={file} text={content} language={language} />;
}
