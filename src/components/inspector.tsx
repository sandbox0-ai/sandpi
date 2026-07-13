"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  Network,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  InteractiveMetricChart,
  type MetricChartSeries,
} from "@/components/metric-chart";
import { SessionAuditPanel } from "@/components/session-audit-panel";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import type {
  CodingSession,
  RuntimeMetricSeries,
  SessionAuditFeed,
  SessionMetrics,
  WorkspaceFile,
} from "@/lib/types";

export type InspectorTab = "files" | "audit" | "metrics";

interface InspectorProps {
  language: OperationLanguage;
  timeZone: string;
  session: CodingSession;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
}

function flattenFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return files.flatMap((file) => [
    file,
    ...(file.children ? flattenFiles(file.children) : []),
  ]);
}

function FileIcon({ file }: { file: WorkspaceFile }) {
  if (file.kind === "folder") {
    return <Folder size={14} />;
  }
  if (file.name.endsWith(".json")) {
    return <FileJson size={14} />;
  }
  if (file.name.endsWith(".md")) {
    return <FileText size={14} />;
  }
  if (file.name.endsWith(".ts") || file.name.endsWith(".tsx")) {
    return <FileCode2 size={14} />;
  }
  return <File size={14} />;
}

function FileTree({
  files,
  selectedFileId,
  depth = 0,
  onSelect,
}: {
  files: WorkspaceFile[];
  selectedFileId: string;
  depth?: number;
  onSelect: (file: WorkspaceFile) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <>
      {files.map((file) => {
        const isCollapsed = collapsed[file.id] ?? false;
        const isFolder = file.kind === "folder";
        return (
          <div key={file.id}>
            <button
              type="button"
              className={`file-tree-row ${file.id === selectedFileId ? "is-selected" : ""}`}
              style={{ paddingLeft: `${10 + depth * 14}px` }}
              onClick={() => {
                if (isFolder) {
                  setCollapsed((current) => ({
                    ...current,
                    [file.id]: !isCollapsed,
                  }));
                } else {
                  onSelect(file);
                }
              }}
            >
              <span className="tree-disclosure">
                {isFolder ? (
                  isCollapsed ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )
                ) : null}
              </span>
              {isFolder ? (
                isCollapsed ? (
                  <Folder size={14} />
                ) : (
                  <FolderOpen size={14} />
                )
              ) : (
                <FileIcon file={file} />
              )}
              <span>{file.name}</span>
            </button>
            {isFolder && !isCollapsed && file.children ? (
              <FileTree
                files={file.children}
                selectedFileId={selectedFileId}
                depth={depth + 1}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function metricValues(series: RuntimeMetricSeries) {
  return series.segments.flatMap((segment) =>
    segment.points.map((point) => point.value),
  );
}

function lastMetricValue(series: RuntimeMetricSeries) {
  return series.segments.at(-1)?.points.at(-1)?.value ?? 0;
}

function averageMetricValue(series: RuntimeMetricSeries) {
  const values = metricValues(series);
  return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
}

function peakMetricValue(series: RuntimeMetricSeries) {
  return Math.max(...metricValues(series), 0);
}

function metricLocale(language: OperationLanguage) {
  return language === "zh-CN" ? "zh-CN" : "en-US";
}

function formatPercent(value: number, language: OperationLanguage) {
  return new Intl.NumberFormat(metricLocale(language), {
    style: "percent",
    maximumFractionDigits: value < 0.1 ? 1 : 0,
  }).format(value);
}

function formatMemory(value: number, language: OperationLanguage) {
  return `${new Intl.NumberFormat(metricLocale(language), {
    maximumFractionDigits: 0,
  }).format(value / 1024 / 1024)} MiB`;
}

function formatBytesPerSecond(value: number, language: OperationLanguage) {
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"];
  let amount = Math.max(value, 0);
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(metricLocale(language), {
    maximumFractionDigits: amount < 10 && unitIndex > 0 ? 1 : 0,
  }).format(amount)} ${units[unitIndex]}`;
}

function formatMetricTime(
  at: string,
  language: OperationLanguage,
  timeZone: string,
) {
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };
  if (timeZone !== "auto") {
    options.timeZone = timeZone;
  }
  try {
    return new Intl.DateTimeFormat(metricLocale(language), options).format(
      new Date(at),
    );
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat(metricLocale(language), options).format(
      new Date(at),
    );
  }
}

function decodeBase64Text(content: string) {
  const raw = window.atob(content);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface FilePreviewResponse {
  path: string;
  encoding: "base64";
  content: string;
  kind: "binary" | "text";
}

export function Inspector({
  language,
  timeZone,
  session,
  activeTab,
  onTabChange,
  onClose,
}: InspectorProps) {
  const ui = getOperationUiCopy(language).inspector;
  const [files, setFiles] = useState(session.files);
  const [audit, setAudit] = useState(session.audit);
  const [metrics, setMetrics] = useState(session.metrics);
  const [fileContents, setFileContents] = useState<
    Record<string, { kind: "binary" | "text"; text: string }>
  >({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const allFiles = useMemo(() => flattenFiles(files), [files]);
  const initialFile =
    allFiles.find((file) => file.id === "auth-callback") ??
    allFiles.find((file) => file.kind === "file") ??
    allFiles[0];
  const [selectedFileId, setSelectedFileId] = useState(initialFile?.id ?? "");
  const selectedFile =
    allFiles.find((file) => file.id === selectedFileId) ?? initialFile;
  const cpuNow = lastMetricValue(metrics.cpuUtilization);
  const memoryNow = lastMetricValue(metrics.memoryWorkingSet);
  const networkReceiveNow = lastMetricValue(metrics.networkReceive);
  const networkTransmitNow = lastMetricValue(metrics.networkTransmit);
  const chartCopy = {
    instructions: ui.metricChartInstructions,
    legendLabel: ui.metricSeries,
    toggleSeriesLabel: (label: string, visible: boolean) =>
      visible ? ui.hideMetricSeries(label) : ui.showMetricSeries(label),
    formatTime: (at: string) => formatMetricTime(at, language, timeZone),
  };

  useEffect(() => {
    setFiles(session.files);
    setAudit(session.audit);
    setMetrics(session.metrics);
    setFileContents({});
    setSelectedFileId("");
    setLoadError("");
  }, [session.id, session.audit, session.files, session.metrics]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");

    const path = `/api/v1/sessions/${encodeURIComponent(session.id)}`;
    const request =
      activeTab === "files"
        ? apiFetch<ApiEnvelope<WorkspaceFile[]>>(
            `${path}/files?path=${encodeURIComponent("/workspace")}`,
            { signal: controller.signal },
          ).then((response) => setFiles(response.data))
        : activeTab === "audit"
          ? apiFetch<ApiEnvelope<SessionAuditFeed>>(`${path}/audit`, {
              signal: controller.signal,
            }).then((response) => setAudit(response.data))
          : apiFetch<ApiEnvelope<SessionMetrics>>(`${path}/metrics`, {
              signal: controller.signal,
            }).then((response) => setMetrics(response.data));

    void request
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "This Inspector view could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [activeTab, session.id]);

  useEffect(() => {
    if (selectedFileId || !initialFile) {
      return;
    }
    setSelectedFileId(initialFile.id);
  }, [initialFile, selectedFileId]);

  useEffect(() => {
    if (
      activeTab !== "files" ||
      !selectedFile ||
      selectedFile.kind !== "file" ||
      selectedFile.content !== undefined ||
      fileContents[selectedFile.path] !== undefined
    ) {
      return;
    }
    const controller = new AbortController();
    const query = new URLSearchParams({ path: selectedFile.path });
    void apiFetch<
      ApiEnvelope<FilePreviewResponse>
    >(
      `/api/v1/sessions/${encodeURIComponent(session.id)}/file?${query.toString()}`,
      { signal: controller.signal },
    )
      .then((response) => {
        setFileContents((current) => ({
          ...current,
          [response.data.path]: {
            kind: response.data.kind,
            text:
              response.data.kind === "text"
                ? decodeBase64Text(response.data.content)
                : "",
          },
        }));
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error ? error.message : "The file could not be loaded.",
          );
        }
      });
    return () => controller.abort();
  }, [activeTab, fileContents, selectedFile, session.id]);

  return (
    <aside className="inspector" aria-label={ui.label}>
      <header className="inspector-header">
        <nav aria-label={ui.views}>
          <button
            type="button"
            className={activeTab === "files" ? "is-active" : ""}
            onClick={() => onTabChange("files")}
          >
            <FileCode2 size={14} /> {ui.files}
          </button>
          <button
            type="button"
            className={activeTab === "audit" ? "is-active" : ""}
            onClick={() => onTabChange("audit")}
          >
            <ShieldCheck size={14} /> {ui.audit}
          </button>
          <button
            type="button"
            className={activeTab === "metrics" ? "is-active" : ""}
            onClick={() => onTabChange("metrics")}
          >
            <Activity size={14} /> {ui.metrics}
          </button>
        </nav>
        <button
          type="button"
          className="icon-button"
          aria-label={ui.close}
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>

      {loading || loadError ? (
        <div className="inspector-status-bar" role={loadError ? "alert" : "status"}>
          <span className="status-led" />
          {loadError || "Loading live Session data…"}
        </div>
      ) : null}

      {activeTab === "files" ? (
        <div className="inspector-panel files-panel">
          <div className="file-workbench">
            <div className="file-tree" aria-label={ui.workspaceFiles}>
              <FileTree
                files={files}
                selectedFileId={selectedFile?.id ?? ""}
                onSelect={(file) => setSelectedFileId(file.id)}
              />
            </div>
            {selectedFile ? (
              <div className="file-preview">
                <div className="file-preview-header">
                  <span>
                    <FileIcon file={selectedFile} />
                    <strong>{selectedFile.name}</strong>
                  </span>
                  <span className="file-preview-actions">
                    <button
                      type="button"
                      aria-label={ui.shareFile(selectedFile.name)}
                      title="File sharing requires the future scoped-grant API."
                      disabled
                    >
                      <Share2 size={14} />
                    </button>
                    {/*
                     * Cross-client contract: opening a Volume file in a new tab must launch the
                     * dedicated Sandpi Cloud IDE, never expose a raw Volume or Sandbox URL.
                     * Keep this action disabled until the Cloud IDE session/route contract exists.
                     */}
                    <button
                      type="button"
                      aria-label={ui.openNewView}
                      title={ui.openNewView}
                      disabled
                    >
                      <ExternalLink size={14} />
                    </button>
                  </span>
                </div>
                <div className="file-metadata">
                  <span>{selectedFile.language}</span>
                  <span>{selectedFile.size}</span>
                  <span>{selectedFile.modifiedAt}</span>
                </div>
                <pre className="code-preview">
                  <code>
                    {(fileContents[selectedFile.path]?.kind === "binary"
                      ? ui.binaryFilePreview
                      : fileContents[selectedFile.path]?.text ??
                        selectedFile.content ??
                        "")
                      .split("\n")
                      .map((line, index) => (
                        <span className="code-line" key={`${line}-${index}`}>
                          <b>{index + 1}</b>
                          <i>{line || " "}</i>
                        </span>
                      ))}
                  </code>
                </pre>
              </div>
            ) : null}
          </div>
          <div className="inspector-status-bar">
            <span className="status-led" />
            {ui.volumeLive(session.workspaceVolumeId)}
          </div>
        </div>
      ) : null}

      {activeTab === "audit" ? (
        <SessionAuditPanel
          audit={audit}
          language={language}
          sessionId={session.id}
          timeZone={timeZone}
        />
      ) : null}

      {activeTab === "metrics" ? (
        <div className="inspector-panel metrics-panel">
          <div className="panel-intro">
            <div>
              <span className="panel-eyebrow">{ui.lastHour}</span>
              <h2>{ui.runtimeMetrics}</h2>
            </div>
            <button type="button" className="filter-button">
              {ui.oneHour} <ChevronDown size={13} />
            </button>
          </div>
          <section className="metric-card">
            <header>
              <span>
                <Gauge size={15} /> CPU
              </span>
              <strong>{formatPercent(cpuNow, language)}</strong>
            </header>
            <InteractiveMetricChart
              series={[
                {
                  id: "cpu",
                  label: "CPU",
                  segments: metrics.cpuUtilization.segments,
                  tone: "green",
                },
              ] satisfies MetricChartSeries[]}
              max={1}
              title={`CPU · ${ui.metricChart}`}
              formatValue={(value) => formatPercent(value, language)}
              {...chartCopy}
            />
            <footer>
              <span>
                {ui.average(
                  Math.round(
                    averageMetricValue(metrics.cpuUtilization) * 100,
                  ),
                )}
              </span>
              <span>
                {ui.peak(
                  Math.round(
                    peakMetricValue(metrics.cpuUtilization) * 100,
                  ),
                )}
              </span>
            </footer>
          </section>
          <section className="metric-card">
            <header>
              <span>
                <Activity size={15} /> {ui.memory}
              </span>
              <strong>{formatMemory(memoryNow, language)}</strong>
            </header>
            <InteractiveMetricChart
              series={[
                {
                  id: "memory",
                  label: ui.memory,
                  segments: metrics.memoryWorkingSet.segments,
                  tone: "green",
                },
              ] satisfies MetricChartSeries[]}
              max={metrics.memoryLimitBytes}
              title={`${ui.memory} · ${ui.metricChart}`}
              formatValue={(value) => formatMemory(value, language)}
              {...chartCopy}
            />
            <footer>
              <span>
                {ui.percentOfLimit(
                  Math.round(
                    (memoryNow / metrics.memoryLimitBytes) * 100,
                  ),
                )}
              </span>
              <span>
                {ui.memoryLimit(
                  metrics.memoryLimitBytes / 1024 / 1024 / 1024,
                )}
              </span>
            </footer>
          </section>
          <section className="metric-card">
            <header>
              <span>
                <Network size={15} /> {ui.networkTraffic}
              </span>
              <strong>
                {formatBytesPerSecond(
                  networkReceiveNow + networkTransmitNow,
                  language,
                )}
              </strong>
            </header>
            <InteractiveMetricChart
              series={[
                {
                  id: "network-receive",
                  label: ui.received,
                  segments: metrics.networkReceive.segments,
                  tone: "blue",
                },
                {
                  id: "network-transmit",
                  label: ui.sent,
                  segments: metrics.networkTransmit.segments,
                  tone: "amber",
                },
              ] satisfies MetricChartSeries[]}
              title={`${ui.networkTraffic} · ${ui.metricChart}`}
              formatValue={(value) => formatBytesPerSecond(value, language)}
              {...chartCopy}
            />
            <footer className="metric-network-summary">
              <span>
                <ArrowDownToLine size={11} /> {ui.received}{" "}
                {formatBytesPerSecond(networkReceiveNow, language)}
              </span>
              <span>
                <ArrowUpFromLine size={11} /> {ui.sent}{" "}
                {formatBytesPerSecond(networkTransmitNow, language)}
              </span>
            </footer>
          </section>
          <section className="runtime-facts">
            <div>
              <span>{ui.sandbox}</span>
              <code>{session.sandboxId}</code>
            </div>
            <div>
              <span>{ui.supervisorSession}</span>
              <code>{session.supervisorSessionId}</code>
            </div>
          </section>
          <p className="data-boundary-note">{ui.metricsBoundary}</p>
        </div>
      ) : null}

    </aside>
  );
}
