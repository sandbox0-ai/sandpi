"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  FileCode2,
  Gauge,
  Network,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  InteractiveMetricChart,
  type MetricChartSeries,
} from "@/components/metric-chart";
import { SessionAuditPanel } from "@/components/session-audit-panel";
import { WorkspaceIde } from "@/components/workspace-ide";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import {
  DEFAULT_SESSION_METRIC_RANGE_SECONDS,
  isSessionMetricRangeSeconds,
  type SessionMetricRangeSeconds,
} from "@/lib/session-metrics";
import { formatUnixTimestamp } from "@/lib/time";
import type {
  CodingSession,
  RuntimeMetricSeries,
  SessionAuditFeed,
  SessionMetrics,
  WorkspaceIdeSnapshot,
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

function SkeletonShape({ className = "" }: { className?: string }) {
  return <span className={`inspector-skeleton-shape ${className}`} />;
}

function InspectorSkeleton({
  activeTab,
  label,
}: {
  activeTab: InspectorTab;
  label: string;
}) {
  if (activeTab === "files") {
    return (
      <div
        className="inspector-panel files-panel inspector-skeleton inspector-skeleton-files"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">{label}</span>
        <div className="file-workbench" aria-hidden="true">
          <div className="file-tree inspector-skeleton-file-tree">
            {Array.from({ length: 9 }, (_, index) => (
              <div
                className={`file-tree-row inspector-skeleton-file-row ${
                  [1, 2, 4, 5, 6, 8].includes(index) ? "is-nested" : ""
                }`}
                key={index}
              >
                <SkeletonShape className="is-glyph" />
                <SkeletonShape />
              </div>
            ))}
          </div>
          <div className="file-preview">
            <div className="file-preview-header inspector-skeleton-file-header">
              <SkeletonShape className="is-title" />
              <span className="file-preview-actions">
                <SkeletonShape className="is-icon-button" />
                <SkeletonShape className="is-icon-button" />
              </span>
            </div>
            <div className="file-metadata inspector-skeleton-file-meta">
              <SkeletonShape />
              <SkeletonShape />
              <SkeletonShape />
            </div>
            <div className="code-preview inspector-skeleton-code">
              {Array.from({ length: 12 }, (_, index) => (
                <span className="code-line" key={index}>
                  <b>
                    <SkeletonShape />
                  </b>
                  <i>
                    <SkeletonShape />
                  </i>
                </span>
              ))}
            </div>
          </div>
        </div>
        <div
          className="inspector-status-bar inspector-skeleton-status"
          aria-hidden="true"
        >
          <SkeletonShape className="is-dot" />
          <SkeletonShape />
        </div>
      </div>
    );
  }

  if (activeTab === "audit") {
    return (
      <div
        className="inspector-panel audit-panel inspector-skeleton inspector-skeleton-audit"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">{label}</span>
        <div aria-hidden="true">
          <div className="audit-toolbar inspector-skeleton-toolbar">
            <div>
              <SkeletonShape className="is-title" />
              <SkeletonShape className="is-subtitle" />
            </div>
            <SkeletonShape className="is-filter" />
          </div>
          <div className="audit-verification inspector-skeleton-verification">
            <SkeletonShape className="is-dot" />
            <SkeletonShape />
          </div>
          <div className="audit-timeline">
            {Array.from({ length: 5 }, (_, index) => (
              <div className="inspector-skeleton-audit-row" key={index}>
                <SkeletonShape className="is-glyph" />
                <span>
                  <SkeletonShape className="is-title" />
                  <SkeletonShape className="is-subtitle" />
                </span>
                <SkeletonShape />
                <SkeletonShape />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="inspector-panel metrics-panel inspector-skeleton inspector-skeleton-metrics"
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        <div className="panel-intro inspector-skeleton-toolbar">
          <div>
            <SkeletonShape className="is-eyebrow" />
            <SkeletonShape className="is-title" />
          </div>
          <SkeletonShape className="is-filter" />
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <section
            className="metric-card inspector-skeleton-metric-card"
            key={index}
          >
            <header>
              <SkeletonShape />
              <SkeletonShape />
            </header>
            <SkeletonShape className="is-chart" />
            <footer>
              <SkeletonShape />
              <SkeletonShape />
            </footer>
          </section>
        ))}
        <div className="runtime-facts inspector-skeleton-facts">
          <div>
            <SkeletonShape />
            <SkeletonShape />
          </div>
          <div>
            <SkeletonShape />
            <SkeletonShape />
          </div>
        </div>
      </div>
    </div>
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
  at: number,
  language: OperationLanguage,
  timeZone: string,
) {
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };
  return formatUnixTimestamp(at, metricLocale(language), timeZone, options);
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
  const [metricsRangeSeconds, setMetricsRangeSeconds] =
    useState<SessionMetricRangeSeconds>(DEFAULT_SESSION_METRIC_RANGE_SECONDS);
  const metricRangeOptions = [
    {
      seconds: 15 * 60,
      label: ui.fifteenMinutes,
      windowLabel: ui.last15Minutes,
    },
    { seconds: 60 * 60, label: ui.oneHour, windowLabel: ui.lastHour },
    { seconds: 6 * 60 * 60, label: ui.sixHours, windowLabel: ui.last6Hours },
    {
      seconds: 24 * 60 * 60,
      label: ui.twentyFourHours,
      windowLabel: ui.last24Hours,
    },
    {
      seconds: 7 * 24 * 60 * 60,
      label: ui.sevenDays,
      windowLabel: ui.last7Days,
    },
  ] satisfies Array<{
    seconds: SessionMetricRangeSeconds;
    label: string;
    windowLabel: string;
  }>;
  const selectedMetricRange =
    metricRangeOptions.find(
      (option) => option.seconds === metricsRangeSeconds,
    ) ?? metricRangeOptions[1];
  const requestKey = `${session.id}:${activeTab}:${
    activeTab === "metrics" ? metricsRangeSeconds : "default"
  }`;
  const [ideSnapshot, setIdeSnapshot] = useState<WorkspaceIdeSnapshot>();
  const [audit, setAudit] = useState(session.audit);
  const [metrics, setMetrics] = useState(session.metrics);
  const [resolvedRequestKey, setResolvedRequestKey] = useState("");
  const [loadError, setLoadError] = useState<{
    requestKey: string;
    message: string;
  } | null>(null);
  const currentLoadError =
    loadError?.requestKey === requestKey ? loadError.message : "";
  const loading = resolvedRequestKey !== requestKey && !currentLoadError;
  const cpuNow = lastMetricValue(metrics.cpuUtilization);
  const memoryNow = lastMetricValue(metrics.memoryWorkingSet);
  const networkReceiveNow = lastMetricValue(metrics.networkReceive);
  const networkTransmitNow = lastMetricValue(metrics.networkTransmit);
  const chartCopy = {
    instructions: ui.metricChartInstructions,
    legendLabel: ui.metricSeries,
    toggleSeriesLabel: (label: string, visible: boolean) =>
      visible ? ui.hideMetricSeries(label) : ui.showMetricSeries(label),
    formatTime: (at: number) => formatMetricTime(at, language, timeZone),
  };

  useEffect(() => {
    setIdeSnapshot(undefined);
    setAudit(session.audit);
    setMetrics(session.metrics);
    setLoadError(null);
  }, [session.id, session.audit, session.files, session.metrics]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);

    const path = `/api/v1/sessions/${encodeURIComponent(session.id)}`;
    const request =
      activeTab === "files"
        ? apiFetch<ApiEnvelope<WorkspaceIdeSnapshot>>(
            `${path}/ide`,
            { signal: controller.signal },
          ).then((response) => setIdeSnapshot(response.data))
        : activeTab === "audit"
          ? apiFetch<ApiEnvelope<SessionAuditFeed>>(`${path}/audit`, {
              signal: controller.signal,
            }).then((response) => setAudit(response.data))
          : apiFetch<ApiEnvelope<SessionMetrics>>(
              `${path}/metrics?rangeSeconds=${metricsRangeSeconds}`,
              { signal: controller.signal },
            ).then((response) => setMetrics(response.data));

    void request
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError({
            requestKey,
            message:
              error instanceof Error
                ? error.message
                : "This Inspector view could not be loaded.",
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setResolvedRequestKey(requestKey);
        }
      });

    return () => controller.abort();
  }, [activeTab, metricsRangeSeconds, requestKey, session.id]);

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

      {currentLoadError ? (
        <div className="inspector-status-bar" role="alert">
          <span className="status-led" />
          {currentLoadError}
        </div>
      ) : null}

      {loading ? (
        <InspectorSkeleton
          activeTab={activeTab}
          label={ui.loadingView(
            { files: ui.files, audit: ui.audit, metrics: ui.metrics }[activeTab],
          )}
        />
      ) : activeTab === "files" ? (
        <div className="inspector-panel files-panel ide-panel">
          <WorkspaceIde
            language={language}
            timeZone={timeZone}
            session={session}
            variant="embedded"
            initialSnapshot={ideSnapshot}
          />
        </div>
      ) : null}

      {!loading && activeTab === "audit" ? (
        <SessionAuditPanel
          audit={audit}
          language={language}
          sessionId={session.id}
          timeZone={timeZone}
        />
      ) : null}

      {!loading && activeTab === "metrics" ? (
        <div className="inspector-panel metrics-panel">
          <div className="panel-intro">
            <div>
              <span className="panel-eyebrow">
                {selectedMetricRange.windowLabel}
              </span>
              <h2>{ui.runtimeMetrics}</h2>
            </div>
            <label className="filter-button metrics-range-filter">
              <span className="sr-only">{ui.metricsRange}</span>
              <select
                aria-label={ui.metricsRange}
                value={metricsRangeSeconds}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (isSessionMetricRangeSeconds(value)) {
                    setMetricsRangeSeconds(value);
                  }
                }}
              >
                {metricRangeOptions.map((option) => (
                  <option value={option.seconds} key={option.seconds}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} aria-hidden="true" />
            </label>
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
