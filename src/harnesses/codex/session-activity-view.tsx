"use client";

import {
  Braces,
  LoaderCircle,
  SearchX,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  CodexCommandActivity,
  CodexFileChangeActivity,
  CodexNativeItemActivity,
  CodexNativeToolActivity,
  CodexTurnResult,
} from "./activity";
import type { CodexConversationProjection } from "./events";
import {
  selectCodexSessionActivity,
  summarizeCodexSessionActivity,
  type CodexSessionActivityEntry,
  type CodexSessionActivityFilter,
} from "./session-activity";
import { getCodexUiCopy } from "./ui";
import {
  formatUnixTimestamp,
  unixTimestampToIso,
} from "@/lib/time";
import type { OperationLanguage } from "@/lib/operation-ui";

interface CodexSessionActivityViewProps {
  language: OperationLanguage;
  timeZone: string;
  projection: CodexConversationProjection;
  nativeThreadId: string;
  historyRevision: number;
  loading: boolean;
  error: string;
  onOpenEnvironmentAudit: () => void;
  onOpenFiles: () => void;
}

function formatActivityTime(
  timestamp: number,
  language: OperationLanguage,
  timeZone: string,
) {
  return formatUnixTimestamp(
    timestamp,
    language === "zh-CN" ? "zh-CN" : "en-US",
    timeZone,
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
  );
}

function ActivityEntry({
  entry,
  language,
  onOpenFiles,
}: {
  entry: CodexSessionActivityEntry;
  language: OperationLanguage;
  onOpenFiles: () => void;
}) {
  const activity =
    entry.kind === "command" ? (
      <CodexCommandActivity activity={entry} language={language} />
    ) : entry.kind === "fileChange" ? (
      <CodexFileChangeActivity
        activity={entry}
        language={language}
        onOpenFiles={onOpenFiles}
      />
    ) : entry.kind === "nativeItem" ? (
      <CodexNativeItemActivity activity={entry} language={language} />
    ) : entry.kind === "turnResult" ? (
      <CodexTurnResult result={entry} language={language} />
    ) : (
      <CodexNativeToolActivity activity={entry} language={language} />
    );

  return (
    <div className="codex-session-activity-record">
      <div>{activity}</div>
    </div>
  );
}

export function CodexSessionActivityView({
  language,
  timeZone,
  projection,
  nativeThreadId,
  historyRevision,
  loading,
  error,
  onOpenEnvironmentAudit,
  onOpenFiles,
}: CodexSessionActivityViewProps) {
  const ui = getCodexUiCopy(language).conversation;
  const [filter, setFilter] = useState<CodexSessionActivityFilter>("all");
  const summary = useMemo(
    () => summarizeCodexSessionActivity(projection),
    [projection],
  );
  const turns = useMemo(
    () => selectCodexSessionActivity(projection, filter),
    [filter, projection],
  );

  return (
    <div
      className="codex-session-activity-view"
      aria-label={ui.sessionActivity}
    >
      <div className="codex-session-activity-column">
        <header className="codex-session-activity-intro">
          <div>
            <span>{ui.codexNativeActivity}</span>
            <h2>{ui.sessionActivity}</h2>
            <p>
              {ui.sessionActivitySummary(summary.total, summary.external)}
            </p>
          </div>
          <label>
            <span className="sr-only">{ui.sessionActivityFilter}</span>
            <select
              aria-label={ui.sessionActivityFilter}
              value={filter}
              disabled={summary.total === 0}
              onChange={(event) =>
                setFilter(event.target.value as CodexSessionActivityFilter)
              }
            >
              <option value="all">{ui.allSessionActivity}</option>
              <option value="external">
                {ui.externalActivity} ({summary.external})
              </option>
              <option value="commands">
                {ui.commandActivity} ({summary.commands})
              </option>
              <option value="files">
                {ui.fileActivity} ({summary.files})
              </option>
              <option value="agents">
                {ui.agentActivity} ({summary.agents})
              </option>
              <option value="system">
                {ui.systemActivity} ({summary.system})
              </option>
            </select>
          </label>
        </header>

        <section className="codex-session-activity-boundary">
          <Braces size={15} aria-hidden="true" />
          <div>
            <strong>{ui.nativeActivityBoundary}</strong>
            <span>{ui.nativeActivityBoundaryBody}</span>
            <code title={nativeThreadId}>
              {nativeThreadId} · r{historyRevision}
            </code>
          </div>
          <button type="button" onClick={onOpenEnvironmentAudit}>
            <ShieldCheck size={13} aria-hidden="true" />
            {ui.openEnvironmentAudit}
          </button>
        </section>

        {loading ? (
          <div className="codex-session-activity-empty" role="status">
            <LoaderCircle className="spin" size={21} aria-hidden="true" />
            <strong>{ui.loadingSessionActivity}</strong>
            <p>{ui.loadingConversationBody}</p>
          </div>
        ) : error ? (
          <div className="codex-session-activity-empty" role="alert">
            <SearchX size={21} aria-hidden="true" />
            <strong>{ui.nativeRolloutUnavailableTitle}</strong>
            <p>{error}</p>
          </div>
        ) : turns.length === 0 ? (
          <div className="codex-session-activity-empty">
            <SearchX size={21} aria-hidden="true" />
            <strong>
              {summary.total === 0
                ? ui.noSessionActivity
                : ui.noMatchingSessionActivity}
            </strong>
            <p>{ui.sessionActivityEmptyBody}</p>
          </div>
        ) : (
          <div className="codex-session-activity-turns">
            {turns.map((turn) => (
              <section
                className="codex-session-activity-turn"
                key={turn.turnId}
              >
                <header>
                  <div>
                    <span>{ui.activityTurn(turn.ordinal)}</span>
                    <code title={turn.turnId}>{turn.turnId}</code>
                    {turn.prompt ? <strong>{turn.prompt}</strong> : null}
                  </div>
                  <span>{ui.activityRecords(turn.entries.length)}</span>
                  {turn.turn && turn.turn.startedAt > 0 ? (
                    <time
                      dateTime={unixTimestampToIso(turn.turn.startedAt)}
                      title={formatActivityTime(
                        turn.turn.startedAt,
                        language,
                        timeZone,
                      )}
                    >
                      {formatActivityTime(
                        turn.turn.startedAt,
                        language,
                        timeZone,
                      )}
                    </time>
                  ) : null}
                </header>
                <div className="codex-session-activity-records">
                  {turn.entries.map((entry) => (
                    <ActivityEntry
                      entry={entry}
                      key={entry.id}
                      language={language}
                      onOpenFiles={onOpenFiles}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
