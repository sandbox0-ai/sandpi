"use client";

import {
  Activity,
  Brain,
  Check,
  Flag,
  Gauge,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  CodexBackgroundTerminals,
  CodexHooksInventory,
  CodexMemoriesSettings,
  CodexPersonalitySelection,
  CodexPersonalitySettings,
  CodexTokenUsage,
} from "@/harnesses/codex/native-capabilities";
import {
  codexTokenUsagePoints,
  type CodexTokenUsageView,
} from "@/harnesses/codex/token-usage";
import type { CodexSession } from "@/harnesses/codex/types";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type { OperationLanguage } from "@/lib/operation-ui";

import styles from "./native-command-dialog.module.css";

export type CodexNativeDialogMode =
  | "goal"
  | "hooks"
  | "memories"
  | "personality"
  | "processes"
  | "rename"
  | "usage";

interface CodexNativeCommandDialogProps {
  mode: CodexNativeDialogMode;
  language: OperationLanguage;
  environmentId: string;
  session?: CodexSession;
  initialUsageView?: CodexTokenUsageView;
  editGoalImmediately?: boolean;
  onSessionChange?: (session: CodexSession) => void;
  onClose: () => void;
}

const MODE_META: Record<
  CodexNativeDialogMode,
  { title: string; description: string; icon: typeof Activity }
> = {
  goal: {
    title: "Goal",
    description: "Manage the persisted goal on this native Codex Thread.",
    icon: Flag,
  },
  hooks: {
    title: "Lifecycle hooks",
    description: "Review, trust, enable, or disable hooks discovered by Codex.",
    icon: Webhook,
  },
  memories: {
    title: "Memories",
    description: "Control memory use and future memory generation in this Environment.",
    icon: Brain,
  },
  personality: {
    title: "Personality",
    description: "Choose the response style used by Codex on subsequent Turns.",
    icon: Sparkles,
  },
  processes: {
    title: "Background terminals",
    description: "Native shell processes that outlived their initiating command.",
    icon: SquareTerminal,
  },
  rename: {
    title: "Rename Session",
    description: "Change the Sandpi Session title.",
    icon: SlidersHorizontal,
  },
  usage: {
    title: "Token activity",
    description: "ChatGPT account token activity reported directly by Codex.",
    icon: Gauge,
  },
};

export function CodexNativeCommandDialog({
  mode,
  language,
  environmentId,
  session,
  initialUsageView = "daily",
  editGoalImmediately = false,
  onSessionChange,
  onClose,
}: CodexNativeCommandDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const meta = MODE_META[mode];
  const Icon = meta.icon;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className={styles.header}>
          <span className={styles.headerIcon}>
            <Icon size={18} aria-hidden="true" />
          </span>
          <span className={styles.headerCopy}>
            <strong id={titleId}>{meta.title}</strong>
            <small>{meta.description}</small>
          </span>
          <button
            type="button"
            aria-label={language === "zh-CN" ? "关闭" : "Close"}
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className={styles.body}>
          {mode === "personality" ? (
            <PersonalityPanel
              language={language}
              environmentId={environmentId}
              sessionId={session?.id}
            />
          ) : mode === "usage" ? (
            <UsagePanel
              language={language}
              environmentId={environmentId}
              initialView={initialUsageView}
            />
          ) : mode === "memories" ? (
            <MemoriesPanel
              language={language}
              environmentId={environmentId}
              sessionId={session?.id}
            />
          ) : mode === "hooks" ? (
            <HooksPanel language={language} environmentId={environmentId} />
          ) : mode === "processes" && session ? (
            <ProcessesPanel language={language} sessionId={session.id} />
          ) : mode === "goal" && session ? (
            <GoalPanel
              language={language}
              sessionId={session.id}
              editImmediately={editGoalImmediately}
            />
          ) : mode === "rename" && session ? (
            <RenamePanel
              language={language}
              session={session}
              onSessionChange={onSessionChange}
              onClose={onClose}
            />
          ) : (
            <PanelError
              message={
                language === "zh-CN"
                  ? "此命令需要一个活动 Session。"
                  : "This command requires an active Session."
              }
            />
          )}
        </div>
      </section>
    </div>
  );
}

