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

import type { AuditEvent, CodingSession, MetricPoint, WorkspaceFile } from "@/lib/types";

export type InspectorTab = "files" | "audit" | "metrics";

interface InspectorProps {
  session: CodingSession;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
}

function flattenFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return files.flatMap((file) => [file, ...(file.children ? flattenFiles(file.children) : [])]);
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
                  setCollapsed((current) => ({ ...current, [file.id]: !isCollapsed }));
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

function Sparkline({ points, max }: { points: MetricPoint[]; max?: number }) {
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
      <title>Metric values over the last hour</title>
      <path className="sparkline-grid" d={`M0,20 H${width} M0,40 H${width} M0,60 H${width}`} />
      <path className="sparkline-area" d={area} />
      <path className="sparkline-line" d={path} />
    </svg>
  );
}

function formatAuditTime(timestamp: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function AuditRow({ event }: { event: AuditEvent }) {
  return (
    <div className="audit-row">
      <span className={`audit-marker outcome-${event.outcome}`} />
      <div className="audit-copy">
        <div>
          <strong>{event.action}</strong>
          <span className={`source-tag source-${event.source}`}>{event.source}</span>
        </div>
        <p>{event.detail}</p>
        <time dateTime={event.timestamp}>{formatAuditTime(event.timestamp)}</time>
      </div>
    </div>
  );
}

function ShareDialog({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
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
    <div className="modal-layer modal-layer-local" role="presentation" onMouseDown={onClose}>
      <section
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="dialog-kicker">Volume file</span>
            <h2 id="share-dialog-title">Share {file.name}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p className="share-path">{file.path}</p>
        <div className="share-form-grid">
          <label>
            Permission
            <select
              name="share-permission"
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
            >
              <option value="viewer">Can view</option>
              <option value="download">Can view & download</option>
            </select>
          </label>
          <label>
            Link expires
            <select
              name="share-expiry"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              <option value="24-hours">24 hours</option>
              <option value="7-days">7 days</option>
              <option value="30-days">30 days</option>
            </select>
          </label>
        </div>
        <label className="share-link-label">
          Private link
          <span className="share-link-row">
            <input name="share-link" readOnly value={link} />
            <button type="button" onClick={copyLink}>
              {copied ? <CheckIcon /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </label>
        <p className="share-security-note">
          The control plane validates this grant before proxying read-only Volume access. The
          sandbox is never exposed directly.
        </p>
      </section>
    </div>
  );
}

function CheckIcon() {
  return <span className="mini-check">✓</span>;
}

export function Inspector({ session, activeTab, onTabChange, onClose }: InspectorProps) {
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
    <aside className="inspector" aria-label="Session inspector">
      <header className="inspector-header">
        <nav aria-label="Inspector views">
          <button
            type="button"
            className={activeTab === "files" ? "is-active" : ""}
            onClick={() => onTabChange("files")}
          >
            <FileCode2 size={14} /> Files
          </button>
          <button
            type="button"
            className={activeTab === "audit" ? "is-active" : ""}
            onClick={() => onTabChange("audit")}
          >
            <ShieldCheck size={14} /> Audit
          </button>
          <button
            type="button"
            className={activeTab === "metrics" ? "is-active" : ""}
            onClick={() => onTabChange("metrics")}
          >
            <Activity size={14} /> Metrics
          </button>
        </nav>
        <button type="button" className="icon-button" aria-label="Close inspector" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      {activeTab === "files" ? (
        <div className="inspector-panel files-panel">
          <div className="file-workbench">
            <div className="file-tree" aria-label="Workspace files">
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
                      aria-label={`Share ${selectedFile.name}`}
                      onClick={() => setShareOpen(true)}
                    >
                      <Share2 size={14} />
                    </button>
                    <button type="button" aria-label="Open in new view">
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
                    {(selectedFile.content ?? "").split("\n").map((line, index) => (
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
            Volume live · {session.workspaceVolumeId}
          </div>
        </div>
      ) : null}

      {activeTab === "audit" ? (
        <div className="inspector-panel audit-panel">
          <div className="panel-intro">
            <div>
              <span className="panel-eyebrow">Sandbox activity</span>
              <h2>Audit events</h2>
            </div>
            <button type="button" className="filter-button">
              All sources <ChevronDown size={13} />
            </button>
          </div>
          <div className="audit-summary">
            <div>
              <strong>{session.auditEvents.length}</strong>
              <span>Recent events</span>
            </div>
            <div>
              <strong>
                {session.auditEvents.filter((event) => event.outcome === "blocked").length}
              </strong>
              <span>Blocked</span>
            </div>
            <div>
              <strong>2</strong>
              <span>Sources</span>
            </div>
          </div>
          <div className="audit-list">
            {session.auditEvents.map((event) => (
              <AuditRow event={event} key={event.id} />
            ))}
          </div>
          <p className="data-boundary-note">
            Sandbox0 supplies lifecycle and network audit events. Supervisor session events are
            shown as a separate source; file audit is not inferred from Volume access.
          </p>
        </div>
      ) : null}

      {activeTab === "metrics" ? (
        <div className="inspector-panel metrics-panel">
          <div className="panel-intro">
            <div>
              <span className="panel-eyebrow">Last hour</span>
              <h2>Runtime metrics</h2>
            </div>
            <button type="button" className="filter-button">
              1 hour <ChevronDown size={13} />
            </button>
          </div>
          <section className="metric-card">
            <header>
              <span>
                <Gauge size={15} /> CPU
              </span>
              <strong>{session.metrics.currentCpuPercent}%</strong>
            </header>
            <Sparkline points={session.metrics.cpuPercent} max={100} />
            <footer>
              <span>avg 18%</span>
              <span>peak 38%</span>
            </footer>
          </section>
          <section className="metric-card">
            <header>
              <span>
                <Activity size={15} /> Memory
              </span>
              <strong>{session.metrics.currentMemoryMiB} MiB</strong>
            </header>
            <Sparkline
              points={session.metrics.memoryMiB}
              max={session.metrics.memoryLimitMiB}
            />
            <footer>
              <span>{Math.round((session.metrics.currentMemoryMiB / session.metrics.memoryLimitMiB) * 100)}% of limit</span>
              <span>{session.metrics.memoryLimitMiB / 1024} GiB limit</span>
            </footer>
          </section>
          <section className="runtime-facts">
            <div>
              <span>Sandbox</span>
              <code>{session.sandboxId}</code>
            </div>
            <div>
              <span>Supervisor session</span>
              <code>{session.supervisorSessionId}</code>
            </div>
            <div>
              <span>Runtime generation</span>
              <strong>3</strong>
            </div>
          </section>
          <p className="data-boundary-note">
            Chart-ready runtime series from Sandbox0 observability. Billing and metering remain a
            separate usage-truth path.
          </p>
        </div>
      ) : null}

      {shareOpen && selectedFile ? (
        <ShareDialog file={selectedFile} onClose={() => setShareOpen(false)} />
      ) : null}
    </aside>
  );
}
