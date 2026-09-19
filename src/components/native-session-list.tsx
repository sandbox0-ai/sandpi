"use client";

import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAlertDialog } from "@/components/alert-dialog";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type {
  NativeAgentSession,
  NativeAgentSessionIndex,
} from "@/lib/native-agent-sessions";
import type { OperationLanguage } from "@/lib/operation-ui";
import styles from "./environment-sidebar.module.css";

export function NativeSessionList({
  environmentId,
  selected,
  language,
  onOpen,
  onLaunchChange,
}: {
  environmentId: string;
  selected: boolean;
  language: OperationLanguage;
  onOpen: (environmentId: string) => void;
  onLaunchChange: (environmentId: string, launchId: string) => void;
}) {
  const { confirm } = useAlertDialog();
  const zh = language === "zh-CN";
  const [index, setIndex] = useState<NativeAgentSessionIndex>();
  const [collapsed, setCollapsed] = useState(false);
  const [count, setCount] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const sequence = useRef(0);
  const refreshing = useRef(false);
  const base = `/api/v1/environments/${encodeURIComponent(environmentId)}/native-sessions`;
  const apply = useCallback(
    (next: NativeAgentSessionIndex) => {
      setIndex(next);
      onLaunchChange(environmentId, next.launchId);
    },
    [environmentId, onLaunchChange],
  );
  const load = useCallback(
    async (refresh = false) => {
      if (refreshing.current) return;
      refreshing.current = true;
      const version = ++sequence.current;
      try {
        const response = await apiFetch<ApiEnvelope<NativeAgentSessionIndex>>(
          refresh ? `${base}/refresh` : base,
          refresh ? { method: "POST" } : undefined,
        );
        if (mounted.current && sequence.current === version) {
          apply(response.data);
          setError("");
        }
      } catch (e) {
        if (mounted.current && sequence.current === version)
          setError(e instanceof Error ? e.message : "Unable to load sessions");
      } finally {
        refreshing.current = false;
      }
    },
    [base, apply],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    const invalidate = () => {
      mounted.current = false;
      sequence.current++;
    };
    return invalidate;
  }, [load]);
  useEffect(() => {
    if (!selected || busy) return;
    // Read only persisted metadata for background Environments. Scans run only
    // for the visible terminal and never require opening a second Agent.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 30000);
    const first = window.setTimeout(() => void load(true), 1500);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [selected, load, busy]);
  const open = async (session: NativeAgentSession | null) => {
    if (!index || busy) return;
    setBusy(true);
    setError("");
    sequence.current++;
    const expectedLaunchId = index.launchId;
    try {
      const accepted = await confirm({
        title: session
          ? zh
            ? "恢复会话"
            : "Resume session"
          : zh
            ? "新建会话"
            : "New session",
        description:
          (session ? `${session.title}\n\n` : "") +
          (zh
            ? "这会停止此环境当前的 Agent 进程，中断尚未完成的工作，然后打开所选会话。已保存的历史和工作区文件会保留。其他设备也会连接到新会话。"
            : "This stops the current Agent process in this Environment, interrupting unfinished work, then opens the selected session. Saved history and workspace files are retained. Other devices will also connect to the new session."),
        actionLabel: zh ? "停止并打开" : "Stop and open",
        cancelLabel: zh ? "取消" : "Cancel",
        tone: "warning",
      });
      if (!accepted || !mounted.current) return;
      const response = await apiFetch<ApiEnvelope<NativeAgentSessionIndex>>(
        `${base}/selection`,
        {
          method: "PUT",
          body: JSON.stringify({
            sessionId: session?.id ?? null,
            expectedLaunchId,
            requestId: crypto.randomUUID(),
            confirmReplace: true,
          }),
        },
      );
      if (!mounted.current) return;
      apply(response.data);
      onOpen(environmentId);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "Unable to open session");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className={styles.sessions}>
      <div className={styles.sessionToolbar}>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          {zh ? "会话" : "Sessions"}
          {index ? ` (${index.sessions.length})` : ""}
        </button>
        <button
          type="button"
          aria-label={zh ? "刷新会话" : "Refresh sessions"}
          disabled={busy}
          onClick={() => void load(true)}
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          aria-label={zh ? "新建会话" : "New session"}
          disabled={!index || busy}
          onClick={() => void open(null)}
        >
          <Plus size={13} />
        </button>
      </div>
      {!collapsed && (
        <>
          {!index && !error && (
            <p className={styles.sessionHint}>{zh ? "加载中…" : "Loading…"}</p>
          )}
          {index?.sessions.slice(0, count).map((session) => (
            <button
              key={session.id}
              type="button"
              className={`${styles.sessionButton} ${selected && index.openedSessionId === session.id ? styles.sessionSelected : ""}`}
              title={session.title}
              aria-current={
                selected && index.openedSessionId === session.id
                  ? "page"
                  : undefined
              }
              disabled={busy}
              onClick={() => void open(session)}
            >
              <MessageSquare size={12} aria-hidden="true" />
              <span>{session.title}</span>
            </button>
          ))}
          {index && index.sessions.length === 0 && (
            <p className={styles.sessionHint}>
              {zh ? "暂无已索引会话" : "No indexed sessions yet"}
            </p>
          )}
          {index && count < index.sessions.length && (
            <button
              className={styles.sessionMore}
              type="button"
              onClick={() => setCount((n) => n + 10)}
            >
              {zh ? "显示更多" : "Show more"}
            </button>
          )}
          {index?.partial && (
            <p className={styles.sessionHint}>
              {zh ? "仅显示可读取的近期历史" : "Recent readable history only"}
            </p>
          )}
          {index && !index.syncedAt && (
            <p className={styles.sessionHint}>
              {zh
                ? "环境运行时可刷新历史"
                : "Refresh history while the Environment is running"}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className={styles.sessionError}>
          {error}
        </p>
      )}
    </div>
  );
}
