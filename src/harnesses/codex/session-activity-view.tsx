"use client";

import {
  ChevronDown,
  LoaderCircle,
  SearchX,
} from "lucide-react";
import { useId, useMemo } from "react";

import {
  CodexCommandActivity,
  CodexFileChangeActivity,
  CodexNativeItemActivity,
  CodexNativeToolActivity,
  CodexRolloutToolCallActivity,
  CodexTurnResult,
} from "./activity";
import type { CodexConversationProjection } from "./events";
import type { CodexRolloutActivityFeed } from "./rollout-activity";
import {
  filterCodexSessionActivityActions,
  projectCodexSessionActivity,
  type CodexSessionActivityFilter,
  type CodexSessionActivityItem,
} from "./session-activity";
import { getCodexUiCopy } from "./ui";
import {
  formatUnixTimestamp,
  unixTimestampToIso,
} from "@/lib/time";
import type { OperationLanguage } from "@/lib/operation-ui";
import { updateLocalUiPreferences } from "@/lib/local-ui-preferences";
import { useLocalUiPreferences } from "@/lib/use-local-ui-preferences";

interface CodexSessionActivityViewProps {
  language: OperationLanguage;
  timeZone: string;
  projection: CodexConversationProjection;
  rolloutActivity?: CodexRolloutActivityFeed;
  loading: boolean;
  error: string;
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
  item,
  language,
  timeZone,
  onOpenFiles,
}: {
  item: CodexSessionActivityItem;
  language: OperationLanguage;
  timeZone: string;
  onOpenFiles: () => void;
}) {
  const { entry } = item;
  const evidence = item.relatedEntries.filter(
    (related) => related.kind === "rolloutToolCall",
  );
  const activity =
    entry.kind === "command" ? (
      <CodexCommandActivity
        activity={entry}
        compact
        evidence={evidence}
        language={language}
      />
    ) : entry.kind === "rolloutToolCall" ? (
      <CodexRolloutToolCallActivity
        activity={entry}
        language={language}
        relatedActivities={evidence}
        timeZone={timeZone}
      />
    ) : entry.kind === "fileChange" ? (
      <CodexFileChangeActivity
        activity={entry}
        compact
        evidence={evidence}
        language={language}
        onOpenFiles={onOpenFiles}
      />
    ) : entry.kind === "nativeItem" ? (
      <CodexNativeItemActivity
        activity={entry}
        compact
        language={language}
      />
    ) : entry.kind === "turnResult" ? (
      <CodexTurnResult result={entry} language={language} />
    ) : (
      <CodexNativeToolActivity activity={entry} compact language={language} />
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
  rolloutActivity,
  loading,
  error,
  onOpenFiles,
}: CodexSessionActivityViewProps) {
  const ui = getCodexUiCopy(language).conversation;
  const headingId = useId();
  const filter = useLocalUiPreferences().filters.codexSessionActivity;
  const presentation = useMemo(
    () => projectCodexSessionActivity(projection, rolloutActivity),
    [projection, rolloutActivity],
  );
  const { summary } = presentation;
  const turns = useMemo(
    () =>
      filterCodexSessionActivityActions(
        presentation.turns,
        filter,
      ),
    [filter, presentation.turns],
  );

  return (
    <section
      className="codex-session-activity-view"
      aria-labelledby={headingId}
    >
      <div className="codex-session-activity-column">
        <header className="codex-session-activity-intro">
          <div>
            <span>{ui.codexNativeActivity}</span>
            <h2 id={headingId}>{ui.sessionActivity}</h2>
            <p aria-live="polite">
              {ui.sessionActivitySummary(
                summary.total,
                summary.records,
                summary.external,
                summary.issues,
              )}
            </p>
          </div>
          <label className="filter-button metrics-range-filter codex-session-activity-filter">
            <span className="sr-only">{ui.sessionActivityFilter}</span>
            <select
              aria-label={ui.sessionActivityFilter}
              value={filter}
              onChange={(event) => {
                const next = event.target.value as CodexSessionActivityFilter;
                updateLocalUiPreferences((current) => ({
                  ...current,
                  filters: {
                    ...current.filters,
                    codexSessionActivity: next,
                  },
                }));
              }}
            >
              <option value="all">{ui.allSessionActivity}</option>
              <option value="issues">
                {ui.issueActivity} ({summary.issues})
              </option>
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
            <ChevronDown size={13} aria-hidden="true" />
          </label>
        </header>

        {rolloutActivity?.error ? (
          <section
            className="codex-session-activity-source-error"
            role={rolloutActivity.availability === "unavailable" ? "alert" : "status"}
          >
            <SearchX size={15} aria-hidden="true" />
            <div>
              <strong>{ui.rolloutActivityIssue}</strong>
              <p>{rolloutActivity.error.message}</p>
              <code>{rolloutActivity.error.code}</code>
            </div>
          </section>
        ) : null}
        {rolloutActivity?.availability === "loading" ? (
          <section
            className="codex-session-activity-source-loading"
            role="status"
          >
            <LoaderCircle className="spin" size={15} aria-hidden="true" />
            <span>{ui.loadingPersistedActivity}</span>
          </section>
        ) : null}

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
                aria-labelledby={`${headingId}-turn-${turn.ordinal}`}
                className="codex-session-activity-turn"
                key={turn.turnId}
              >
                <header>
                  <div>
                    <span title={turn.turnId}>
                      {ui.activityTurn(turn.ordinal)}
                    </span>
                    <h3 id={`${headingId}-turn-${turn.ordinal}`}>
                      {turn.prompt ?? ui.activityTurn(turn.ordinal)}
                    </h3>
                  </div>
                  <span>
                    {ui.activityItems(
                      turn.items.length,
                      turn.nativeRecordCount,
                    )}
                  </span>
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
                  {turn.items.map((item) => (
                    <ActivityEntry
                      item={item}
                      key={item.entry.id}
                      language={language}
                      timeZone={timeZone}
                      onOpenFiles={onOpenFiles}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
