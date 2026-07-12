"use client";

import {
  Activity,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  formatAuditTime,
  getOperationUiCopy,
  type OperationLanguage,
} from "@/lib/operation-ui";
import type {
  AuditEvent,
  CodingSession,
  MetricPoint,
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

function Sparkline({
  points,
  max,
  title,
}: {
  points: MetricPoint[];
  max?: number;
  title: string;
}) {
  const width = 286;
  const height = 76;
  const values = points.map((point) => point.value);
  const upper = max ?? Math.max(...values, 1);
  const path = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const y = height - (point.value / upper) * (height - 10) - 5;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = `${path} L${width},${height} L0,${height} Z`;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img">
      <title>{title}</title>
      <path
        className="sparkline-grid"
        d={`M0,20 H${width} M0,40 H${width} M0,60 H${width}`}
      />
      <path className="sparkline-area" d={area} />
      <path className="sparkline-line" d={path} />
    </svg>
  );
}

function AuditRow({
  event,
  language,
  timeZone,
}: {
  event: AuditEvent;
  language: OperationLanguage;
  timeZone: string;
}) {
  return (
    <div className="audit-row">
      <span className={`audit-marker outcome-${event.outcome}`} />
      <div className="audit-copy">
        <div>
          <strong>{event.action}</strong>
          <span className={`source-tag source-${event.source}`}>
            {event.source}
          </span>
        </div>
        <p>{event.detail}</p>
        <time dateTime={event.timestamp}>
          {formatAuditTime(event.timestamp, language, timeZone)}
        </time>
      </div>
    </div>
  );
}

function ShareDialog({
  file,
  language,
  onClose,
}: {
  file: WorkspaceFile;
  language: OperationLanguage;
  onClose: () => void;
}) {
  const ui = getOperationUiCopy(language).inspector;
  const [permission, setPermission] = useState("viewer");
  const [expiry, setExpiry] = useState("7-days");
  const [copied, setCopied] = useState(false);
  const link = `https://sandpi.dev/share/mock-${file.id}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // The preview may run without clipboard permission.
    }
    setCopied(true);
  }

  return (
    <div
      className="modal-layer modal-layer-local"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="dialog-kicker">{ui.volumeFile}</span>
            <h2 id="share-dialog-title">{ui.share(file.name)}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={ui.closeDialog}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p className="share-path">{file.path}</p>
        <div className="share-form-grid">
          <label>
            {ui.permission}
            <select
              name="share-permission"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
            >
              <option value="viewer">{ui.canView}</option>
              <option value="download">{ui.canDownload}</option>
            </select>
          </label>
          <label>
            {ui.linkExpires}
            <select
              name="share-expiry"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              <option value="24-hours">{ui.hours24}</option>
              <option value="7-days">{ui.days7}</option>
              <option value="30-days">{ui.days30}</option>
            </select>
          </label>
        </div>
        <label className="share-link-label">
          {ui.privateLink}
          <span className="share-link-row">
            <input name="share-link" readOnly value={link} />
            <button type="button" onClick={copyLink}>
              {copied ? <CheckIcon /> : <Copy size={15} />}
              {copied ? ui.copied : ui.copy}
            </button>
          </span>
        </label>
        <p className="share-security-note">{ui.shareBoundary}</p>
      </section>
    </div>
  );
}

function CheckIcon() {
  return <span className="mini-check">✓</span>;
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
  const allFiles = useMemo(() => flattenFiles(session.files), [session.files]);
  const initialFile =
    allFiles.find((file) => file.id === "auth-callback") ??
    allFiles.find((file) => file.kind === "file") ??
    allFiles[0];
  const [selectedFileId, setSelectedFileId] = useState(initialFile?.id ?? "");
  const [shareOpen, setShareOpen] = useState(false);
  const selectedFile =
    allFiles.find((file) => file.id === selectedFileId) ?? initialFile;

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

      {activeTab === "files" ? (
        <div className="inspector-panel files-panel">
          <div className="file-workbench">
            <div className="file-tree" aria-label={ui.workspaceFiles}>
              <FileTree
                files={session.files}
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
                      onClick={() => setShareOpen(true)}
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
                    {(selectedFile.content ?? "")
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
        <div className="inspector-panel audit-panel">
          <div className="panel-intro">
            <div>
              <span className="panel-eyebrow">{ui.sandboxActivity}</span>
              <h2>{ui.auditEvents}</h2>
            </div>
            <button type="button" className="filter-button">
              {ui.allSources} <ChevronDown size={13} />
            </button>
          </div>
          <div className="audit-summary">
            <div>
              <strong>{session.auditEvents.length}</strong>
              <span>{ui.recentEvents}</span>
            </div>
            <div>
              <strong>
                {
                  session.auditEvents.filter(
                    (event) => event.outcome === "blocked",
                  ).length
                }
              </strong>
              <span>{ui.blocked}</span>
            </div>
            <div>
              <strong>2</strong>
              <span>{ui.sources}</span>
            </div>
          </div>
          <div className="audit-list">
            {session.auditEvents.map((event) => (
              <AuditRow
                event={event}
                key={event.id}
                language={language}
                timeZone={timeZone}
              />
            ))}
          </div>
          <p className="data-boundary-note">{ui.auditBoundary}</p>
        </div>
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
              <strong>{session.metrics.currentCpuPercent}%</strong>
            </header>
            <Sparkline
              points={session.metrics.cpuPercent}
              max={100}
              title={ui.metricChart}
            />
            <footer>
              <span>{ui.average(18)}</span>
              <span>{ui.peak(38)}</span>
            </footer>
          </section>
          <section className="metric-card">
            <header>
              <span>
                <Activity size={15} /> {ui.memory}
              </span>
              <strong>{session.metrics.currentMemoryMiB} MiB</strong>
            </header>
            <Sparkline
              points={session.metrics.memoryMiB}
              max={session.metrics.memoryLimitMiB}
              title={ui.metricChart}
            />
            <footer>
              <span>
                {ui.percentOfLimit(
                  Math.round(
                    (session.metrics.currentMemoryMiB /
                      session.metrics.memoryLimitMiB) *
                      100,
                  ),
                )}
              </span>
              <span>
                {ui.memoryLimit(session.metrics.memoryLimitMiB / 1024)}
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
            <div>
              <span>{ui.runtimeGeneration}</span>
              <strong>3</strong>
            </div>
          </section>
          <p className="data-boundary-note">{ui.metricsBoundary}</p>
        </div>
      ) : null}

      {shareOpen && selectedFile ? (
        <ShareDialog
          file={selectedFile}
          language={language}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </aside>
  );
}