function PersonalityPanel({
  language,
  environmentId,
  sessionId,
}: {
  language: OperationLanguage;
  environmentId: string;
  sessionId?: string;
}) {
  const [settings, setSettings] = useState<CodexPersonalitySettings>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CodexPersonalitySelection>();
  const [error, setError] = useState("");
  const endpoint = sessionId
    ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/personality`
    : `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/personality`;

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<ApiEnvelope<CodexPersonalitySettings>>(endpoint, {
      signal: controller.signal,
    })
      .then((response) => setSettings(response.data))
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause, "Could not read Codex personality."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint]);

  async function select(personality: CodexPersonalitySelection) {
    if (busy || !settings?.supported) return;
    setBusy(personality);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexPersonalitySettings>>(
        endpoint,
        {
          method: "PUT",
          body: JSON.stringify({ personality }),
        },
      );
      setSettings(response.data);
    } catch (cause) {
      setError(errorMessage(cause, "Could not update Codex personality."));
    } finally {
      setBusy(undefined);
    }
  }

  if (loading) return <PanelLoading label="Loading personality…" />;
  if (error && !settings) return <PanelError message={error} />;
  const choices: Array<{
    id: CodexPersonalitySelection;
    title: string;
    detail: string;
  }> = [
    {
      id: "friendly",
      title: language === "zh-CN" ? "友好" : "Friendly",
      detail:
        language === "zh-CN"
          ? "更温暖、自然，也更愿意解释上下文。"
          : "Warmer, more conversational, and more willing to explain context.",
    },
    {
      id: "pragmatic",
      title: language === "zh-CN" ? "务实" : "Pragmatic",
      detail:
        language === "zh-CN"
          ? "直接、紧凑，优先给出可执行结论。"
          : "Direct and compact, prioritizing actionable outcomes.",
    },
  ];
  return (
    <div className={styles.stack}>
      {!settings?.supported ? (
        <PanelNotice>
          {language === "zh-CN"
            ? "当前模型不支持 personality。请选择支持该能力的 Codex 模型。"
            : "The current model does not support personality. Choose a compatible Codex model first."}
        </PanelNotice>
      ) : null}
      {error ? <PanelError message={error} /> : null}
      <div className={styles.choiceGrid}>
        {choices.map((choice) => (
          <button
            type="button"
            className={
              settings?.personality === choice.id ? styles.selectedChoice : ""
            }
            disabled={Boolean(busy) || !settings?.supported}
            key={choice.id}
            onClick={() => void select(choice.id)}
          >
            <span>
              <strong>{choice.title}</strong>
              <small>{choice.detail}</small>
            </span>
            {busy === choice.id ? (
              <LoaderCircle className={styles.spin} size={17} />
            ) : settings?.personality === choice.id ? (
              <Check size={17} />
            ) : null}
          </button>
        ))}
      </div>
      <PanelFootnote>
        {sessionId
          ? "The choice is saved to Codex config and queued on this loaded Thread."
          : "The choice is saved to this Environment's native Codex config."}
      </PanelFootnote>
    </div>
  );
}

function UsagePanel({
  language,
  environmentId,
  initialView,
}: {
  language: OperationLanguage;
  environmentId: string;
  initialView: CodexTokenUsageView;
}) {
  const [usage, setUsage] = useState<CodexTokenUsage>();
  const [view, setView] = useState(initialView);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexTokenUsage>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/token-usage`,
      );
      setUsage(response.data);
    } catch (cause) {
      setError(errorMessage(cause, "Could not load Codex token activity."));
    } finally {
      setLoading(false);
    }
  }, [environmentId]);

  useEffect(() => void load(), [load]);
  const points = useMemo(
    () => (usage ? codexTokenUsagePoints(usage, view) : []),
    [usage, view],
  );
  const maximum = Math.max(1, ...points.map((point) => point.value));

  if (loading && !usage) return <PanelLoading label="Loading token activity…" />;
  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <div className={styles.segmented} aria-label="Token activity view">
          {(["daily", "weekly", "cumulative"] as const).map((candidate) => (
            <button
              type="button"
              aria-pressed={view === candidate}
              key={candidate}
              onClick={() => setView(candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={language === "zh-CN" ? "刷新用量" : "Refresh usage"}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={loading ? styles.spin : ""} size={16} />
        </button>
      </div>
      {error ? <PanelError message={error} /> : null}
      {usage ? (
        <>
          <div className={styles.summaryGrid}>
            <SummaryMetric
              label={language === "zh-CN" ? "累计" : "Lifetime"}
              value={formatTokens(usage.summary.lifetimeTokens)}
            />
            <SummaryMetric
              label={language === "zh-CN" ? "单日峰值" : "Daily peak"}
              value={formatTokens(usage.summary.peakDailyTokens)}
            />
            <SummaryMetric
              label={language === "zh-CN" ? "连续天数" : "Current streak"}
              value={
                usage.summary.currentStreakDays === null
                  ? "—"
                  : `${usage.summary.currentStreakDays}d`
              }
            />
            <SummaryMetric
              label={language === "zh-CN" ? "最长任务" : "Longest task"}
              value={formatDuration(usage.summary.longestRunningTurnSec)}
            />
          </div>
          {points.length ? (
            <div className={styles.chart} aria-label={`${view} token activity`}>
              {points.map((point) => (
                <span
                  className={styles.barColumn}
                  title={`${point.label}: ${point.value.toLocaleString()} tokens`}
                  key={point.label}
                >
                  <i
                    style={{
                      height: `${Math.max(3, (point.value / maximum) * 100)}%`,
                    }}
                  />
                </span>
              ))}
            </div>
          ) : (
            <PanelEmpty>
              {language === "zh-CN"
                ? "Codex 尚未返回每日 token 活动。"
                : "Codex has not returned daily token activity yet."}
            </PanelEmpty>
          )}
          {points.length ? (
            <div className={styles.chartCaption}>
              <span>{points[0]?.label}</span>
              <span>{points.at(-1)?.label}</span>
            </div>
          ) : null}
        </>
      ) : null}
      <PanelFootnote>
        This is account token activity from <code>account/usage/read</code>, not
        Sandpi Sandbox billing usage.
      </PanelFootnote>
    </div>
  );
}

function MemoriesPanel({
  language,
  environmentId,
  sessionId,
}: {
  language: OperationLanguage;
  environmentId: string;
  sessionId?: string;
}) {
  const [settings, setSettings] = useState<CodexMemoriesSettings>();
  const [draft, setDraft] = useState<CodexMemoriesSettings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const endpoint = sessionId
    ? `/api/v1/sessions/${encodeURIComponent(sessionId)}/memories`
    : `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/memories`;

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<ApiEnvelope<CodexMemoriesSettings>>(endpoint, {
      signal: controller.signal,
    })
      .then((response) => {
        setSettings(response.data);
        setDraft(response.data);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause, "Could not read Codex memories."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint]);

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexMemoriesSettings>>(
        endpoint,
        { method: "PUT", body: JSON.stringify(draft) },
      );
      setSettings(response.data);
      setDraft(response.data);
      setNotice(
        language === "zh-CN"
          ? "Codex 记忆设置已保存。"
          : "Codex memory settings were saved.",
      );
    } catch (cause) {
      setError(errorMessage(cause, "Could not update Codex memories."));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!confirmReset || resetting) return;
    setResetting(true);
    setError("");
    try {
      await apiFetch(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/memories`,
        { method: "DELETE" },
      );
      setConfirmReset(false);
      setNotice(
        language === "zh-CN"
          ? "本环境中的 Codex 本地记忆已清除。"
          : "Local Codex memories were cleared for this Environment.",
      );
    } catch (cause) {
      setError(errorMessage(cause, "Could not reset Codex memories."));
    } finally {
      setResetting(false);
    }
  }

  if (loading) return <PanelLoading label="Loading memory settings…" />;
  if (!draft) return <PanelError message={error || "Memories unavailable."} />;
  const changed = JSON.stringify(settings) !== JSON.stringify(draft);
  return (
    <div className={styles.stack}>
      {error ? <PanelError message={error} /> : null}
      {notice ? <PanelNotice>{notice}</PanelNotice> : null}
      <SettingRow
        title={language === "zh-CN" ? "启用 Memories" : "Enable memories"}
        detail={
          language === "zh-CN"
            ? "启用 Codex memory tool；新 Session 会完整应用此能力。"
            : "Enable the Codex memory tool; new Sessions apply the capability fully."
        }
        checked={draft.featureEnabled}
        onChange={(featureEnabled) =>
          setDraft((current) =>
            current
              ? {
                  ...current,
                  featureEnabled,
                  useMemories: featureEnabled && current.useMemories,
                  generateMemories:
                    featureEnabled && current.generateMemories,
                }
              : current,
          )
        }
      />
      <SettingRow
        title={language === "zh-CN" ? "使用记忆" : "Use memories"}
        detail={
          language === "zh-CN"
            ? "将已整理的记忆作为未来任务的参考上下文。"
            : "Use consolidated memories as reference context for future work."
        }
        checked={draft.useMemories}
        disabled={!draft.featureEnabled}
        onChange={(useMemories) =>
          setDraft((current) =>
            current ? { ...current, useMemories } : current,
          )
        }
      />
      <SettingRow
        title={language === "zh-CN" ? "生成记忆" : "Generate memories"}
        detail={
          language === "zh-CN"
            ? "允许符合条件的 Session 产生新的本地记忆。"
            : "Allow eligible Sessions to produce new local memories."
        }
        checked={draft.generateMemories}
        disabled={!draft.featureEnabled}
        onChange={(generateMemories) =>
          setDraft((current) =>
            current ? { ...current, generateMemories } : current,
          )
        }
      />
      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!changed || saving}
          onClick={() => void save()}
        >
          {saving ? <LoaderCircle className={styles.spin} size={14} /> : null}
          {language === "zh-CN" ? "保存设置" : "Save settings"}
        </button>
        {!confirmReset ? (
          <button
            type="button"
            className={styles.dangerButton}
            onClick={() => setConfirmReset(true)}
          >
            <Trash2 size={14} />
            {language === "zh-CN" ? "重置记忆" : "Reset memories"}
          </button>
        ) : (
          <>
            <span className={styles.confirmText}>
              {language === "zh-CN"
                ? "确认清除所有本地记忆？"
                : "Clear all local memories?"}
            </span>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={resetting}
              onClick={() => void reset()}
            >
              {resetting ? (
                <LoaderCircle className={styles.spin} size={14} />
              ) : null}
              {language === "zh-CN" ? "确认清除" : "Confirm reset"}
            </button>
            <button type="button" onClick={() => setConfirmReset(false)}>
              {language === "zh-CN" ? "取消" : "Cancel"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function HooksPanel({
  language,
  environmentId,
}: {
  language: OperationLanguage;
  environmentId: string;
}) {
  const [inventory, setInventory] = useState<CodexHooksInventory>();
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/hooks`;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response =
        await apiFetch<ApiEnvelope<CodexHooksInventory>>(endpoint);
      setInventory(response.data);
    } catch (cause) {
      setError(errorMessage(cause, "Could not load Codex hooks."));
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => void load(), [load]);

  async function update(
    key: string,
    update: { enabled?: boolean; trustedHash?: string },
  ) {
    if (busyKey) return;
    setBusyKey(key);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexHooksInventory>>(
        endpoint,
        {
          method: "PUT",
          body: JSON.stringify({ key, ...update }),
        },
      );
      setInventory(response.data);
    } catch (cause) {
      setError(errorMessage(cause, "Could not update the Codex hook."));
    } finally {
      setBusyKey("");
    }
  }

  if (loading && !inventory) return <PanelLoading label="Loading hooks…" />;
  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <span>
          {inventory
            ? `${inventory.hooks.length} ${inventory.hooks.length === 1 ? "hook" : "hooks"}`
            : "Hooks"}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={language === "zh-CN" ? "刷新 hooks" : "Refresh hooks"}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={loading ? styles.spin : ""} size={16} />
        </button>
      </div>
      {error ? <PanelError message={error} /> : null}
      {inventory?.warnings.map((warning) => (
        <PanelNotice key={warning}>{warning}</PanelNotice>
      ))}
      {inventory?.errors.map((issue) => (
        <PanelError
          key={`${issue.path ?? ""}:${issue.message}`}
          message={`${issue.message}${issue.path ? ` · ${issue.path}` : ""}`}
        />
      ))}
      {inventory?.hooks.length ? (
        <div className={styles.hookList}>
          {inventory.hooks.map((hook) => {
            const needsTrust =
              hook.trustStatus === "untrusted" ||
              hook.trustStatus === "modified";
            return (
              <article className={styles.hookRow} key={hook.key}>
                <div className={styles.hookMain}>
                  <div className={styles.hookHeading}>
                    <strong>{hook.eventName}</strong>
                    <span>{hook.handlerType}</span>
                    <span data-tone={needsTrust ? "warning" : "neutral"}>
                      {hook.trustStatus}
                    </span>
                  </div>
                  <code>{hook.command ?? hook.key}</code>
                  <small>
                    {[hook.source, hook.matcher, hook.sourcePath]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </div>
                <div className={styles.hookActions}>
                  {needsTrust ? (
                    <button
                      type="button"
                      disabled={Boolean(busyKey) || hook.isManaged}
                      onClick={() =>
                        void update(hook.key, {
                          trustedHash: hook.currentHash,
                        })
                      }
                    >
                      {busyKey === hook.key ? (
                        <LoaderCircle className={styles.spin} size={13} />
                      ) : null}
                      {language === "zh-CN" ? "信任" : "Trust"}
                    </button>
                  ) : null}
                  <NativeSwitch
                    checked={hook.enabled}
                    disabled={
                      Boolean(busyKey) || hook.isManaged || needsTrust
                    }
                    label={`${hook.enabled ? "Disable" : "Enable"} ${hook.eventName}`}
                    onChange={(enabled) =>
                      void update(hook.key, { enabled })
                    }
                  />
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <PanelEmpty>
          {language === "zh-CN"
            ? "当前 Workspace 未发现 Codex hooks。"
            : "No Codex hooks were discovered for this Workspace."}
        </PanelEmpty>
      )}
      <PanelFootnote>
        Unmanaged hook definitions must be trusted at their current hash before
        Codex can run them.
      </PanelFootnote>
    </div>
  );
}

function ProcessesPanel({
  language,
  sessionId,
}: {
  language: OperationLanguage;
  sessionId: string;
}) {
  const [inventory, setInventory] = useState<CodexBackgroundTerminals>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/api/v1/sessions/${encodeURIComponent(sessionId)}/background-terminals`;
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response =
        await apiFetch<ApiEnvelope<CodexBackgroundTerminals>>(endpoint);
      setInventory(response.data);
    } catch (cause) {
      setError(
        errorMessage(cause, "Could not load Codex background terminals."),
      );
    } finally {
      setLoading(false);
    }
  }, [endpoint]);
  useEffect(() => void load(), [load]);

  async function terminate(processId: string) {
    if (busy) return;
    setBusy(processId);
    setError("");
    try {
      await apiFetch(`${endpoint}/${encodeURIComponent(processId)}`, {
        method: "DELETE",
      });
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not stop the background terminal."));
    } finally {
      setBusy("");
    }
  }

  async function clean() {
    if (busy) return;
    setBusy("*");
    setError("");
    try {
      await apiFetch(endpoint, { method: "DELETE" });
      setInventory({ terminals: [] });
    } catch (cause) {
      setError(errorMessage(cause, "Could not stop background terminals."));
    } finally {
      setBusy("");
    }
  }

  if (loading && !inventory) {
    return <PanelLoading label="Loading background terminals…" />;
  }
  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <span>
          {inventory?.terminals.length ?? 0}{" "}
          {language === "zh-CN" ? "个后台终端" : "background terminals"}
        </span>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={language === "zh-CN" ? "刷新" : "Refresh"}
            disabled={loading || Boolean(busy)}
            onClick={() => void load()}
          >
            <RefreshCw className={loading ? styles.spin : ""} size={16} />
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            disabled={!inventory?.terminals.length || Boolean(busy)}
            onClick={() => void clean()}
          >
            {busy === "*" ? (
              <LoaderCircle className={styles.spin} size={13} />
            ) : (
              <Trash2 size={13} />
            )}
            {language === "zh-CN" ? "全部停止" : "Stop all"}
          </button>
        </div>
      </div>
      {error ? <PanelError message={error} /> : null}
      {inventory?.terminals.length ? (
        <div className={styles.processList}>
          {inventory.terminals.map((terminal) => (
            <article className={styles.processRow} key={terminal.processId}>
              <span className={styles.processId}>{terminal.processId}</span>
              <div>
                <code>{terminal.command}</code>
                <small>
                  {terminal.cwd}
                  {terminal.osPid !== null ? ` · PID ${terminal.osPid}` : ""}
                  {terminal.cpuPercent !== null
                    ? ` · ${terminal.cpuPercent.toFixed(1)}% CPU`
                    : ""}
                  {terminal.rssKb !== null
                    ? ` · ${formatBytes(terminal.rssKb * 1024)}`
                    : ""}
                </small>
              </div>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void terminate(terminal.processId)}
              >
                {busy === terminal.processId ? (
                  <LoaderCircle className={styles.spin} size={13} />
                ) : null}
                {language === "zh-CN" ? "停止" : "Stop"}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <PanelEmpty>
          {language === "zh-CN"
            ? "当前 Thread 没有后台终端。"
            : "This Thread has no background terminals."}
        </PanelEmpty>
      )}
    </div>
  );
}

interface GoalProjection {
  goal: {
    objective: string;
    status: string;
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
  } | null;
}

function GoalPanel({
  language,
  sessionId,
  editImmediately,
}: {
  language: OperationLanguage;
  sessionId: string;
  editImmediately: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [projection, setProjection] = useState<GoalProjection>();
  const [objective, setObjective] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`;
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<ApiEnvelope<GoalProjection>>(endpoint, {
      signal: controller.signal,
    })
      .then((response) => {
        setProjection(response.data);
        setObjective(response.data.goal?.objective ?? "");
        if (editImmediately) {
          window.requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
          });
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause, "Could not load the Codex goal."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [editImmediately, endpoint]);

  async function update(
    body: { objective?: string; status?: "active" | "paused" },
    action: string,
  ) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<GoalProjection>>(endpoint, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setProjection(response.data);
      setObjective(response.data.goal?.objective ?? "");
    } catch (cause) {
      setError(errorMessage(cause, "Could not update the Codex goal."));
    } finally {
      setBusy("");
    }
  }

  async function clear() {
    if (busy) return;
    setBusy("clear");
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<GoalProjection>>(endpoint, {
        method: "DELETE",
      });
      setProjection(response.data);
      setObjective("");
    } catch (cause) {
      setError(errorMessage(cause, "Could not clear the Codex goal."));
    } finally {
      setBusy("");
    }
  }

  if (loading) return <PanelLoading label="Loading goal…" />;
  return (
    <div className={styles.stack}>
      {error ? <PanelError message={error} /> : null}
      {projection?.goal ? (
        <div className={styles.goalStatus}>
          <span data-status={projection.goal.status}>
            {projection.goal.status}
          </span>
          <small>
            {projection.goal.tokenBudget === null
              ? `${projection.goal.tokensUsed.toLocaleString()} tokens`
              : `${projection.goal.tokensUsed.toLocaleString()} / ${projection.goal.tokenBudget.toLocaleString()} tokens`}
            {" · "}
            {formatDuration(projection.goal.timeUsedSeconds)}
          </small>
        </div>
      ) : (
        <PanelNotice>
          {language === "zh-CN"
            ? "当前 Thread 还没有目标。"
            : "This Thread does not have a goal yet."}
        </PanelNotice>
      )}
      <label className={styles.field}>
        <span>{language === "zh-CN" ? "目标" : "Objective"}</span>
        <textarea
          ref={inputRef}
          rows={5}
          maxLength={10_000}
          value={objective}
          placeholder={
            language === "zh-CN"
              ? "描述需要持续推进的目标…"
              : "Describe the objective Codex should keep pursuing…"
          }
          onChange={(event) => setObjective(event.target.value)}
        />
      </label>
      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!objective.trim() || Boolean(busy)}
          onClick={() =>
            void update({ objective: objective.trim() }, "objective")
          }
        >
          {busy === "objective" ? (
            <LoaderCircle className={styles.spin} size={14} />
          ) : null}
          {projection?.goal
            ? language === "zh-CN"
              ? "保存目标"
              : "Save objective"
            : language === "zh-CN"
              ? "创建目标"
              : "Create goal"}
        </button>
        {projection?.goal ? (
          <>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void update(
                  {
                    status:
                      projection.goal?.status === "active"
                        ? "paused"
                        : "active",
                  },
                  "status",
                )
              }
            >
              {busy === "status" ? (
                <LoaderCircle className={styles.spin} size={14} />
              ) : null}
              {projection.goal.status === "active"
                ? language === "zh-CN"
                  ? "暂停"
                  : "Pause"
                : language === "zh-CN"
                  ? "恢复"
                  : "Resume"}
            </button>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={Boolean(busy)}
              onClick={() => void clear()}
            >
              {busy === "clear" ? (
                <LoaderCircle className={styles.spin} size={14} />
              ) : (
                <Trash2 size={14} />
              )}
              {language === "zh-CN" ? "清除" : "Clear"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function RenamePanel({
  language,
  session,
  onSessionChange,
  onClose,
}: {
  language: OperationLanguage;
  session: CodexSession;
  onSessionChange?: (session: CodexSession) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function save() {
    const normalized = name.trim();
    if (!normalized || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexSession>>(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/metadata`,
        {
          method: "PUT",
          body: JSON.stringify({ title: normalized }),
        },
      );
      onSessionChange?.(response.data);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Could not rename the Session."));
      setSaving(false);
    }
  }

  return (
    <form
      className={styles.stack}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {error ? <PanelError message={error} /> : null}
      <label className={styles.field}>
        <span>{language === "zh-CN" ? "Session 名称" : "Session name"}</span>
        <input
          ref={inputRef}
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className={styles.actionRow}>
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={!name.trim() || saving}
        >
          {saving ? <LoaderCircle className={styles.spin} size={14} /> : null}
          {language === "zh-CN" ? "保存" : "Save"}
        </button>
        <button type="button" onClick={onClose}>
          {language === "zh-CN" ? "取消" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

function SettingRow({
  title,
  detail,
  checked,
  disabled = false,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={styles.settingRow}>
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <NativeSwitch
        checked={checked}
        disabled={disabled}
        label={title}
        onChange={onChange}
      />
    </div>
  );
}

function NativeSwitch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={styles.switch}
      data-checked={checked ? "true" : "false"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.summaryMetric}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div className={styles.loading} role="status">
      <LoaderCircle className={styles.spin} size={18} />
      <span>{label}</span>
    </div>
  );
}

function PanelError({ message }: { message: string }) {
  return (
    <div className={styles.error} role="alert">
      {message}
    </div>
  );
}

function PanelNotice({ children }: { children: ReactNode }) {
  return <div className={styles.notice}>{children}</div>;
}

function PanelEmpty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

function PanelFootnote({ children }: { children: ReactNode }) {
  return <p className={styles.footnote}>{children}</p>;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatTokens(value: number | null) {
  if (value === null) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  const hours = Math.floor(value / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(value / 1024)} KiB`;
}
