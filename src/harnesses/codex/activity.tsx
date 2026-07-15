import { Braces, Check, FilePenLine, X } from "lucide-react";

import type {
  CodexActivityStatus,
  CodexActiveTurnView,
  CodexCommandActivityView,
  CodexFileChangeActivityView,
  CodexNativeItemActivityView,
  CodexTurnResultView,
} from "./events";
import { getCodexUiCopy } from "./ui";
import type { OperationLanguage } from "@/lib/operation-ui";

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

export function CodexRunningTurn({
  turn,
  language,
  now,
}: {
  turn: CodexActiveTurnView;
  language: OperationLanguage;
  now: number;
}) {
  const ui = getCodexUiCopy(language).conversation;
  const elapsed = formatElapsed(now - turn.startedAt * 1_000);
  return (
    <article
      className="message message-codex-activity codex-running-turn"
      aria-live="polite"
    >
      <div className="codex-turn-running">
        <span className="activity-spinner" aria-hidden="true" />
        <div>
          <strong>{ui.turnActivity(turn.state)}</strong>
          {turn.detail ? <small>{turn.detail}</small> : null}
        </div>
        <span>{ui.runningFor(elapsed)}</span>
      </div>
    </article>
  );
}
