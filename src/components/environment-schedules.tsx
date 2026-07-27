"use client";

import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Clock3,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type { OperationLanguage } from "@/lib/operation-ui";
import {
  dateFromUnixTimestamp,
  formatUnixTimestamp,
  resolveTimeZone,
} from "@/lib/time";
import type {
  CodingSession,
  EnvironmentSchedule,
  EnvironmentScheduleRun,
} from "@/lib/types";
import styles from "./environment-schedules.module.css";

interface EnvironmentSchedulesProps {
  environmentId: string;
  sessions: CodingSession[];
  language: OperationLanguage;
  timeZone: string;
}

interface ScheduleDraft {
  id?: string;
  name: string;
  prompt: string;
  timingKind: "once" | "cron";
  runAt: string;
  cronExpression: string;
  timeZone: string;
  targetKind: "newSession" | "session";
  targetSessionId: string;
  title: string;
  enabled: boolean;
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
}

const REFRESH_INTERVAL_MS = 10_000;

export function EnvironmentSchedules({
  environmentId,
  sessions,
  language,
  timeZone,
}: EnvironmentSchedulesProps) {
  const [schedules, setSchedules] = useState<EnvironmentSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyScheduleId, setBusyScheduleId] = useState<string>();
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string>();
  const [historyScheduleId, setHistoryScheduleId] = useState<string>();
  const [runs, setRuns] = useState<
    Record<string, EnvironmentScheduleRun[]>
  >({});
  const [runsLoadingId, setRunsLoadingId] = useState<string>();
  const availableSessions = useMemo(
    () =>
      sessions
        .filter((session) => !session.archived)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions],
  );

  const loadSchedules = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const response = await apiFetch<ApiEnvelope<EnvironmentSchedule[]>>(
          scheduleCollectionPath(environmentId),
        );
        setSchedules(response.data);
        setLoadError("");
      } catch (error) {
        setLoadError(errorMessage(error, "Schedules could not be loaded."));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [environmentId],
  );

  const loadRuns = useCallback(
    async (scheduleId: string, quiet = false) => {
      if (!quiet) setRunsLoadingId(scheduleId);
      try {
        const response = await apiFetch<
          ApiEnvelope<EnvironmentScheduleRun[]>
        >(`${schedulePath(environmentId, scheduleId)}/runs?limit=20`);
        setRuns((current) => ({
          ...current,
          [scheduleId]: response.data,
        }));
        setLoadError("");
      } catch (error) {
        setLoadError(errorMessage(error, "Schedule runs could not be loaded."));
      } finally {
        if (!quiet) setRunsLoadingId(undefined);
      }
    },
    [environmentId],
  );

  useEffect(() => {
    setSchedules([]);
    setDraft(null);
    setHistoryScheduleId(undefined);
    setRuns({});
    void loadSchedules();
    const timer = window.setInterval(() => {
      void loadSchedules(true);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [environmentId, loadSchedules]);

  useEffect(() => {
    if (!historyScheduleId) return;
    const timer = window.setInterval(
      () => void loadRuns(historyScheduleId, true),
      REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [historyScheduleId, loadRuns]);

  async function saveDraft() {
    if (!draft || saving) return;
    setFormError("");
    const payload = draftPayload(draft);
    if ("error" in payload) {
      setFormError(payload.error);
      return;
    }
    setSaving(true);
    try {
      const path = draft.id
        ? schedulePath(environmentId, draft.id)
        : scheduleCollectionPath(environmentId);
      await apiFetch<ApiEnvelope<EnvironmentSchedule>>(path, {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify(payload.value),
      });
      setDraft(null);
      await loadSchedules(true);
    } catch (error) {
      setFormError(errorMessage(error, "The Schedule could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  async function toggleSchedule(schedule: EnvironmentSchedule) {
    if (busyScheduleId) return;
    setBusyScheduleId(schedule.id);
    setLoadError("");
    try {
      await apiFetch<ApiEnvelope<EnvironmentSchedule>>(
        schedulePath(environmentId, schedule.id),
        {
          method: "PUT",
          body: JSON.stringify({
            ...editableSchedulePayload(schedule),
            enabled: !schedule.enabled,
          }),
        },
      );
      await loadSchedules(true);
    } catch (error) {
      setLoadError(errorMessage(error, "The Schedule could not be updated."));
    } finally {
      setBusyScheduleId(undefined);
    }
  }

  async function deleteSchedule(scheduleId: string) {
    if (busyScheduleId) return;
    setBusyScheduleId(scheduleId);
    setLoadError("");
    try {
      await apiFetch<ApiEnvelope<{ id: string }>>(
        schedulePath(environmentId, scheduleId),
        { method: "DELETE" },
      );
      setConfirmingDeleteId(undefined);
      setHistoryScheduleId((current) =>
        current === scheduleId ? undefined : current,
      );
      await loadSchedules(true);
    } catch (error) {
      setLoadError(errorMessage(error, "The Schedule could not be deleted."));
    } finally {
      setBusyScheduleId(undefined);
    }
  }

  return (
    <div className="codex-extension-panel">
      <div className="codex-extension-toolbar">
        <p>
          Sandpi persists each occurrence before waking the Environment. Missed
          cron intervals are coalesced, and overlapping runs are recorded as
          skipped.
        </p>
        <div>
          <button
            type="button"
            className="secondary-action-button"
            onClick={() => {
              setDraft(emptyDraft(timeZone, availableSessions[0]?.id));
              setFormError("");
            }}
          >
            <Plus size={13} aria-hidden="true" />
            New Schedule
          </button>
        </div>
      </div>

      {loadError ? (
        <p className="settings-inline-error" role="alert">
          {loadError}
        </p>
      ) : null}

      {draft ? (
        <ScheduleEditor
          draft={draft}
          sessions={availableSessions}
          saving={saving}
          error={formError}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setFormError("");
          }}
          onSave={() => void saveDraft()}
        />
      ) : null}

      {loading ? (
        <div
          className="codex-extension-empty"
          aria-label="Loading Schedules"
        >
          <span>
            <CalendarClock size={18} aria-hidden="true" />
          </span>
          <strong>Loading Schedules…</strong>
        </div>
      ) : schedules.length === 0 ? (
        <div className="codex-extension-empty">
          <span>
            <CalendarClock size={18} aria-hidden="true" />
          </span>
          <strong>No Schedules yet</strong>
          <p>
            Create a one-time or recurring Codex task for this Environment.
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {schedules.map((schedule) => {
            const historyOpen = historyScheduleId === schedule.id;
            const oneTimeExpired =
              schedule.timing.kind === "once" &&
              schedule.timing.runAt <= Date.now() / 1_000;
            return (
              <article className={styles.card} key={schedule.id}>
                <div className={styles.cardHeader}>
                  <div className={styles.cardTitle}>
                    <span
                      className={`${styles.statusDot} ${
                        schedule.enabled ? styles.enabled : ""
                      }`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{schedule.name}</strong>
                      <span>
                        {schedule.timing.kind === "once"
                          ? `Once · ${formatTime(
                              schedule.timing.runAt,
                              language,
                              timeZone,
                            )}`
                          : `${schedule.timing.expression} · ${schedule.timing.timeZone}`}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`${styles.badge} ${
                      schedule.enabled ? styles.badgeEnabled : ""
                    }`}
                  >
                    {schedule.enabled
                      ? "Enabled"
                      : oneTimeExpired
                        ? "Completed"
                        : "Disabled"}
                  </span>
                </div>

                <p className={styles.prompt}>{schedule.prompt}</p>

                <dl className={styles.facts}>
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {schedule.target.kind === "newSession"
                        ? "New Session per run"
                        : sessionLabel(
                            availableSessions,
                            schedule.target.sessionId,
                          )}
                    </dd>
                  </div>
                  <div>
                    <dt>Next</dt>
                    <dd>
                      {schedule.nextRunAt
                        ? formatTime(
                            schedule.nextRunAt,
                            language,
                            timeZone,
                          )
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Last run</dt>
                    <dd className={statusClassName(schedule.lastRunStatus)}>
                      {schedule.lastRunStatus ?? "—"}
                    </dd>
                  </div>
                </dl>

                {schedule.lastError ? (
                  <p className={styles.runError}>{schedule.lastError}</p>
                ) : null}

                <div className={styles.actions}>
                  <button
                    type="button"
                    className="text-action-button"
                    onClick={() => {
                      if (historyOpen) {
                        setHistoryScheduleId(undefined);
                      } else {
                        setHistoryScheduleId(schedule.id);
                        void loadRuns(schedule.id);
                      }
                    }}
                  >
                    {historyOpen ? (
                      <ChevronUp size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                    Runs
                  </button>
                  <button
                    type="button"
                    className="text-action-button"
                    onClick={() => {
                      setDraft(scheduleDraft(schedule));
                      setFormError("");
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-action-button"
                    disabled={Boolean(busyScheduleId) || oneTimeExpired}
                    onClick={() => void toggleSchedule(schedule)}
                  >
                    {busyScheduleId === schedule.id
                      ? "Saving…"
                      : schedule.enabled
                        ? "Disable"
                        : "Enable"}
                  </button>
                  {confirmingDeleteId === schedule.id ? (
                    <>
                      <span className={styles.deletePrompt}>
                        Delete permanently?
                      </span>
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={Boolean(busyScheduleId)}
                        onClick={() => void deleteSchedule(schedule.id)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="text-action-button"
                        onClick={() => setConfirmingDeleteId(undefined)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="text-action-button"
                      aria-label={`Delete ${schedule.name}`}
                      onClick={() => setConfirmingDeleteId(schedule.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                {historyOpen ? (
                  <ScheduleRunHistory
                    runs={runs[schedule.id]}
                    loading={runsLoadingId === schedule.id}
                    language={language}
                    timeZone={timeZone}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ScheduleEditor({
  draft,
  sessions,
  saving,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ScheduleDraft;
  sessions: CodingSession[];
  saving: boolean;
  error: string;
  onChange: (draft: ScheduleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <section
      className="environment-credential-editor"
      aria-labelledby="environment-schedule-editor-title"
    >
      <header>
        <div>
          <span>{draft.id ? "Edit Automation" : "New Automation"}</span>
          <strong id="environment-schedule-editor-title">
            {draft.id ? draft.name : "Schedule a Codex task"}
          </strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close Schedule editor"
          disabled={saving}
          onClick={onCancel}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="field-grid two-columns">
        <label>
          Name
          <input
            autoComplete="off"
            maxLength={80}
            value={draft.name}
            onChange={(event) =>
              onChange({ ...draft, name: event.target.value })
            }
          />
        </label>
        <label>
          <span className={styles.fieldHeading}>
            Session title <small>optional</small>
          </span>
          <input
            autoComplete="off"
            maxLength={200}
            placeholder={draft.name || "Scheduled task"}
            value={draft.title}
            onChange={(event) =>
              onChange({ ...draft, title: event.target.value })
            }
          />
        </label>
      </div>

      <label className="full-field">
        Prompt
        <textarea
          className={styles.promptInput}
          maxLength={100_000}
          rows={8}
          placeholder="Describe the complete task, expected checks, and desired output."
          value={draft.prompt}
          onChange={(event) =>
            onChange({ ...draft, prompt: event.target.value })
          }
        />
        <small className={styles.characterCount}>
          {draft.prompt.length.toLocaleString()} / 100,000
        </small>
      </label>

      <fieldset
        className={`environment-credential-locations ${styles.choiceField}`}
      >
        <legend>Timing</legend>
        <label>
          <input
            type="radio"
            name="schedule-timing"
            checked={draft.timingKind === "once"}
            onChange={() => onChange({ ...draft, timingKind: "once" })}
          />
          Once
        </label>
        <label>
          <input
            type="radio"
            name="schedule-timing"
            checked={draft.timingKind === "cron"}
            onChange={() => onChange({ ...draft, timingKind: "cron" })}
          />
          Recurring cron
        </label>
      </fieldset>

      {draft.timingKind === "once" ? (
        <label className="full-field">
          <span className={styles.fieldHeading}>
            Run at <small>browser local time</small>
          </span>
          <input
            type="datetime-local"
            value={draft.runAt}
            onChange={(event) =>
              onChange({ ...draft, runAt: event.target.value })
            }
          />
        </label>
      ) : (
        <div className="field-grid two-columns">
          <label>
            Five-field cron
            <input
              autoComplete="off"
              placeholder="0 9 * * 1-5"
              value={draft.cronExpression}
              onChange={(event) =>
                onChange({ ...draft, cronExpression: event.target.value })
              }
            />
          </label>
          <label>
            IANA time zone
            <input
              autoComplete="off"
              placeholder="UTC"
              value={draft.timeZone}
              onChange={(event) =>
                onChange({ ...draft, timeZone: event.target.value })
              }
            />
          </label>
        </div>
      )}

      <fieldset
        className={`environment-credential-locations ${styles.choiceField}`}
      >
        <legend>Run in</legend>
        <label>
          <input
            type="radio"
            name="schedule-target"
            checked={draft.targetKind === "newSession"}
            onChange={() => onChange({ ...draft, targetKind: "newSession" })}
          />
          A new Session each time
        </label>
        <label>
          <input
            type="radio"
            name="schedule-target"
            checked={draft.targetKind === "session"}
            disabled={sessions.length === 0}
            onChange={() =>
              onChange({
                ...draft,
                targetKind: "session",
                targetSessionId: draft.targetSessionId || sessions[0]?.id || "",
              })
            }
          />
          An existing Session
        </label>
      </fieldset>

      {draft.targetKind === "session" ? (
        <label className="full-field">
          Target Session
          <select
            value={draft.targetSessionId}
            onChange={(event) =>
              onChange({ ...draft, targetSessionId: event.target.value })
            }
          >
            {sessions.map((session) => (
              <option value={session.id} key={session.id}>
                {session.title}
              </option>
            ))}
          </select>
          <small>
            If this Session is busy at an occurrence, that occurrence is
            skipped.
          </small>
        </label>
      ) : null}

      <label className={styles.enabledField}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) =>
            onChange({ ...draft, enabled: event.target.checked })
          }
        />
        Enable immediately
      </label>

      {error ? (
        <p className="settings-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      <footer>
        <button
          type="button"
          className="button-secondary"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={saving || !draft.name.trim() || !draft.prompt.trim()}
          onClick={onSave}
        >
          {saving ? "Saving…" : draft.id ? "Save Schedule" : "Create Schedule"}
        </button>
      </footer>
    </section>
  );
}

function ScheduleRunHistory({
  runs,
  loading,
  language,
  timeZone,
}: {
  runs: EnvironmentScheduleRun[] | undefined;
  loading: boolean;
  language: OperationLanguage;
  timeZone: string;
}) {
  if (loading && !runs) {
    return (
      <div className={`${styles.history} ${styles.historyEmpty}`}>
        Loading run history…
      </div>
    );
  }
  if (!runs?.length) {
    return (
      <div className={`${styles.history} ${styles.historyEmpty}`}>
        No occurrences recorded yet.
      </div>
    );
  }
  return (
    <div className={styles.history}>
      {runs.map((run) => (
        <div className={styles.run} key={run.id}>
          <Clock3 size={14} aria-hidden="true" />
          <div>
            <strong className={statusClassName(run.status)}>
              {run.status}
            </strong>
            <span>
              {formatTime(run.scheduledFor, language, timeZone)}
              {run.sessionId ? ` · Session ${shortId(run.sessionId)}` : ""}
            </span>
            {run.error ? <small>{run.error}</small> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function emptyDraft(
  timeZone: string,
  firstSessionId: string | undefined,
): ScheduleDraft {
  return {
    name: "",
    prompt: "",
    timingKind: "once",
    runAt: localDateTimeInput(new Date(Date.now() + 60 * 60 * 1_000)),
    cronExpression: "0 9 * * 1-5",
    timeZone: resolveTimeZone(timeZone),
    targetKind: "newSession",
    targetSessionId: firstSessionId ?? "",
    title: "",
    enabled: true,
  };
}

function scheduleDraft(schedule: EnvironmentSchedule): ScheduleDraft {
  return {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
    timingKind: schedule.timing.kind,
    runAt:
      schedule.timing.kind === "once"
        ? localDateTimeInput(dateFromUnixTimestamp(schedule.timing.runAt))
        : localDateTimeInput(new Date(Date.now() + 60 * 60 * 1_000)),
    cronExpression:
      schedule.timing.kind === "cron" ? schedule.timing.expression : "0 9 * * 1-5",
    timeZone:
      schedule.timing.kind === "cron" ? schedule.timing.timeZone : "UTC",
    targetKind: schedule.target.kind,
    targetSessionId:
      schedule.target.kind === "session" ? schedule.target.sessionId : "",
    title: schedule.title ?? "",
    enabled: schedule.enabled,
    ...(schedule.modelId ? { modelId: schedule.modelId } : {}),
    ...(schedule.reasoningEffort
      ? { reasoningEffort: schedule.reasoningEffort }
      : {}),
    ...(schedule.collaborationMode
      ? { collaborationMode: schedule.collaborationMode }
      : {}),
    ...(schedule.serviceTier ? { serviceTier: schedule.serviceTier } : {}),
  };
}

function draftPayload(
  draft: ScheduleDraft,
):
  | { error: string }
  | { value: ReturnType<typeof editableSchedulePayload> } {
  if (!draft.name.trim()) return { error: "Schedule name is required." };
  if (!draft.prompt.trim()) return { error: "Prompt is required." };
  let timing: EnvironmentSchedule["timing"];
  if (draft.timingKind === "once") {
    const runAtMilliseconds = new Date(draft.runAt).getTime();
    if (
      !Number.isFinite(runAtMilliseconds) ||
      runAtMilliseconds <= Date.now()
    ) {
      return { error: "Choose a future one-time execution time." };
    }
    timing = { kind: "once", runAt: runAtMilliseconds / 1_000 };
  } else {
    if (!draft.cronExpression.trim()) {
      return { error: "A five-field cron expression is required." };
    }
    if (!draft.timeZone.trim()) {
      return { error: "An IANA time zone is required." };
    }
    timing = {
      kind: "cron",
      expression: draft.cronExpression.trim(),
      timeZone: draft.timeZone.trim(),
    };
  }
  if (draft.targetKind === "session" && !draft.targetSessionId) {
    return { error: "Choose a target Session." };
  }
  return {
    value: {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      timing,
      target:
        draft.targetKind === "newSession"
          ? { kind: "newSession" as const }
          : {
              kind: "session" as const,
              sessionId: draft.targetSessionId,
            },
      overlapPolicy: "skip" as const,
      enabled: draft.enabled,
      ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
      ...(draft.modelId ? { modelId: draft.modelId } : {}),
      ...(draft.reasoningEffort
        ? { reasoningEffort: draft.reasoningEffort }
        : {}),
      ...(draft.collaborationMode
        ? { collaborationMode: draft.collaborationMode }
        : {}),
      ...(draft.serviceTier ? { serviceTier: draft.serviceTier } : {}),
    },
  };
}

function editableSchedulePayload(
  schedule: EnvironmentSchedule,
  overrides: { enabled?: boolean } = {},
) {
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    timing: schedule.timing,
    target: schedule.target,
    overlapPolicy: "skip" as const,
    enabled: overrides.enabled ?? schedule.enabled,
    ...(schedule.title ? { title: schedule.title } : {}),
    ...(schedule.modelId ? { modelId: schedule.modelId } : {}),
    ...(schedule.reasoningEffort
      ? { reasoningEffort: schedule.reasoningEffort }
      : {}),
    ...(schedule.collaborationMode
      ? { collaborationMode: schedule.collaborationMode }
      : {}),
    ...(schedule.serviceTier ? { serviceTier: schedule.serviceTier } : {}),
  };
}

function localDateTimeInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatTime(
  timestamp: number,
  language: OperationLanguage,
  timeZone: string,
) {
  return formatUnixTimestamp(timestamp, language, timeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function scheduleCollectionPath(environmentId: string) {
  return `/api/v1/environments/${encodeURIComponent(environmentId)}/schedules`;
}

function schedulePath(environmentId: string, scheduleId: string) {
  return `${scheduleCollectionPath(environmentId)}/${encodeURIComponent(
    scheduleId,
  )}`;
}

function sessionLabel(sessions: CodingSession[], sessionId: string) {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  return session?.title ?? `Session ${shortId(sessionId)}`;
}

function shortId(value: string) {
  return value.length <= 12 ? value : value.slice(-8);
}

function statusClassName(status: string | undefined) {
  if (status === "succeeded") return styles.success;
  if (status === "failed") return styles.failure;
  if (status === "skipped") return styles.skipped;
  return "";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
