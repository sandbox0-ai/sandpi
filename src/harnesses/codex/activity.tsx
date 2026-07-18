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
import { useEffect, useRef, useState, type ReactNode } from "react";

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

function displayCommand(command: string) {
  const match = command.match(/^\/bin\/(?:ba|z|)sh\s+-lc\s+(["'])([\s\S]*)\1$/);
  return match?.[2] ?? command;
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

export function CodexCommandActivity({
  activity,
  language,
}: {
  activity: CodexCommandActivityView;
  language: OperationLanguage;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const output = outputPreview(activity.output);
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
          {displayCommand(activity.command)}
        </code>
        {output ? (
          <pre
            className="codex-command-output"
            aria-live={activity.status === "running" ? "polite" : undefined}
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
}: {
  activity: CodexFileChangeActivityView;
  language: OperationLanguage;
  onOpenFiles: () => void;
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
}: {
  activity: CodexNativeItemActivityView;
  language: OperationLanguage;
}) {
  const ui = getCodexUiCopy(language).conversation;
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

  const preview: Record<string, unknown> = {};
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

export function CodexNativeToolActivity({
  activity,
  language,
}: {
  activity: CodexNativeToolActivityView;
  language: OperationLanguage;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const payloads = nativeToolPayloads(activity);
  const external =
    activity.kind === "mcpToolCall" ||
    activity.kind === "dynamicToolCall" ||
    activity.kind === "webSearch" ||
    activity.kind === "imageGeneration";

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
        {nativeToolSubject(activity) ? (
          <p className="codex-native-item-detail">
            {nativeToolSubject(activity)}
          </p>
        ) : null}
        {payloads.length > 0 ? (
          <details className="codex-native-tool-details">
            <summary>
              <Braces size={12} aria-hidden="true" />
              {ui.nativePayload}
            </summary>
            <div>
              {payloads.map((payload) => (
                <section key={payload.label}>
                  <strong>{payload.label}</strong>
                  <pre>{boundedNativeToolPayload(payload.value)}</pre>
                </section>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

export function CodexRolloutToolCallActivity({
  activity,
  language,
  timeZone,
}: {
  activity: CodexRolloutToolActivity;
  language: OperationLanguage;
  timeZone: string;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const subject =
    activity.codeModeTools.length > 0
      ? activity.codeModeTools.join(" · ")
      : [activity.namespace, activity.name].filter(Boolean).join(" · ");
  const payloads = [
    { label: "call", value: activity.callPayload },
    ...activity.outputs.map((output, index) => ({
      label: [
        `output ${index + 1}`,
        output.outputType,
        output.createdAt === null
          ? null
          : formatUnixTimestamp(
              output.createdAt,
              language === "zh-CN" ? "zh-CN" : "en-US",
              timeZone,
              {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              },
            ),
      ]
        .filter(Boolean)
        .join(" · "),
      value: output.payload,
    })),
  ];
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
            {activity.status === "running" ? (
              activityIcon(activity.status)
            ) : activity.status === "failed" ? (
              <X size={13} strokeWidth={2.6} />
            ) : (
              <Wrench size={13} />
            )}
          </span>
          <strong>
            {ui.nativeItemStatus("rolloutToolCall", activity.status)}
          </strong>
          <span className="codex-activity-boundary">
            {ui.persistedRollout}
          </span>
          {activity.durationMs !== null ? (
            <span className="activity-duration">
              {formatDuration(activity.durationMs)}
            </span>
          ) : null}
          <time
            className="codex-rollout-time"
            dateTime={unixTimestampToIso(activity.createdAt)}
            title={unixTimestampToIso(activity.createdAt)}
          >
            {occurredAt}
          </time>
          <code className="codex-native-item-type">{activity.callType}</code>
        </div>
        <p className="codex-native-item-detail">{subject}</p>
        <code className="codex-rollout-call-id" title={activity.callId}>
          {activity.callId}
        </code>
        <details className="codex-native-tool-details">
          <summary>
            <Braces size={12} aria-hidden="true" />
            {ui.nativePayload}
          </summary>
          <div>
            {payloads.map((payload) => (
              <section key={payload.label}>
                <strong>{payload.label}</strong>
                <pre>{boundedNativeToolPayload(payload.value)}</pre>
              </section>
            ))}
          </div>
        </details>
        {activity.payloadTruncated ? (
          <small className="codex-output-note">{ui.outputTruncated}</small>
        ) : null}
      </div>
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
    <article className="message message-codex-activity">
      <div className="codex-turn-result" role="status">
        <span className="activity-status status-failed" aria-hidden="true">
          <X size={13} strokeWidth={2.6} />
        </span>
        <div>
          <strong>{result.status === "failed" ? ui.turnFailed : ui.turnInterrupted}</strong>
          {result.detail ? <small>{result.detail}</small> : null}
        </div>
      </div>
    </article>
  );
}

export function CodexTurnActivity({
  activeTurn,
  turn,
  language,
  now,
  children,
}: {
  activeTurn?: CodexActiveTurnView;
  turn?: CodexTurnView;
  language: OperationLanguage;
  now: number;
  children?: ReactNode;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const running = Boolean(activeTurn);
  const [open, setOpen] = useState(running);
  const wasRunningRef = useRef(running);

  useEffect(() => {
    if (running) {
      setOpen(true);
    } else if (wasRunningRef.current) {
      // A live Turn folds as soon as Codex reports turn/completed. Keep the
      // prompt and final answer outside this disclosure in every client.
      setOpen(false);
    }
    wasRunningRef.current = running;
  }, [running]);

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

  return (
    <article className="message message-codex-turn-activity">
      <details
        className={`codex-turn-activity${running ? " is-running" : ""}`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary
          aria-label={open ? ui.collapseTurnActivity : ui.expandTurnActivity}
          aria-live={running ? "polite" : undefined}
        >
          <ChevronRight
            className="codex-turn-activity-chevron"
            size={14}
            aria-hidden="true"
          />
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
            <span className="codex-turn-running-duration">
              {ui.runningFor(formatElapsed(durationMs))}
            </span>
          ) : null}
        </summary>
        {children ? (
          <div className="codex-turn-activity-content">{children}</div>
        ) : null}
      </details>
    </article>
  );
}
