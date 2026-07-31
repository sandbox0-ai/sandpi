import {
  Braces,
  Check,
  ChevronRight,
  FilePenLine,
  ImageIcon,
  Plug,
  Search,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import React, {
  Children,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type {
  CodexActivityStatus,
  CodexActiveTurnView,
  CodexCommandActivityView,
  CodexFileChangeActivityView,
  CodexNativeItemActivityView,
  CodexNativeToolActivityView,
  CodexTurnResultView,
  CodexTurnView,
} from "./events";
import type { CodexRolloutToolActivity } from "./rollout-activity";
import {
  displayCodexCommand,
  summarizeCodexRolloutActivity,
  type CodexRolloutActionKind,
} from "./rollout-activity-summary";
import { getCodexUiCopy } from "./ui";
import type { OperationLanguage } from "@/lib/operation-ui";
import {
  formatUnixTimestamp,
  unixTimestampToIso,
} from "@/lib/time";

function activityIcon(status: CodexActivityStatus) {
  if (status === "completed") {
    return <Check size={13} strokeWidth={2.6} />;
  }
  if (status !== "running") {
    return <X size={13} strokeWidth={2.6} />;
  }
  return <span className="activity-spinner" />;
}

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1_000 ? `${milliseconds}ms` : formatElapsed(milliseconds);
}

function outputPreview(output: string) {
  const lines = output.trimEnd().split("\n");
  if (lines.length <= 7) return lines.join("\n");
  return [
    ...lines.slice(0, 3),
    `… ${lines.length - 6} lines omitted …`,
    ...lines.slice(-3),
  ].join("\n");
}

function workspacePath(path: string) {
  return path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;
}

function failedActivityStatus(status: CodexActivityStatus) {
  return (
    status === "failed" ||
    status === "declined" ||
    status === "interrupted"
  );
}

function effectiveActivityStatus(
  status: CodexActivityStatus,
  exitCode: number | null,
): CodexActivityStatus {
  return exitCode !== null && exitCode !== 0 ? "failed" : status;
}

function CompactActivity({
  status,
  icon,
  action,
  subject,
  subjectCode = false,
  external = false,
  externalLabel = "External",
  meta,
  renderDetails,
  className = "",
}: {
  status: CodexActivityStatus;
  icon: ReactNode;
  action: string;
  subject: string;
  subjectCode?: boolean;
  external?: boolean;
  externalLabel?: string;
  meta?: ReactNode;
  renderDetails?: () => ReactNode;
  className?: string;
}) {
  const expandable = Boolean(renderDetails);
  const running = status === "running";
  const [open, setOpen] = useState(running && expandable);

  useEffect(() => {
    if (!expandable) {
      setOpen(false);
      return;
    }
    setOpen(running);
  }, [expandable, running]);

  const summaryContent = (
    <>
      <span
        className={`activity-status status-${status}`}
        aria-hidden="true"
      >
        {status === "running" ? (
          <span className="activity-spinner" />
        ) : failedActivityStatus(status) ? (
          <X size={13} strokeWidth={2.6} />
        ) : (
          icon
        )}
      </span>
      <strong>{action}</strong>
      {subjectCode ? (
        <code className="codex-compact-activity-subject" title={subject}>
          {subject}
        </code>
      ) : (
        <span className="codex-compact-activity-subject" title={subject}>
          {subject}
        </span>
      )}
      {external ? (
        <span className="codex-activity-boundary is-external">
          {externalLabel}
        </span>
      ) : null}
      {meta ? <span className="codex-compact-activity-meta">{meta}</span> : null}
      {expandable ? (
        <ChevronRight
          className="codex-compact-activity-chevron"
          size={13}
          aria-hidden="true"
        />
      ) : null}
    </>
  );

  if (!renderDetails) {
    return (
      <div
        className={`codex-activity codex-compact-activity status-${status} ${className}`}
      >
        <div className="codex-compact-activity-summary">{summaryContent}</div>
      </div>
    );
  }
  return (
    <details
      className={`codex-activity codex-compact-activity status-${status} ${className}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summaryContent}</summary>
      {open ? (
        <div className="codex-compact-activity-body">{renderDetails()}</div>
      ) : null}
    </details>
  );
}

export function CodexCommandActivity({
  activity,
  language,
  compact = false,
  evidence = [],
}: {
  activity: CodexCommandActivityView;
  language: OperationLanguage;
  compact?: boolean;
  evidence?: CodexRolloutToolActivity[];
}) {
  const ui = getCodexUiCopy(language).conversation;
  const evidenceSummaries = evidence.map(summarizeCodexRolloutActivity);
  const evidenceExitCode =
    evidenceSummaries.find(
      (summary) => summary.exitCode !== null && summary.exitCode !== 0,
    )?.exitCode ?? null;
  const exitCode = evidenceExitCode ?? activity.exitCode;
  const output = outputPreview(
    activity.output ||
      [...evidenceSummaries].reverse().find((summary) => summary.output)
        ?.output ||
      "",
  );
  if (compact) {
    const status = effectiveActivityStatus(
      evidence.some((item) => item.status === "failed")
        ? "failed"
        : activity.status,
      exitCode,
    );
    const backgroundUpdates = evidenceSummaries.filter(
      (summary) => summary.followsBackgroundHandle,
    ).length;
    const hasDetails = Boolean(output || evidence.length > 0);
    return (
      <article className="message message-codex-activity">
        <CompactActivity
          status={status}
          icon={<Wrench size={13} />}
          action={ui.commandStatus(
            status,
            activity.exploration,
            activity.waitingForProcess,
          )}
          subject={displayCodexCommand(activity.command)}
          subjectCode
          meta={
            <>
              {exitCode !== null && exitCode !== 0 ? (
                <b className="codex-activity-issue">
                  {ui.exitCode(exitCode)}
                </b>
              ) : null}
              {backgroundUpdates > 0 ? (
                <span>{ui.backgroundUpdates(backgroundUpdates)}</span>
              ) : null}
              {activity.durationMs !== null ? (
                <span>{formatDuration(activity.durationMs)}</span>
              ) : null}
            </>
          }
          renderDetails={
            hasDetails
              ? () => (
                  <>
                    {activity.cwd ? (
                      <p className="codex-activity-context">
                        <span>{ui.workingDirectory}</span>
                        <code>{activity.cwd}</code>
                      </p>
                    ) : null}
                    {output ? (
                      <pre
                        className="codex-command-output"
                        tabIndex={0}
                        aria-label={ui.activityOutput}
                      >
                        <code>{output}</code>
                      </pre>
                    ) : null}
                    {activity.outputTruncated ? (
                      <small className="codex-output-note">
                        {ui.outputTruncated}
                      </small>
                    ) : null}
                    {evidence.length > 0 ? (
                      <CodexRolloutEvidencePayload
                        activities={evidence}
                        language={language}
                      />
                    ) : null}
                  </>
                )
              : undefined
          }
        />
      </article>
    );
  }
  return (
    <article className="message message-codex-activity">
      <div className={`codex-activity codex-command status-${activity.status}`}>
        <div className="codex-activity-heading">
          <span
            className={`activity-status status-${activity.status}`}
            aria-hidden="true"
          >
            {activityIcon(activity.status)}
          </span>
          <strong>
            {ui.commandStatus(
              activity.status,
              activity.exploration,
              activity.waitingForProcess,
            )}
          </strong>
          {activity.durationMs !== null ? (
            <span className="activity-duration">
              {formatDuration(activity.durationMs)}
            </span>
          ) : null}
        </div>
        <code className="codex-command-line" title={activity.command}>
          {displayCodexCommand(activity.command)}
        </code>
        {output ? (
          <pre
            className="codex-command-output"
            tabIndex={0}
            aria-label={ui.activityOutput}
          >
            <code>{output}</code>
          </pre>
        ) : null}
        {activity.outputTruncated ? (
          <small className="codex-output-note">{ui.outputTruncated}</small>
        ) : null}
      </div>
    </article>
  );
}

export function CodexFileChangeActivity({
  activity,
  language,
  onOpenFiles,
  compact = false,
  evidence = [],
}: {
  activity: CodexFileChangeActivityView;
  language: OperationLanguage;
  onOpenFiles: () => void;
  compact?: boolean;
  evidence?: CodexRolloutToolActivity[];
}) {
  const ui = getCodexUiCopy(language).conversation;
  const totalAdditions = activity.changes.reduce(
    (total, change) => total + change.additions,
    0,
  );
  const totalDeletions = activity.changes.reduce(
    (total, change) => total + change.deletions,
    0,
  );
  if (compact) {
    const evidenceSummaries = evidence.map(summarizeCodexRolloutActivity);
    const evidenceExitCode =
      evidenceSummaries.find(
        (summary) => summary.exitCode !== null && summary.exitCode !== 0,
      )?.exitCode ?? null;
    const status = effectiveActivityStatus(
      evidence.some((item) => item.status === "failed")
        ? "failed"
        : activity.status,
      evidenceExitCode,
    );
    const paths = activity.changes.map((change) => workspacePath(change.file));
    const subject = [
      ...paths.slice(0, 2),
      ...(paths.length > 2 ? [`+${paths.length - 2}`] : []),
    ].join(", ");
    return (
      <article className="message message-codex-activity">
        <CompactActivity
          status={status}
          icon={<FilePenLine size={13} />}
          action={ui.fileStatus(status, activity.changes.length)}
          subject={subject}
          subjectCode
          meta={
            <>
              {evidenceExitCode !== null ? (
                <b className="codex-activity-issue">
                  {ui.exitCode(evidenceExitCode)}
                </b>
              ) : null}
              <span className="codex-diff-totals">
                <b>+{totalAdditions}</b>
                <i>-{totalDeletions}</i>
              </span>
            </>
          }
          renderDetails={() => (
            <>
              <ul className="codex-file-change-list">
                {activity.changes.slice(0, 12).map((change) => (
                  <li key={`${change.file}:${change.movePath ?? ""}`}>
                    <FilePenLine size={13} aria-hidden="true" />
                    <span className="codex-file-action">
                      {ui.fileAction(change.kind)}
                    </span>
                    <code title={change.file}>
                      {workspacePath(change.file)}
                      {change.movePath
                        ? ` → ${workspacePath(change.movePath)}`
                        : ""}
                    </code>
                    <span className="codex-file-stats">
                      <b>+{change.additions}</b>
                      <i>-{change.deletions}</i>
                    </span>
                  </li>
                ))}
              </ul>
              {activity.changes.length > 12 ? (
                <small className="codex-output-note">
                  +{activity.changes.length - 12} files
                </small>
              ) : null}
              <button
                type="button"
                className="codex-open-files"
                onClick={onOpenFiles}
              >
                {ui.openChangedFiles}
              </button>
              {evidence.length > 0 ? (
                <CodexRolloutEvidencePayload
                  activities={evidence}
                  language={language}
                />
              ) : null}
            </>
          )}
        />
      </article>
    );
  }
  return (
    <article className="message message-codex-activity">
      <div className={`codex-activity codex-file-change status-${activity.status}`}>
        <div className="codex-activity-heading">
          <span
            className={`activity-status status-${activity.status}`}
            aria-hidden="true"
          >
            {activityIcon(activity.status)}
          </span>
          <strong>{ui.fileStatus(activity.status, activity.changes.length)}</strong>
          <span className="codex-diff-totals">
            <b>+{totalAdditions}</b>
            <i>-{totalDeletions}</i>
          </span>
        </div>
        <ul className="codex-file-change-list">
          {activity.changes.slice(0, 8).map((change) => (
            <li key={`${change.file}:${change.movePath ?? ""}`}>
              <FilePenLine size={13} aria-hidden="true" />
              <span className="codex-file-action">{ui.fileAction(change.kind)}</span>
              <code title={change.file}>
                {workspacePath(change.file)}
                {change.movePath ? ` → ${workspacePath(change.movePath)}` : ""}
              </code>
              <span className="codex-file-stats">
                <b>+{change.additions}</b>
                <i>-{change.deletions}</i>
              </span>
            </li>
          ))}
        </ul>
        {activity.changes.length > 8 ? (
          <small className="codex-output-note">+{activity.changes.length - 8} files</small>
        ) : null}
        <button type="button" className="codex-open-files" onClick={onOpenFiles}>
          {ui.openChangedFiles}
        </button>
      </div>
    </article>
  );
}

export function CodexNativeItemActivity({
  activity,
  language,
  compact = false,
}: {
  activity: CodexNativeItemActivityView;
  language: OperationLanguage;
  compact?: boolean;
}) {
  const ui = getCodexUiCopy(language).conversation;
  if (compact) {
    return (
      <article className="message message-codex-activity">
        <CompactActivity
          status={activity.status}
          icon={<Braces size={13} strokeWidth={2.2} />}
          action={ui.nativeItemStatus(activity.itemType, activity.status)}
          subject={activity.detail ?? activity.itemType}
        />
      </article>
    );
  }
  return (
    <article className="message message-codex-activity">
      <div className={`codex-activity codex-native-item status-${activity.status}`}>
        <div className="codex-activity-heading">
          <span
            className={`activity-status status-${activity.status}`}
            aria-hidden="true"
          >
            {activity.status === "running" ? (
              activityIcon(activity.status)
            ) : (
              <Braces size={13} strokeWidth={2.2} />
            )}
          </span>
          <strong>{ui.nativeItemStatus(activity.itemType, activity.status)}</strong>
          <code className="codex-native-item-type">{activity.itemType}</code>
        </div>
        {activity.detail ? (
          <p className="codex-native-item-detail">{activity.detail}</p>
        ) : null}
      </div>
    </article>
  );
}

const MAX_NATIVE_TOOL_PAYLOAD_CHARS = 16 * 1024;
const MAX_NATIVE_TOOL_PREVIEW_DEPTH = 5;
const MAX_NATIVE_TOOL_PREVIEW_ENTRIES = 40;
const MAX_NATIVE_TOOL_PREVIEW_NODES = 320;
const MAX_NATIVE_TOOL_PREVIEW_STRING_CHARS = 2_048;

function boundedNativeToolValue(
  value: unknown,
  state: { nodes: number },
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_NATIVE_TOOL_PREVIEW_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_NATIVE_TOOL_PREVIEW_STRING_CHARS)}…`;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_NATIVE_TOOL_PREVIEW_DEPTH) return "[depth limit]";
  if (state.nodes >= MAX_NATIVE_TOOL_PREVIEW_NODES) return "[entry limit]";

  seen.add(value);
  if (Array.isArray(value)) {
    const preview: unknown[] = [];
    for (
      let index = 0;
      index < value.length &&
      index < MAX_NATIVE_TOOL_PREVIEW_ENTRIES &&
      state.nodes < MAX_NATIVE_TOOL_PREVIEW_NODES;
      index += 1
    ) {
      state.nodes += 1;
      preview.push(boundedNativeToolValue(value[index], state, seen, depth + 1));
    }
    if (value.length > preview.length) {
      preview.push(`[${value.length - preview.length} more items]`);
    }
    return preview;
  }

  const preview = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(value);
  for (
    let index = 0;
    index < keys.length &&
    index < MAX_NATIVE_TOOL_PREVIEW_ENTRIES &&
    state.nodes < MAX_NATIVE_TOOL_PREVIEW_NODES;
    index += 1
  ) {
    const key = keys[index]!;
    state.nodes += 1;
    preview[key] = boundedNativeToolValue(
      (value as Record<string, unknown>)[key],
      state,
      seen,
      depth + 1,
    );
  }
  if (keys.length > Object.keys(preview).length) {
    preview["…"] = `${keys.length - Object.keys(preview).length} more fields`;
  }
  return preview;
}

function boundedNativeToolPayload(value: unknown) {
  // Keep native arguments/results inspectable without walking or serializing an
  // unbounded integration response into the browser DOM.
  let encoded: string;
  try {
    encoded =
      JSON.stringify(
        boundedNativeToolValue(value, { nodes: 0 }, new WeakSet()),
        null,
        2,
      ) ?? String(value);
  } catch {
    encoded = String(value);
  }
  if (encoded.length <= MAX_NATIVE_TOOL_PAYLOAD_CHARS) return encoded;
  return `${encoded.slice(0, MAX_NATIVE_TOOL_PAYLOAD_CHARS)}\n… payload truncated …`;
}

function nativeToolIcon(activity: CodexNativeToolActivityView) {
  if (activity.kind === "mcpToolCall") return <Plug size={13} />;
  if (activity.kind === "dynamicToolCall") return <Wrench size={13} />;
  if (activity.kind === "webSearch") return <Search size={13} />;
  if (
    activity.kind === "collabAgentToolCall" ||
    activity.kind === "subAgentActivity"
  ) {
    return <UsersRound size={13} />;
  }
  return <ImageIcon size={13} />;
}

function nativeToolSubject(activity: CodexNativeToolActivityView) {
  if (activity.kind === "mcpToolCall") {
    return [activity.appName ?? activity.server, activity.tool]
      .filter(Boolean)
      .join(" · ");
  }
  if (activity.kind === "dynamicToolCall") {
    return [activity.namespace, activity.tool].filter(Boolean).join(" · ");
  }
  if (activity.kind === "webSearch") return activity.query;
  if (activity.kind === "collabAgentToolCall") {
    const receivers = activity.receiverThreadIds.length;
    return receivers > 0
      ? `${activity.tool} · ${receivers} ${receivers === 1 ? "thread" : "threads"}`
      : activity.tool;
  }
  if (activity.kind === "subAgentActivity") {
    return activity.agentPath || activity.agentThreadId;
  }
  return activity.savedPath ?? activity.revisedPrompt ?? "";
}

function nativeToolPayloads(
  activity: CodexNativeToolActivityView,
): Array<{ label: string; value: unknown }> {
  if (activity.kind === "mcpToolCall") {
    return [
      { label: "arguments", value: activity.arguments },
      ...(activity.result === null
        ? []
        : [{ label: "result", value: activity.result }]),
      ...(activity.error ? [{ label: "error", value: activity.error }] : []),
    ];
  }
  if (activity.kind === "dynamicToolCall") {
    return [
      { label: "arguments", value: activity.arguments },
      ...(activity.contentItems === null
        ? []
        : [{ label: "contentItems", value: activity.contentItems }]),
      ...(activity.success === null
        ? []
        : [{ label: "success", value: activity.success }]),
    ];
  }
  if (activity.kind === "webSearch") {
    return activity.action === null
      ? []
      : [{ label: "action", value: activity.action }];
  }
  if (activity.kind === "collabAgentToolCall") {
    return [
      ...(activity.prompt ? [{ label: "prompt", value: activity.prompt }] : []),
      {
        label: "threadIds",
        value: {
          sender: activity.senderThreadId,
          receivers: activity.receiverThreadIds,
        },
      },
    ];
  }
  if (activity.kind === "subAgentActivity") {
    return [
      {
        label: "agent",
        value: {
          kind: activity.activityKind,
          threadId: activity.agentThreadId,
          path: activity.agentPath,
        },
      },
    ];
  }
  return [
    ...(activity.revisedPrompt
      ? [{ label: "revisedPrompt", value: activity.revisedPrompt }]
      : []),
    ...(activity.savedPath
      ? [{ label: "savedPath", value: activity.savedPath }]
      : []),
  ];
}

function payloadHasVisibleContent(value: unknown) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function NativePayloadContent({
  payloads,
  language,
}: {
  payloads: Array<{ label: string; value: unknown }>;
  language: OperationLanguage;
}) {
  const ui = getCodexUiCopy(language).conversation;
  return (
    <div>
      {payloads.map((payload, index) => (
        <section key={`${payload.label}:${index}`}>
          <strong>{payload.label}</strong>
          <pre
            aria-label={`${ui.technicalDetails}: ${payload.label}`}
            tabIndex={0}
          >
            {boundedNativeToolPayload(payload.value)}
          </pre>
        </section>
      ))}
    </div>
  );
}

function InlineNativePayload({
  payloads,
  language,
}: {
  payloads: Array<{ label: string; value: unknown }>;
  language: OperationLanguage;
}) {
  return (
    <div className="codex-native-tool-details is-inline">
      <NativePayloadContent payloads={payloads} language={language} />
    </div>
  );
}

function NativePayloadDetails({
  payloads,
  label,
  language,
}: {
  payloads: Array<{ label: string; value: unknown }>;
  label: string;
  language: OperationLanguage;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const [open, setOpen] = useState(false);
  if (payloads.length === 0) return null;
  return (
    <details
      className="codex-native-tool-details"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label={`${ui.technicalDetails}: ${label}`}>
        <Braces size={12} aria-hidden="true" />
        <span>{ui.technicalDetails}</span>
        <ChevronRight size={12} aria-hidden="true" />
      </summary>
      {open ? (
        <NativePayloadContent payloads={payloads} language={language} />
      ) : null}
    </details>
  );
}

function CodexRolloutEvidencePayload({
  activities,
  language,
}: {
  activities: CodexRolloutToolActivity[];
  language: OperationLanguage;
}) {
  const ui = getCodexUiCopy(language).conversation;
  return (
    <InlineNativePayload
      language={language}
      payloads={activities.map((activity, index) => ({
        label: [
          ui.nativeRecord(index + 1, activities.length),
          activity.codeModeTools.join(" · ") || activity.name,
        ].join(" · "),
        value: {
          callId: activity.callId,
          callType: activity.callType,
          nativeStatus: activity.nativeStatus,
          createdAt: unixTimestampToIso(activity.createdAt),
          completedAt:
            activity.completedAt === null
              ? null
              : unixTimestampToIso(activity.completedAt),
          call: activity.callPayload,
          outputs: activity.outputs,
        },
      }))}
    />
  );
}

export function CodexNativeToolActivity({
  activity,
  language,
  compact = false,
}: {
  activity: CodexNativeToolActivityView;
  language: OperationLanguage;
  compact?: boolean;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const payloads = nativeToolPayloads(activity);
  const visiblePayloads = payloads.filter((payload) =>
    payloadHasVisibleContent(payload.value),
  );
  const external =
    activity.kind === "mcpToolCall" ||
    activity.kind === "dynamicToolCall" ||
    activity.kind === "webSearch" ||
    activity.kind === "imageGeneration";
  const subject = nativeToolSubject(activity);

  if (compact) {
    const status =
      (activity.kind === "mcpToolCall" && activity.error) ||
      (activity.kind === "dynamicToolCall" && activity.success === false)
        ? "failed"
        : activity.status;
    return (
      <article className="message message-codex-activity">
        <CompactActivity
          status={status}
          icon={nativeToolIcon(activity)}
          action={ui.nativeAction(activity.kind, status)}
          subject={subject || activity.kind}
          external={external}
          externalLabel={ui.externalInteraction}
          meta={
            "durationMs" in activity && activity.durationMs !== null ? (
              <span>{formatDuration(activity.durationMs)}</span>
            ) : null
          }
          renderDetails={
            visiblePayloads.length > 0
              ? () => (
                  <InlineNativePayload
                    payloads={visiblePayloads}
                    language={language}
                  />
                )
              : undefined
          }
          className="codex-native-tool"
        />
      </article>
    );
  }

  return (
    <article className="message message-codex-activity">
      <div
        className={`codex-activity codex-native-tool status-${activity.status}`}
      >
        <div className="codex-activity-heading">
          <span
            className={`activity-status status-${activity.status}`}
            aria-hidden="true"
          >
            {activity.status === "running"
              ? activityIcon(activity.status)
              : nativeToolIcon(activity)}
          </span>
          <strong>{ui.nativeItemStatus(activity.kind, activity.status)}</strong>
          <span
            className={`codex-activity-boundary ${
              external ? "is-external" : "is-agent"
            }`}
          >
            {external ? ui.externalInteraction : ui.agentInteraction}
          </span>
          {"durationMs" in activity && activity.durationMs !== null ? (
            <span className="activity-duration">
              {formatDuration(activity.durationMs)}
            </span>
          ) : null}
          <code className="codex-native-item-type">{activity.kind}</code>
        </div>
        {subject ? (
          <p className="codex-native-item-detail">
            {subject}
          </p>
        ) : null}
        {visiblePayloads.length > 0 ? (
          <NativePayloadDetails
            payloads={visiblePayloads}
            label={subject || activity.kind}
            language={language}
          />
        ) : null}
      </div>
    </article>
  );
}

export function CodexRolloutToolCallActivity({
  activity,
  language,
  timeZone,
  relatedActivities = [],
}: {
  activity: CodexRolloutToolActivity;
  language: OperationLanguage;
  timeZone: string;
  relatedActivities?: CodexRolloutToolActivity[];
}) {
  const ui = getCodexUiCopy(language).conversation;
  const activities = [activity, ...relatedActivities];
  const descriptions = activities.map(summarizeCodexRolloutActivity);
  const description = descriptions[0]!;
  const relatedFailure = activities.find(
    (item, index) =>
      item.status === "failed" ||
      ((descriptions[index]?.exitCode ?? 0) !== 0),
  );
  const exitCode =
    descriptions.find((item) => item.exitCode !== null && item.exitCode !== 0)
      ?.exitCode ??
    [...descriptions].reverse().find((item) => item.exitCode !== null)
      ?.exitCode ??
    null;
  const status = effectiveActivityStatus(
    relatedFailure ? "failed" : activity.status,
    exitCode,
  );
  const readableOutput = outputPreview(
    [...descriptions].reverse().find((item) => item.output)?.output ?? "",
  );
  const completedAt = Math.max(
    ...activities
      .map((item) => item.completedAt)
      .filter((value): value is number => value !== null),
  );
  const durationMs = Number.isFinite(completedAt)
    ? Math.max(0, Math.round((completedAt - activity.createdAt) * 1_000))
    : activity.durationMs;
  const subject =
    description.kind === "fileChange"
      ? description.filePaths
          .slice(0, 2)
          .map(workspacePath)
          .concat(
            description.filePaths.length > 2
              ? [`+${description.filePaths.length - 2}`]
              : [],
          )
          .join(", ") || description.subject
      : description.subject;
  const occurredAt = formatUnixTimestamp(
    activity.createdAt,
    language === "zh-CN" ? "zh-CN" : "en-US",
    timeZone,
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
  );
  const icon =
    description.kind === "fileChange" ? (
      <FilePenLine size={13} />
    ) : description.kind === "web" ? (
      <Search size={13} />
    ) : description.kind === "integration" ? (
      <Plug size={13} />
    ) : description.kind === "agent" ? (
      <UsersRound size={13} />
    ) : description.kind === "image" ? (
      <ImageIcon size={13} />
    ) : (
      <Wrench size={13} />
    );

  return (
    <article className="message message-codex-activity">
      <CompactActivity
        className="codex-native-tool codex-rollout-tool"
        status={status}
        icon={icon}
        action={ui.rolloutAction(
          description.kind as CodexRolloutActionKind,
          status,
          description.filePaths.length,
        )}
        subject={subject}
        subjectCode={
          description.kind === "command" ||
          description.kind === "fileChange"
        }
        external={description.external}
        externalLabel={ui.externalInteraction}
        meta={
          <>
            {exitCode !== null && exitCode !== 0 ? (
              <b className="codex-activity-issue">
                {ui.exitCode(exitCode)}
              </b>
            ) : null}
            {relatedActivities.length > 0 ? (
              <span>{ui.backgroundUpdates(relatedActivities.length)}</span>
            ) : null}
            {durationMs !== null ? <span>{formatDuration(durationMs)}</span> : null}
            <time
              className="codex-rollout-time"
              dateTime={unixTimestampToIso(activity.createdAt)}
              title={unixTimestampToIso(activity.createdAt)}
            >
              {occurredAt}
            </time>
          </>
        }
        renderDetails={() => (
          <>
            {description.detail ? (
              <p className="codex-activity-context">
                <span>
                  {description.cwd ? ui.workingDirectory : ui.activityDetail}
                </span>
                <code>{description.detail}</code>
              </p>
            ) : null}
            {description.commands.length > 1 ? (
              <section className="codex-rollout-command-list">
                <strong>{ui.commandActivity}</strong>
                {description.commands.map((command, index) => (
                  <pre
                    className="codex-command-output"
                    key={`${index}:${command}`}
                    tabIndex={0}
                  >
                    <code>{displayCodexCommand(command)}</code>
                  </pre>
                ))}
              </section>
            ) : null}
            {readableOutput ? (
              <pre
                className="codex-command-output"
                tabIndex={0}
                aria-label={ui.activityOutput}
              >
                <code>{readableOutput}</code>
              </pre>
            ) : null}
            <CodexRolloutEvidencePayload
              activities={activities}
              language={language}
            />
            {activities.some((item) => item.payloadTruncated) ? (
              <small className="codex-output-note">{ui.outputTruncated}</small>
            ) : null}
          </>
        )}
      />
    </article>
  );
}

export function CodexTurnResult({
  result,
  language,
}: {
  result: CodexTurnResultView;
  language: OperationLanguage;
}) {
  const ui = getCodexUiCopy(language).conversation;
  return (
    <article className="message message-codex-turn-activity message-codex-turn-result">
      <div className="codex-turn-result" role="status">
        <span className="activity-status status-failed" aria-hidden="true">
          <X size={13} strokeWidth={2.6} />
        </span>
        <div>
          <strong>
            <span>Codex</span>
            <span aria-hidden="true">·</span>
            {result.status === "failed" ? ui.turnFailed : ui.turnInterrupted}
          </strong>
          {result.detail ? <small>{result.detail}</small> : null}
        </div>
      </div>
    </article>
  );
}

export function CodexTurnActivity({
  activeTurn,
  autoExpand = true,
  turn,
  language,
  now,
  children,
}: {
  activeTurn?: CodexActiveTurnView;
  autoExpand?: boolean;
  turn?: CodexTurnView;
  language: OperationLanguage;
  now: number;
  children?: ReactNode;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const running = Boolean(activeTurn);
  const hasActivity = Children.count(children) > 0;
  const [open, setOpen] = useState(running && autoExpand && hasActivity);

  useEffect(() => {
    if (!hasActivity) {
      setOpen(false);
      return;
    }
    setOpen(running && autoExpand);
  }, [autoExpand, hasActivity, running]);

  const durationMs = activeTurn
    ? Math.max(0, now - activeTurn.startedAt * 1_000)
    : turn?.durationMs ??
      (turn?.completedAt === null || turn?.completedAt === undefined
        ? null
        : Math.max(0, (turn.completedAt - turn.startedAt) * 1_000));
  const summary = activeTurn
    ? ui.turnActivity(activeTurn.state)
    : durationMs === null
      ? ui.viewTurnActivity
      : ui.workedFor(formatDuration(durationMs));

  const activityHeader = (disclosure: boolean) => (
    <>
      {disclosure ? (
        <ChevronRight
          className="codex-turn-activity-chevron"
          size={14}
          aria-hidden="true"
        />
      ) : null}
      {running ? (
        <span className="activity-spinner" aria-hidden="true" />
      ) : (
        <span className="codex-turn-activity-dot" aria-hidden="true" />
      )}
      <strong>{summary}</strong>
      {activeTurn?.detail ? (
        <small className="codex-turn-activity-detail">
          {activeTurn.detail}
        </small>
      ) : null}
      {activeTurn && durationMs !== null ? (
        <span className="codex-turn-running-duration" aria-hidden="true">
          {ui.runningFor(formatElapsed(durationMs))}
        </span>
      ) : null}
    </>
  );

  return (
    <article className="message message-codex-turn-activity">
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {summary}
      </span>
      {hasActivity ? (
        <details
          className={`codex-turn-activity${running ? " is-running" : ""}`}
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary
            aria-label={`${summary}. ${
              open ? ui.collapseTurnActivity : ui.expandTurnActivity
            }`}
          >
            {activityHeader(true)}
          </summary>
          <div className="codex-turn-activity-content">{children}</div>
        </details>
      ) : (
        <div
          className={`codex-turn-activity codex-turn-activity-static${
            running ? " is-running" : ""
          }`}
        >
          {activityHeader(false)}
        </div>
      )}
    </article>
  );
}
