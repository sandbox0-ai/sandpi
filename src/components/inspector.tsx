"use client";

import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  FileCode2,
  Gauge,
  Globe2,
  ListTree,
  Network,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  InteractiveMetricChart,
  type MetricChartSeries,
} from "@/components/metric-chart";
import {
  EnvironmentBrowser,
  type EnvironmentBrowserNavigationRequest,
} from "@/components/environment-browser";
import {
  WorkspaceIde,
  type WorkspaceFileNavigationRequest,
} from "@/components/workspace-ide";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import {
  isEnvironmentMetricRangeSeconds,
  type EnvironmentMetricRangeSeconds,
} from "@/lib/environment-metrics";
import { updateLocalUiPreferences } from "@/lib/local-ui-preferences";
import { formatUnixTimestamp } from "@/lib/time";
import { useLocalUiPreferences } from "@/lib/use-local-ui-preferences";
import {
  clampInspectorWidthRatioForAvailableWidth,
  DEFAULT_INSPECTOR_WIDTH_RATIO,
  inspectorWidthRatioFromPointer,
  MAX_STORED_INSPECTOR_WIDTH_RATIO,
  MIN_STORED_INSPECTOR_WIDTH_RATIO,
} from "@/lib/workspace-layout";
import type {
  CodingSession,
  Environment,
  EnvironmentMetrics,
  RuntimeMetricSeries,
  WorkspaceIdeSnapshot,
} from "@/lib/types";

export type InspectorTab = "files" | "browser" | "activity" | "metrics";

export interface InspectorSessionActivity {
  /** Harness-owned navigation copy; the shared Inspector never names the DTO. */
  label: string;
  /** Opaque harness renderer backed by the Conversation's native Session state. */
  content: ReactNode;
}

interface InspectorProps {
  language: OperationLanguage;
  timeZone: string;
  environment: Environment;
  session?: CodingSession;
  sessionActivity?: InspectorSessionActivity;
  workspaceNavigationRequest?: WorkspaceFileNavigationRequest;
  onWorkspaceNavigationHandled?: (
    request: WorkspaceFileNavigationRequest,
  ) => void;
  browserNavigationRequest?: EnvironmentBrowserNavigationRequest;
  onBrowserNavigationHandled?: (
    request: EnvironmentBrowserNavigationRequest,
  ) => void;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  widthRatio: number;
  onWidthRatioChange: (ratio: number, persist: boolean) => void;
  onClose: () => void;
}

function emptyMetricSeries(
  metric: RuntimeMetricSeries["metric"],
  unit: RuntimeMetricSeries["unit"],
  statistic: RuntimeMetricSeries["statistic"],
  dimensions?: Record<string, string>,
): RuntimeMetricSeries {
  return {
    metric,
    unit,
    statistic,
    stepSeconds: 0,
    dimensions,
    segments: [],
  };
}

function emptyEnvironmentMetrics(): EnvironmentMetrics {
  const endedAt = Date.now() / 1_000;
  return {
    window: {
      startedAt: endedAt - 60 * 60,
      endedAt,
    },
    pauseIntervals: [],
    cpuUtilization: emptyMetricSeries(
      "sandbox.cpu.utilization",
      "ratio",
      "average",
    ),
    memoryWorkingSet: emptyMetricSeries(
      "sandbox.memory.working_set",
      "bytes",
      "average",
    ),
    memoryLimitBytes: 0,
    networkReceive: emptyMetricSeries(
      "sandbox.network.io",
      "bytes_per_second",
      "rate",
      { direction: "receive" },
    ),
    networkTransmit: emptyMetricSeries(
      "sandbox.network.io",
      "bytes_per_second",
      "rate",
      { direction: "transmit" },
    ),
  };
}

function SkeletonShape({ className = "" }: { className?: string }) {
  return <span className={`inspector-skeleton-shape ${className}`} />;
}

