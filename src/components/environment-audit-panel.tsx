"use client";

import {
  Activity,
  ChevronDown,
  CircleAlert,
  Copy,
  FileText,
  Globe2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { copyTextToClipboard } from "@/lib/clipboard";
import {
  auditOperationNeedsAttention,
  describeEnvironmentAuditOperation,
  groupEnvironmentAuditOperations,
  hasAuditIntegrityIssue,
  projectEnvironmentAuditActivities,
  summarizeEnvironmentAuditActivities,
  type EnvironmentAuditActivity,
  type EnvironmentAuditActivityDescriptor,
  type EnvironmentAuditOperation,
} from "@/lib/environment-audit";
import {
  formatAuditDateTime,
  formatAuditTime,
  getOperationUiCopy,
  type OperationLanguage,
} from "@/lib/operation-ui";
import { unixTimestampToIso } from "@/lib/time";
import type {
  EnvironmentAuditEvent,
  EnvironmentAuditFeed,
} from "@/lib/types";

interface EnvironmentAuditPanelProps {
  language: OperationLanguage;
  timeZone: string;
  environmentId: string;
  audit: EnvironmentAuditFeed;
  loadingNewer: boolean;
  loadNewerError: string;
  onLoadNewer: () => void;
}

type AuditPanelView =
  | "all"
  | "attention"
  | "network"
  | "changes"
  | "routine";

type AuditActivityKind =
  | "network"
  | "network-blocked"
  | "sandbox"
  | "workspace"
  | "runtime"
  | "generic";

const routineActionPattern = /(?:^|\.)(?:read|list|stat)$/;
const mutationActionPattern =
  /(?:^|\.)(?:create|delete|input|pause|resume|signal|update|write)$/;

function localCopy(language: OperationLanguage) {
  if (language === "zh-CN") {
    return {
      summary: (events: number, operations: number, issues: number) =>
        `${events} 条签名记录 · ${operations} 个操作 · ${issues} 个问题`,
      partialCoverage: (from: string, to: string) =>
        `${from}–${to} · 当前为最早的已加载范围，仍有更新记录`,
      completeCoverage: (from: string, to: string) =>
        `${from}–${to} · 已加载全部可用记录`,
      loadedVerified: (count: number) => `已加载的 ${count} 条记录均已验证`,
      loadedNeedVerification: (count: number) =>
        `已加载记录中有 ${count} 条存在证据完整性问题`,
      all: "概览",
      issues: "问题",
      network: "外部网络",
      changes: "变更与生命周期",
      routine: "常规读取",
      filter: "筛选已加载的 Environment 审计",
      connectedTo: (endpoint: string) => `已连接 ${endpoint}`,
      blockedConnection: (endpoint: string) => `已阻止连接 ${endpoint}`,
      failedConnection: (endpoint: string) => `连接 ${endpoint} 失败`,
      connectionAttempt: (endpoint: string) => `尝试连接 ${endpoint}`,
      requests: (count: number) => `${count} 次请求`,
      connections: (count: number) => `${count} 次连接`,
      signedRecords: (count: number) => `${count} 条签名记录`,
      evidenceIssue: "证据问题",
      blocked: "策略已阻止",
      failed: "失败",
      unknown: "结果未知",
      accepted: "已受理",
      allowed: "已允许",
      notFound: "未找到 (404)",
      actor: "发起方",
      resource: "资源",
      request: "请求",
      networkFacts: "网络事实",
      evidence: "签名证据",
      operationEvidence: (count: number) => `${count} 个规范操作`,
      technicalDetails: "签名事件 JSON",
      rawJsonLabel: "签名 Environment 审计事件 JSON",
      copyEvent: "复制事件 JSON",
      copied: "已复制",
      copyFailed: "复制失败，请手动选择 JSON。",
      loadNewer: "加载更新的签名记录",
      loadingNewer: "正在加载更新记录…",
      noEvents: "暂无签名审计事件",
      noMatches: "当前筛选条件下没有活动",
      asynchronous:
        "Sandbox 活动发生后，规范签名事件可能需要短暂时间才会出现。",
      source: (source: string) => `由 ${source} 记录`,
    };
  }

  return {
    summary: (events: number, operations: number, issues: number) =>
      `${events} signed records · ${operations} operations · ${issues} ${
        issues === 1 ? "issue" : "issues"
      }`,
    partialCoverage: (from: string, to: string) =>
      `${from}–${to} · Earliest loaded range; newer records are available`,
    completeCoverage: (from: string, to: string) =>
      `${from}–${to} · All available records loaded`,
    loadedVerified: (count: number) =>
      `All ${count} loaded records are verified`,
    loadedNeedVerification: (count: number) =>
      `${count} loaded ${count === 1 ? "record has" : "records have"} evidence integrity issues`,
    all: "Overview",
    issues: "Issues",
    network: "External network",
    changes: "Changes & lifecycle",
    routine: "Routine reads",
    filter: "Filter loaded Environment audit",
    connectedTo: (endpoint: string) => `Connected to ${endpoint}`,
    blockedConnection: (endpoint: string) =>
      `Blocked connection to ${endpoint}`,
    failedConnection: (endpoint: string) =>
      `Connection to ${endpoint} failed`,
    connectionAttempt: (endpoint: string) =>
      `Connection attempt to ${endpoint}`,
    requests: (count: number) => `${count} ${count === 1 ? "request" : "requests"}`,
    connections: (count: number) =>
      `${count} ${count === 1 ? "connection" : "connections"}`,
    signedRecords: (count: number) =>
      `${count} signed ${count === 1 ? "record" : "records"}`,
    evidenceIssue: "Evidence issue",
    blocked: "Blocked by policy",
    failed: "Failed",
    unknown: "Unknown result",
    accepted: "Accepted",
    allowed: "Allowed",
    notFound: "Not found (404)",
    actor: "Actor",
    resource: "Resource",
    request: "Request",
    networkFacts: "Network facts",
    evidence: "Signed evidence",
    operationEvidence: (count: number) =>
      `${count} canonical ${count === 1 ? "operation" : "operations"}`,
    technicalDetails: "Signed event JSON",
    rawJsonLabel: "Signed Environment audit event JSON",
    copyEvent: "Copy event JSON",
    copied: "Copied",
    copyFailed: "Copy failed. Select the JSON manually.",
    loadNewer: "Load newer signed records",
    loadingNewer: "Loading newer records…",
    noEvents: "No signed audit events yet",
    noMatches: "No activity matches this filter",
    asynchronous:
      "Canonical signed events can appear shortly after the observed Sandbox activity.",
    source: (source: string) => `Recorded by ${source}`,
  };
}

function humanizeToken(value: string) {
  const words = value.replaceAll(/[._-]+/g, " ").trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : value;
}

function actionLabel(action: string, language: OperationLanguage) {
  const labels: Record<string, [string, string]> = {
    "audit.read": ["Read Environment audit", "读取 Environment 审计"],
    "directory.create": ["Created Workspace directory", "创建 Workspace 目录"],
    "directory.list": ["Listed Workspace directory", "列出 Workspace 目录"],
    "file.delete": ["Deleted Workspace file via API", "通过 API 删除 Workspace 文件"],
    "file.read": ["Read Workspace file via API", "通过 API 读取 Workspace 文件"],
    "file.write": ["Wrote Workspace file via API", "通过 API 写入 Workspace 文件"],
    "logs.read": ["Read runtime logs", "读取运行时日志"],
    "metrics.catalog.read": ["Read metrics catalog", "读取指标目录"],
    "metrics.read": ["Read runtime metrics", "读取运行时指标"],
    "process.create": ["Created runtime process", "创建运行时进程"],
    "process.list": ["Listed runtime processes", "列出运行时进程"],
    "process.read": ["Read runtime process", "读取运行时进程"],
    "sandbox.create": ["Created Sandbox", "创建 Sandbox"],
    "sandbox.delete": ["Deleted Sandbox", "删除 Sandbox"],
    "sandbox.pause": ["Paused Sandbox", "暂停 Sandbox"],
    "sandbox.read": ["Read Sandbox state", "读取 Sandbox 状态"],
    "sandbox.resume": ["Resumed Sandbox", "恢复 Sandbox"],
    "session.create": ["Created Supervisor Session", "创建 Supervisor Session"],
    "session.events.read": [
      "Read Supervisor Session events",
      "读取 Supervisor Session 事件",
    ],
    "session.events.stream": [
      "Streamed Supervisor Session events",
      "流式读取 Supervisor Session 事件",
    ],
    "session.input": ["Sent Supervisor Session input", "发送 Supervisor Session 输入"],
    "session.list": ["Listed Supervisor Sessions", "列出 Supervisor Sessions"],
    "session.read": ["Read Supervisor Session", "读取 Supervisor Session"],
  };
  const label = labels[action];
  if (label) return language === "zh-CN" ? label[1] : label[0];
  return language === "zh-CN" ? action : humanizeToken(action);
}

function actorLabel(
  actorKind: EnvironmentAuditEvent["actor"]["kind"],
  language: OperationLanguage,
) {
  const labels: Partial<
    Record<EnvironmentAuditEvent["actor"]["kind"], [string, string]>
  > = {
    api_key: ["API key", "API Key"],
    sandbox_workload: ["Sandbox workload", "Sandbox workload"],
    service: ["Sandbox0 service", "Sandbox0 服务"],
    human: ["User", "用户"],
    ssh_user: ["SSH user", "SSH 用户"],
  };
  const label = labels[actorKind];
  if (label) return language === "zh-CN" ? label[1] : label[0];
  return humanizeToken(actorKind);
}

function formatBytes(value: number, language: OperationLanguage) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = Math.max(0, value);
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    maximumFractionDigits: amount < 10 && unitIndex > 0 ? 1 : 0,
  }).format(amount)} ${units[unitIndex]}`;
}

function isRoutineActivity(activity: EnvironmentAuditActivity) {
  return (
    !activity.needsAttention &&
    (activity.outcome === "completed" || activity.outcome === "succeeded") &&
    (activity.burstKind === "routine-read" ||
      (activity.descriptor.category === "observability" &&
        routineActionPattern.test(activity.descriptor.action)))
  );
}

function isChangeActivity(activity: EnvironmentAuditActivity) {
  return (
    activity.descriptor.category !== "network" &&
    !isRoutineActivity(activity) &&
    mutationActionPattern.test(activity.descriptor.action)
  );
}

function activityPriority(activity: EnvironmentAuditActivity) {
  if (activity.integrityIssueCount > 0) return 0;
  if (activity.needsAttention) return 1;
  if (activity.descriptor.category === "network") return 2;
  if (isChangeActivity(activity)) return 3;
  if (isRoutineActivity(activity)) return 5;
  return 4;
}

function filterActivities(
  activities: EnvironmentAuditActivity[],
  view: AuditPanelView,
) {
  if (view === "all") return activities;
  if (view === "attention") {
    return activities.filter((activity) => activity.needsAttention);
  }
  if (view === "network") {
    return activities.filter(
      (activity) => activity.descriptor.category === "network",
    );
  }
  if (view === "changes") {
    return activities.filter(isChangeActivity);
  }
  return activities.filter(isRoutineActivity);
}

function activityKind(activity: EnvironmentAuditActivity): AuditActivityKind {
  if (activity.descriptor.category === "network") {
    return activity.outcome === "denied" ? "network-blocked" : "network";
  }
  if (activity.descriptor.category === "sandbox") return "sandbox";
  if (activity.descriptor.category === "workspace") return "workspace";
  if (activity.descriptor.category === "runtime") return "runtime";
  return "generic";
}

function ActivityGlyph({ kind }: { kind: AuditActivityKind }) {
  if (kind === "network" || kind === "network-blocked") {
    return <Globe2 size={14} aria-hidden="true" />;
  }
  if (kind === "sandbox") {
    return <RotateCcw size={14} aria-hidden="true" />;
  }
  if (kind === "workspace") {
    return <FileText size={14} aria-hidden="true" />;
  }
  return <Activity size={14} aria-hidden="true" />;
}

function activityTitle(
  descriptor: EnvironmentAuditActivityDescriptor,
  outcome: EnvironmentAuditEvent["outcome"],
  language: OperationLanguage,
) {
  const copy = localCopy(language);
  if (descriptor.category === "network") {
    const endpoint = descriptor.endpoint ?? descriptor.resourceId;
    if (outcome === "denied") return copy.blockedConnection(endpoint);
    if (outcome === "failed" || outcome === "error" || outcome === "unknown") {
      return copy.failedConnection(endpoint);
    }
    if (outcome === "accepted") return copy.connectionAttempt(endpoint);
    return copy.connectedTo(endpoint);
  }
  return actionLabel(descriptor.action, language);
}

function activityStatus(
  activity: EnvironmentAuditActivity,
  language: OperationLanguage,
) {
  const copy = localCopy(language);
  if (activity.integrityIssueCount > 0) {
    return { label: copy.evidenceIssue, kind: "integrity" };
  }
  if (activity.outcome === "denied") {
    return { label: copy.blocked, kind: "blocked" };
  }
  if (activity.outcome === "failed" || activity.outcome === "error") {
    return {
      label:
        activity.descriptor.statusCode === 404
          ? copy.notFound
          : activity.descriptor.statusCode
            ? `HTTP ${activity.descriptor.statusCode}`
            : copy.failed,
      kind: "failed",
    };
  }
  if (activity.outcome === "unknown") {
    return { label: copy.unknown, kind: "failed" };
  }
  if (activity.outcome === "accepted") {
    return { label: copy.accepted, kind: "pending" };
  }
  if (activity.descriptor.category === "network") {
    return { label: copy.allowed, kind: "allowed" };
  }
  return undefined;
}

function activityMeta(
  activity: EnvironmentAuditActivity,
  language: OperationLanguage,
) {
  const copy = localCopy(language);
  const pieces = [
    activity.descriptor.category === "network"
      ? copy.connections(activity.operationCount)
      : copy.requests(activity.operationCount),
    actorLabel(activity.descriptor.actorKind, language),
  ];
  if (activity.networkTotals?.ingressBytes !== undefined) {
    pieces.push(
      language === "zh-CN"
        ? `接收 ${formatBytes(activity.networkTotals.ingressBytes, language)}`
        : `${formatBytes(activity.networkTotals.ingressBytes, language)} in`,
    );
  }
  if (activity.networkTotals?.egressBytes !== undefined) {
    pieces.push(
      language === "zh-CN"
        ? `发送 ${formatBytes(activity.networkTotals.egressBytes, language)}`
        : `${formatBytes(activity.networkTotals.egressBytes, language)} out`,
    );
  }
  return pieces.join(" · ");
}

function AuditTechnicalDetails({
  event,
  language,
}: {
  event: EnvironmentAuditEvent;
  language: OperationLanguage;
}) {
  const ui = getOperationUiCopy(language).inspector;
  const copy = localCopy(language);
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const signatureLabel = {
    verified: ui.signatureVerified,
    invalid: ui.signatureInvalid,
    unavailable: ui.signatureUnavailable,
  }[event.integrity.signatureStatus];

  async function copyEvent() {
    try {
      await copyTextToClipboard(JSON.stringify(event, null, 2));
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }

  return (
    <details
      className="audit-technical-details"
      onToggle={(toggleEvent) => {
        if (toggleEvent.currentTarget.open) setMounted(true);
      }}
    >
      <summary>
        <span>{copy.technicalDetails}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      {mounted ? (
        <div className="audit-technical-content">
          <div className="audit-technical-toolbar">
            <span
              className={
                hasAuditIntegrityIssue(event)
                  ? "audit-signature is-warning"
                  : "audit-signature"
              }
            >
              {hasAuditIntegrityIssue(event) ? (
                <CircleAlert size={12} aria-hidden="true" />
              ) : (
                <ShieldCheck size={12} aria-hidden="true" />
              )}
              {signatureLabel}
              {event.integrity.eventIdConflict
                ? ` · ${ui.eventIdConflict}`
                : ""}
            </span>
            <button
              type="button"
              onClick={() => void copyEvent()}
              aria-live="polite"
            >
              <Copy size={12} aria-hidden="true" />
              {copyError ? copy.copyFailed : copied ? copy.copied : copy.copyEvent}
            </button>
          </div>
          <pre tabIndex={0} aria-label={copy.rawJsonLabel}>
            {JSON.stringify(event, null, 2)}
          </pre>
        </div>
      ) : null}
    </details>
  );
}

function AuditEventStep({
  event,
  language,
  timeZone,
}: {
  event: EnvironmentAuditEvent;
  language: OperationLanguage;
  timeZone: string;
}) {
  const ui = getOperationUiCopy(language).inspector;
  const copy = localCopy(language);
  return (
    <li className={`audit-event-step outcome-${event.outcome}`}>
      <span className="audit-event-step-dot" aria-hidden="true" />
      <div className="audit-event-step-row">
        <div>
          <strong>{ui.phaseLabel(event.phase)}</strong>
          <span>{copy.source(event.source)}</span>
        </div>
        <span
          className={
            hasAuditIntegrityIssue(event)
              ? "audit-event-integrity is-warning"
              : "audit-event-integrity"
          }
        >
          {event.integrity.signatureStatus === "verified"
            ? ui.signatureVerified
            : event.integrity.signatureStatus === "invalid"
              ? ui.signatureInvalid
              : ui.signatureUnavailable}
        </span>
        <span className="audit-event-step-status">
          {ui.outcomeLabel(event.outcome)}
        </span>
        <time
          dateTime={unixTimestampToIso(event.occurredAt)}
          title={formatAuditDateTime(event.occurredAt, language, timeZone)}
        >
          {formatAuditTime(event.occurredAt, language, timeZone)}
        </time>
      </div>
      <AuditTechnicalDetails event={event} language={language} />
    </li>
  );
}

function AuditEventTrail({
  events,
  language,
  timeZone,
}: {
  events: EnvironmentAuditEvent[];
  language: OperationLanguage;
  timeZone: string;
}) {
  return (
    <ol className="audit-event-trail">
      {events.map((event) => (
        <AuditEventStep
          event={event}
          key={`${event.eventId}-${event.integrity.payloadHash}`}
          language={language}
          timeZone={timeZone}
        />
      ))}
    </ol>
  );
}

function operationStatusLabel(
  operation: EnvironmentAuditOperation,
  language: OperationLanguage,
) {
  const ui = getOperationUiCopy(language).inspector;
  const descriptor = describeEnvironmentAuditOperation(operation);
  if (operation.integrityIssueCount > 0) return localCopy(language).evidenceIssue;
  if (
    (operation.outcome === "failed" || operation.outcome === "error") &&
    descriptor.statusCode
  ) {
    return `HTTP ${descriptor.statusCode}`;
  }
  return ui.outcomeLabel(operation.outcome);
}

function AuditOperationEvidence({
  operation,
  language,
  timeZone,
}: {
  operation: EnvironmentAuditOperation;
  language: OperationLanguage;
  timeZone: string;
}) {
  const copy = localCopy(language);
  const [mounted, setMounted] = useState(false);
  const descriptor = describeEnvironmentAuditOperation(operation);
  return (
    <li className="audit-operation-evidence">
      <details
        onToggle={(toggleEvent) => {
          if (toggleEvent.currentTarget.open) setMounted(true);
        }}
      >
        <summary>
          <span>
            <strong>
              {activityTitle(descriptor, operation.outcome, language)}
            </strong>
            <small>{copy.signedRecords(operation.events.length)}</small>
          </span>
          <span
            className={
              auditOperationNeedsAttention(operation)
                ? "audit-operation-status needs-attention"
                : "audit-operation-status"
            }
          >
            {operationStatusLabel(operation, language)}
          </span>
          <time
            dateTime={unixTimestampToIso(operation.lastOccurredAt)}
            title={formatAuditDateTime(
              operation.lastOccurredAt,
              language,
              timeZone,
            )}
          >
            {formatAuditTime(operation.lastOccurredAt, language, timeZone)}
          </time>
          <ChevronDown size={12} aria-hidden="true" />
        </summary>
        {mounted ? (
          <AuditEventTrail
            events={operation.events}
            language={language}
            timeZone={timeZone}
          />
        ) : null}
      </details>
    </li>
  );
}

function AuditActivityFacts({
  activity,
  language,
}: {
  activity: EnvironmentAuditActivity;
  language: OperationLanguage;
}) {
  const copy = localCopy(language);
  const descriptor = activity.descriptor;
  const request = [descriptor.requestMethod, descriptor.requestRoute]
    .filter(Boolean)
    .join(" ");
  const network = [
    descriptor.protocol?.toUpperCase(),
    descriptor.reason,
    activity.networkTotals?.durationMs !== undefined
      ? `${activity.networkTotals.durationMs} ms`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <dl className="audit-activity-facts">
      <div>
        <dt>{copy.actor}</dt>
        <dd>
          {actorLabel(descriptor.actorKind, language)} · {descriptor.source}
        </dd>
      </div>
      <div>
        <dt>{copy.resource}</dt>
        <dd>
          {descriptor.resourceType} · {descriptor.resourceId}
          {descriptor.resourceSubresource
            ? ` · ${descriptor.resourceSubresource}`
            : ""}
        </dd>
      </div>
      {request ? (
        <div>
          <dt>{copy.request}</dt>
          <dd>
            {request}
            {descriptor.statusCode ? ` · HTTP ${descriptor.statusCode}` : ""}
          </dd>
        </div>
      ) : null}
      {network ? (
        <div>
          <dt>{copy.networkFacts}</dt>
          <dd>{network}</dd>
        </div>
      ) : null}
      <div>
        <dt>{copy.evidence}</dt>
        <dd>
          {copy.operationEvidence(activity.operationCount)} ·{" "}
          {copy.signedRecords(activity.eventCount)}
        </dd>
      </div>
    </dl>
  );
}

function AuditActivity({
  activity,
  language,
  timeZone,
}: {
  activity: EnvironmentAuditActivity;
  language: OperationLanguage;
  timeZone: string;
}) {
  const copy = localCopy(language);
  const [mounted, setMounted] = useState(false);
  const kind = activityKind(activity);
  const status = activityStatus(activity, language);
  const title = activityTitle(activity.descriptor, activity.outcome, language);

  return (
    <li
      className={`audit-activity-item ${
        activity.needsAttention ? "needs-attention" : ""
      }`}
    >
      <details
        className="audit-activity"
        onToggle={(toggleEvent) => {
          if (toggleEvent.currentTarget.open) setMounted(true);
        }}
      >
        <summary>
          <span className={`audit-activity-icon kind-${kind}`}>
            <ActivityGlyph kind={kind} />
          </span>
          <span className="audit-activity-copy">
            <strong>{title}</strong>
            <span>{activityMeta(activity, language)}</span>
          </span>
          {status ? (
            <span className={`audit-activity-status outcome-${status.kind}`}>
              {status.label}
            </span>
          ) : null}
          <time
            dateTime={unixTimestampToIso(activity.lastOccurredAt)}
            title={formatAuditDateTime(
              activity.lastOccurredAt,
              language,
              timeZone,
            )}
          >
            {formatAuditDateTime(
              activity.lastOccurredAt,
              language,
              timeZone,
            )}
          </time>
          <ChevronDown
            className="audit-activity-chevron"
            size={14}
            aria-hidden="true"
          />
        </summary>
        {mounted ? (
          <div className="audit-activity-body">
            <AuditActivityFacts activity={activity} language={language} />
            {activity.operations.length === 1 ? (
              <AuditEventTrail
                events={activity.operations[0]?.events ?? []}
                language={language}
                timeZone={timeZone}
              />
            ) : (
              <ol
                className="audit-operation-list"
                aria-label={copy.operationEvidence(activity.operationCount)}
              >
                {activity.operations.map((operation) => (
                  <AuditOperationEvidence
                    key={operation.operationId}
                    operation={operation}
                    language={language}
                    timeZone={timeZone}
                  />
                ))}
              </ol>
            )}
          </div>
        ) : null}
      </details>
    </li>
  );
}

export function EnvironmentAuditPanel({
  language,
  timeZone,
  environmentId,
  audit,
  loadingNewer,
  loadNewerError,
  onLoadNewer,
}: EnvironmentAuditPanelProps) {
  const copy = localCopy(language);
  const [view, setView] = useState<AuditPanelView>("all");
  const allOperations = useMemo(
    () => groupEnvironmentAuditOperations(audit.events),
    [audit.events],
  );
  const allActivities = useMemo(
    () =>
      projectEnvironmentAuditActivities(allOperations, {
        networkOverview: true,
      }).sort(
        (left, right) =>
          activityPriority(left) - activityPriority(right) ||
          right.lastOccurredAt - left.lastOccurredAt,
      ),
    [allOperations],
  );
  const summary = useMemo(
    () => summarizeEnvironmentAuditActivities(allActivities),
    [allActivities],
  );
  const activities = useMemo(
    () => filterActivities(allActivities, view),
    [allActivities, view],
  );
  const verificationIssues = summary.events - summary.verified;
  const firstOccurredAt = audit.events.reduce(
    (first, event) => Math.min(first, event.occurredAt),
    Number.POSITIVE_INFINITY,
  );
  const lastOccurredAt = audit.events.reduce(
    (last, event) => Math.max(last, event.occurredAt),
    Number.NEGATIVE_INFINITY,
  );
  const networkCount = allActivities.filter(
    (activity) => activity.descriptor.category === "network",
  ).length;
  const changeCount = allActivities.filter(isChangeActivity).length;
  const routineCount = allActivities.filter(isRoutineActivity).length;

  useEffect(() => setView("all"), [environmentId]);

  return (
    <section className="settings-card audit-panel" aria-label="Environment audit">
      <div className="audit-toolbar">
        <div className="audit-overview">
          <p>
            {copy.summary(summary.events, summary.operations, summary.attention)}
          </p>
          {Number.isFinite(firstOccurredAt) &&
          Number.isFinite(lastOccurredAt) ? (
            <span>
              {audit.nextCursor
                ? copy.partialCoverage(
                    formatAuditDateTime(firstOccurredAt, language, timeZone),
                    formatAuditDateTime(lastOccurredAt, language, timeZone),
                  )
                : copy.completeCoverage(
                    formatAuditDateTime(firstOccurredAt, language, timeZone),
                    formatAuditDateTime(lastOccurredAt, language, timeZone),
                  )}
            </span>
          ) : null}
        </div>
        <label className="audit-view-filter">
          <span className="sr-only">{copy.filter}</span>
          <select
            value={view}
            onChange={(event) =>
              setView(event.target.value as AuditPanelView)
            }
            aria-label={copy.filter}
            disabled={audit.events.length === 0}
          >
            <option value="all">{copy.all}</option>
            <option value="attention">
              {copy.issues} ({summary.attention})
            </option>
            <option value="network">
              {copy.network} ({networkCount})
            </option>
            <option value="changes">
              {copy.changes} ({changeCount})
            </option>
            <option value="routine">
              {copy.routine} ({routineCount})
            </option>
          </select>
        </label>
      </div>

      {summary.events > 0 ? (
        <div
          className={`audit-verification ${
            verificationIssues > 0 ? "is-warning" : ""
          }`}
          role={verificationIssues > 0 ? "alert" : "status"}
        >
          {verificationIssues > 0 ? (
            <CircleAlert size={13} aria-hidden="true" />
          ) : (
            <ShieldCheck size={13} aria-hidden="true" />
          )}
          <span>
            {verificationIssues > 0
              ? copy.loadedNeedVerification(verificationIssues)
              : copy.loadedVerified(summary.events)}
          </span>
        </div>
      ) : null}

      {activities.length > 0 ? (
        <ol className="audit-timeline" aria-live="polite">
          {activities.map((activity) => (
            <AuditActivity
              activity={activity}
              key={activity.id}
              language={language}
              timeZone={timeZone}
            />
          ))}
        </ol>
      ) : (
        <div className="audit-empty-state" role="status">
          <ShieldCheck size={20} aria-hidden="true" />
          <strong>
            {audit.events.length === 0 ? copy.noEvents : copy.noMatches}
          </strong>
          <p>{copy.asynchronous}</p>
        </div>
      )}

      {audit.nextCursor || loadNewerError ? (
        <div className="audit-pagination">
          {loadNewerError ? (
            <p role="alert">{loadNewerError}</p>
          ) : null}
          {audit.nextCursor ? (
            <button
              type="button"
              className="secondary-action-button"
              disabled={loadingNewer}
              onClick={onLoadNewer}
            >
              <RefreshCw
                className={loadingNewer ? "is-spinning" : undefined}
                size={13}
                aria-hidden="true"
              />
              {loadingNewer ? copy.loadingNewer : copy.loadNewer}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