function InspectorSkeleton({
  activeTab,
  label,
}: {
  activeTab: Exclude<InspectorTab, "activity">;
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
  environment,
  session,
  sessionActivity,
  workspaceNavigationRequest,
  onWorkspaceNavigationHandled,
  browserNavigationRequest,
  onBrowserNavigationHandled,
  activeTab,
  onTabChange,
  widthRatio,
  onWidthRatioChange,
  onClose,
}: InspectorProps) {
  const ui = getOperationUiCopy(language).inspector;
  const metricsRangeSeconds =
    useLocalUiPreferences().workspace.metricsRangeSeconds;
  const resizePointerRef = useRef<number | null>(null);
  const resizeRatioRef = useRef(widthRatio);
  const [resizing, setResizing] = useState(false);
  const [mountedBrowserSessionId, setMountedBrowserSessionId] =
    useState(activeTab === "browser" ? (session?.id ?? "") : "");
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
    seconds: EnvironmentMetricRangeSeconds;
    label: string;
    windowLabel: string;
  }>;
  const selectedMetricRange =
    metricRangeOptions.find(
      (option) => option.seconds === metricsRangeSeconds,
    ) ?? metricRangeOptions[1];
  const dataTab = activeTab === "files" || activeTab === "metrics";
  const requestKey = dataTab
    ? `${environment.id}:${activeTab}:${
        activeTab === "metrics" ? metricsRangeSeconds : "default"
      }`
    : "";
  const [ideSnapshot, setIdeSnapshot] = useState<WorkspaceIdeSnapshot>();
  const [metrics, setMetrics] = useState<EnvironmentMetrics>(
    emptyEnvironmentMetrics,
  );
  const [resolvedRequestKey, setResolvedRequestKey] = useState("");
  const [loadError, setLoadError] = useState<{
    requestKey: string;
    message: string;
  } | null>(null);
  const currentLoadError =
    dataTab && loadError?.requestKey === requestKey
      ? loadError.message
      : "";
  const loading =
    dataTab && resolvedRequestKey !== requestKey && !currentLoadError;
  const cpuNow = lastMetricValue(metrics.cpuUtilization);
  const memoryNow = lastMetricValue(metrics.memoryWorkingSet);
  const networkReceiveNow = lastMetricValue(metrics.networkReceive);
  const networkTransmitNow = lastMetricValue(metrics.networkTransmit);
  const chartCopy = {
    instructions: ui.metricChartInstructions,
    legendLabel: ui.metricSeries,
    pauseLabel: ui.idlePause,
    window: metrics.window,
    pauseIntervals: metrics.pauseIntervals,
    toggleSeriesLabel: (label: string, visible: boolean) =>
      visible ? ui.hideMetricSeries(label) : ui.showMetricSeries(label),
    formatTime: (at: number) => formatMetricTime(at, language, timeZone),
  };

  useEffect(() => {
    setIdeSnapshot(undefined);
    setMetrics(emptyEnvironmentMetrics());
    setLoadError(null);
  }, [environment.id]);

  useEffect(() => {
    if (
      (activeTab === "activity" && !sessionActivity) ||
      (activeTab === "browser" && !session)
    ) {
      onTabChange("files");
    }
  }, [activeTab, onTabChange, session, sessionActivity]);

  useEffect(() => {
    if (activeTab === "browser" && session) {
      setMountedBrowserSessionId(session.id);
    }
  }, [activeTab, session]);

  useEffect(() => {
    if (!dataTab) {
      setLoadError(null);
      return;
    }

    const controller = new AbortController();
    setLoadError(null);

    const path = `/api/v1/environments/${encodeURIComponent(environment.id)}`;
    const request =
      activeTab === "files"
        ? apiFetch<ApiEnvelope<WorkspaceIdeSnapshot>>(
            `${path}/ide`,
            { signal: controller.signal },
          ).then((response) => setIdeSnapshot(response.data))
        : apiFetch<ApiEnvelope<EnvironmentMetrics>>(
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
  }, [activeTab, dataTab, environment.id, metricsRangeSeconds, requestKey]);

  useEffect(() => {
    resizeRatioRef.current = widthRatio;
  }, [widthRatio]);

  useEffect(
    () => () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );

  function ratioForPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const shell = event.currentTarget.closest<HTMLElement>(".app-shell");
    if (!shell) return resizeRatioRef.current;
    const shellRect = shell.getBoundingClientRect();
    const sidebar = shell.querySelector<HTMLElement>(":scope > .sidebar");
    return inspectorWidthRatioFromPointer({
      pointerX: event.clientX,
      shellLeft: shellRect.left,
      shellWidth: shellRect.width,
      sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
    });
  }

  function updateResizeRatio(ratio: number, persist: boolean) {
    resizeRatioRef.current = ratio;
    onWidthRatioChange(ratio, persist);
  }

  function finishResize(
    event: ReactPointerEvent<HTMLDivElement>,
    ratio: number,
  ) {
    updateResizeRatio(ratio, true);
    resizePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }

  function handleResizePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function handleResizePointerMove(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (resizePointerRef.current !== event.pointerId) return;
    updateResizeRatio(ratioForPointer(event), false);
  }

  function handleResizePointerUp(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (resizePointerRef.current !== event.pointerId) return;
    finishResize(event, ratioForPointer(event));
  }

  function handleResizePointerCancel(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (resizePointerRef.current !== event.pointerId) return;
    finishResize(event, resizeRatioRef.current);
  }

  function handleResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const shell = event.currentTarget.closest<HTMLElement>(".app-shell");
    const sidebar = shell?.querySelector<HTMLElement>(":scope > .sidebar");
    const availableWidth = shell
      ? shell.getBoundingClientRect().width -
        (sidebar?.getBoundingClientRect().width ?? 0)
      : window.innerWidth;
    const delta = event.key === "ArrowLeft" ? 0.025 : -0.025;
    updateResizeRatio(
      clampInspectorWidthRatioForAvailableWidth(
        resizeRatioRef.current + delta,
        availableWidth,
      ),
      true,
    );
  }

  return (
    <aside className="inspector" aria-label={ui.label}>
      <div
        className={`inspector-resize-handle ${resizing ? "is-resizing" : ""}`}
        role="separator"
        aria-label={ui.resize}
        aria-orientation="vertical"
        aria-valuemin={MIN_STORED_INSPECTOR_WIDTH_RATIO * 100}
        aria-valuemax={MAX_STORED_INSPECTOR_WIDTH_RATIO * 100}
        aria-valuenow={Math.round(widthRatio * 100)}
        aria-valuetext={ui.resizeValue(Math.round(widthRatio * 100))}
        title={ui.resizeHelp}
        tabIndex={0}
        onDoubleClick={() =>
          updateResizeRatio(DEFAULT_INSPECTOR_WIDTH_RATIO, true)
        }
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerCancel}
      >
        <span aria-hidden="true" />
      </div>
      <header className="inspector-header">
        <nav aria-label={ui.views}>
          <button
            type="button"
            className={activeTab === "files" ? "is-active" : ""}
            onClick={() => onTabChange("files")}
          >
            <FileCode2 size={14} /> {ui.files}
          </button>
          {session ? (
            <button
              type="button"
              className={activeTab === "browser" ? "is-active" : ""}
              onClick={() => onTabChange("browser")}
            >
              <Globe2 size={14} /> {ui.browser}
            </button>
          ) : null}
          {sessionActivity ? (
            <button
              type="button"
              className={activeTab === "activity" ? "is-active" : ""}
              onClick={() => onTabChange("activity")}
            >
              <ListTree size={14} /> {sessionActivity.label}
            </button>
          ) : null}
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

      {activeTab === "activity" && sessionActivity
        ? sessionActivity.content
        : null}

      {session &&
      (activeTab === "browser" || mountedBrowserSessionId === session.id) ? (
        <div
          className="inspector-panel browser-panel"
          hidden={activeTab !== "browser"}
        >
          <EnvironmentBrowser
            key={session.id}
            environmentId={environment.id}
            sessionId={session.id}
            navigationRequest={browserNavigationRequest}
            onNavigationHandled={onBrowserNavigationHandled}
            copy={{
              title: ui.browserTitle,
              starting: ui.browserStarting,
              unavailable: ui.browserUnavailable,
              retry: ui.browserRetry,
              loading: ui.browserLoading,
              viewport: ui.browserViewport,
              viewportDesktop: ui.browserViewportDesktop,
              viewportResponsive: ui.browserViewportResponsive,
              viewportMobile: ui.browserViewportMobile,
            }}
          />
        </div>
      ) : null}

      {loading ? (
        <InspectorSkeleton
          activeTab={activeTab === "files" ? "files" : "metrics"}
          label={ui.loadingView(
            activeTab === "files" ? ui.files : ui.metrics,
          )}
        />
      ) : !currentLoadError && activeTab === "files" ? (
        <div className="inspector-panel files-panel ide-panel">
          <WorkspaceIde
            language={language}
            timeZone={timeZone}
            environment={environment}
            session={session}
            variant="embedded"
            initialSnapshot={ideSnapshot}
            navigationRequest={workspaceNavigationRequest}
            onNavigationHandled={onWorkspaceNavigationHandled}
          />
        </div>
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
                  if (isEnvironmentMetricRangeSeconds(value)) {
                    updateLocalUiPreferences((current) => ({
                      ...current,
                      workspace: {
                        ...current.workspace,
                        metricsRangeSeconds: value,
                      },
                    }));
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
                  stepSeconds: metrics.cpuUtilization.stepSeconds,
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
                  stepSeconds: metrics.memoryWorkingSet.stepSeconds,
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
                  stepSeconds: metrics.networkReceive.stepSeconds,
                  segments: metrics.networkReceive.segments,
                  tone: "blue",
                },
                {
                  id: "network-transmit",
                  label: ui.sent,
                  stepSeconds: metrics.networkTransmit.stepSeconds,
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
              <code>{environment.sandboxId}</code>
            </div>
            <div>
              <span>{ui.supervisorSession}</span>
              <code>{environment.supervisorSessionId}</code>
            </div>
          </section>
          <p className="data-boundary-note">{ui.metricsBoundary}</p>
        </div>
      ) : null}

    </aside>
  );
}
