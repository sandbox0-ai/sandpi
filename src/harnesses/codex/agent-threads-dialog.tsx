"use client";

import Image from "next/image";
import {
  Bot,
  LoaderCircle,
  RefreshCw,
  UsersRound,
  X,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { MarkdownContent } from "@/components/markdown-content";
import {
  CodexCommandActivity,
  CodexFileChangeActivity,
  CodexNativeItemActivity,
  CodexNativeToolActivity,
  CodexTurnActivity,
  CodexTurnResult,
} from "@/harnesses/codex/activity";
import {
  codexAgentThreadName,
  codexAgentThreadRows,
} from "@/harnesses/codex/agent-threads";
import {
  projectCodexTimeline,
  type CodexTimelineEntry,
} from "@/harnesses/codex/events";
import {
  groupCodexTimelineByTurn,
  type CodexTurnTimelineGroup,
} from "@/harnesses/codex/timeline";
import type {
  CodexAgentThreads,
  CodexThread,
} from "@/harnesses/codex/types";
import { formatUnixTimestamp } from "@/lib/time";
import {
  apiFetch,
  type ApiEnvelope,
} from "@/lib/api-client";
import type { OperationLanguage } from "@/lib/operation-ui";

import styles from "./agent-threads-dialog.module.css";

interface CodexAgentThreadsDialogProps {
  language: OperationLanguage;
  timeZone: string;
  sessionId: string;
  sessionTitle: string;
  harnessLabel: string;
  selectedThreadId?: string;
  onSelectedThreadChange: (threadId?: string) => void;
  onOpenWorkspacePath: (path: string) => void;
  onOpenFiles: () => void;
  onClose: () => void;
}

function threadStatusLabel(
  thread: CodexThread,
  language: OperationLanguage,
) {
  if (thread.status.type === "active") {
    if (thread.status.activeFlags.includes("waitingOnApproval")) {
      return language === "zh-CN" ? "等待审批" : "Waiting for approval";
    }
    if (thread.status.activeFlags.includes("waitingOnUserInput")) {
      return language === "zh-CN" ? "等待输入" : "Waiting for input";
    }
    return language === "zh-CN" ? "运行中" : "Running";
  }
  if (thread.status.type === "idle") {
    return language === "zh-CN" ? "空闲" : "Idle";
  }
  if (thread.status.type === "systemError") {
    return language === "zh-CN" ? "错误" : "Error";
  }
  return language === "zh-CN" ? "已停止" : "Stopped";
}

function threadUpdatedAt(
  thread: CodexThread,
  language: OperationLanguage,
  timeZone: string,
) {
  if (thread.updatedAt === undefined) return "";
  return formatUnixTimestamp(
    thread.updatedAt,
    language === "zh-CN" ? "zh-CN" : "en",
    timeZone,
    {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  );
}

function AgentThreadTranscript({
  thread,
  agentName,
  root,
  harnessLabel,
  language,
  onOpenWorkspacePath,
  onOpenFiles,
}: {
  thread: CodexThread;
  agentName: string;
  root: boolean;
  harnessLabel: string;
  language: OperationLanguage;
  onOpenWorkspacePath: (path: string) => void;
  onOpenFiles: () => void;
}) {
  const projection = useMemo(() => projectCodexTimeline(thread), [thread]);
  const turns = useMemo(
    () => groupCodexTimelineByTurn(projection),
    [projection],
  );
  const now = Date.now();

  function renderActivity(entry: CodexTimelineEntry) {
    if (entry.kind === "command") {
      return (
        <CodexCommandActivity
          key={entry.id}
          activity={entry}
          language={language}
          compact
        />
      );
    }
    if (entry.kind === "fileChange") {
      return (
        <CodexFileChangeActivity
          key={entry.id}
          activity={entry}
          language={language}
          onOpenFiles={onOpenFiles}
          compact
        />
      );
    }
    if (entry.kind === "nativeItem") {
      return (
        <CodexNativeItemActivity
          key={entry.id}
          activity={entry}
          language={language}
          compact
        />
      );
    }
    if (
      entry.kind === "mcpToolCall" ||
      entry.kind === "dynamicToolCall" ||
      entry.kind === "webSearch" ||
      entry.kind === "collabAgentToolCall" ||
      entry.kind === "subAgentActivity" ||
      entry.kind === "imageGeneration"
    ) {
      return (
        <CodexNativeToolActivity
          key={entry.id}
          activity={entry}
          language={language}
          compact
        />
      );
    }
    if (entry.kind === "turnResult") {
      return (
        <CodexTurnResult key={entry.id} result={entry} language={language} />
      );
    }

    return (
      <article
        className={styles.transcriptMessage}
        data-role={entry.role}
        key={entry.id}
      >
        <span className={styles.transcriptAuthor}>
          {entry.role === "assistant"
            ? agentName || harnessLabel
            : root
              ? language === "zh-CN"
                ? "你"
                : "You"
              : language === "zh-CN"
                ? "父 Agent"
                : "Parent agent"}
        </span>
        {entry.attachments?.length ? (
          <div className={styles.attachments}>
            {entry.attachments.map((attachment) => (
              <Image
                key={attachment.id}
                src={attachment.previewUrl}
                alt={attachment.name}
                width={420}
                height={280}
                sizes="(max-width: 760px) 78vw, 420px"
                unoptimized
              />
            ))}
          </div>
        ) : null}
        {entry.localImages?.length ? (
          <small className={styles.attachmentNote}>
            {language === "zh-CN"
              ? `${entry.localImages.length} 个工作区图片引用`
              : `${entry.localImages.length} Workspace image reference${
                  entry.localImages.length === 1 ? "" : "s"
                }`}
          </small>
        ) : null}
        {entry.content ? (
          <MarkdownContent
            content={entry.content}
            onOpenWorkspacePath={onOpenWorkspacePath}
          />
        ) : entry.streaming ? (
          <span className={styles.streaming}>
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </article>
    );
  }

  function renderTurn(turn: CodexTurnTimelineGroup) {
    const lastActivityIndex = turn.blocks.findLastIndex(
      (block) => block.kind === "activity",
    );
    return (
      <Fragment key={turn.turnId}>
        {turn.blocks.map((block, index) => {
          if (block.kind === "message" || block.kind === "result") {
            return renderActivity(block.entry);
          }
          const activeTurn =
            block.id === turn.activeActivityBlockId
              ? projection.activeTurn
              : undefined;
          if (block.entries.length === 0 && !activeTurn) return null;
          return (
            <CodexTurnActivity
              key={block.id}
              activeTurn={activeTurn}
              turn={index === lastActivityIndex ? turn.turn : undefined}
              language={language}
              now={now}
            >
              {block.entries.map(renderActivity)}
            </CodexTurnActivity>
          );
        })}
      </Fragment>
    );
  }

  if (turns.length === 0) {
    return (
      <div className={styles.emptyTranscript}>
        <Bot size={22} aria-hidden="true" />
        <strong>
          {language === "zh-CN"
            ? "这个 Agent Thread 暂无可回放内容"
            : "No replayable content in this Agent Thread"}
        </strong>
        <p>
          {language === "zh-CN"
            ? "它可能刚创建、仍未写入首个 Turn，或只提供元数据。"
            : "It may be newly created, before its first Turn, or metadata-only."}
        </p>
      </div>
    );
  }

  return <div className={styles.transcript}>{turns.map(renderTurn)}</div>;
}

export function CodexAgentThreadsDialog({
  language,
  timeZone,
  sessionId,
  sessionTitle,
  harnessLabel,
  selectedThreadId,
  onSelectedThreadChange,
  onOpenWorkspacePath,
  onOpenFiles,
  onClose,
}: CodexAgentThreadsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [tree, setTree] = useState<CodexAgentThreads>();
  const [activeThreadId, setActiveThreadId] = useState(
    selectedThreadId ?? "",
  );
  const [thread, setThread] = useState<CodexThread>();
  const [listLoading, setListLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [threadError, setThreadError] = useState("");
  const [refreshSequence, setRefreshSequence] = useState(0);
  const rows = useMemo(
    () => (tree ? codexAgentThreadRows(tree) : []),
    [tree],
  );
  const activeRow = rows.find((row) => row.thread.id === activeThreadId);
  const activeName = activeRow
    ? activeRow.root
      ? sessionTitle
      : codexAgentThreadName(activeRow.thread)
    : "";

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

  useEffect(() => {
    setTree(undefined);
    setThread(undefined);
    setActiveThreadId("");
    setListError("");
    setThreadError("");
  }, [sessionId]);

  useEffect(() => {
    if (selectedThreadId) setActiveThreadId(selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    const load = async (initial: boolean) => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      if (initial) setListLoading(true);
      try {
        const response = await apiFetch<ApiEnvelope<CodexAgentThreads>>(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/agents`,
          { signal: requestController.signal },
        );
        if (disposed) return;
        setTree(response.data);
        setListError("");
        setActiveThreadId((current) => {
          const available = new Set([
            response.data.root.id,
            ...response.data.descendants.map((candidate) => candidate.id),
          ]);
          if (current && available.has(current)) return current;
          if (current) onSelectedThreadChange(undefined);
          return response.data.root.id;
        });
      } catch (cause) {
        if (!disposed && !requestController.signal.aborted) {
          setListError(
            cause instanceof Error
              ? cause.message
              : language === "zh-CN"
                ? "无法读取 Agent Threads。"
                : "Could not load Agent Threads.",
          );
        }
      } finally {
        if (!disposed && initial) setListLoading(false);
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), 3_000);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [language, onSelectedThreadChange, refreshSequence, sessionId]);

  useEffect(() => {
    if (!activeThreadId) return;
    let disposed = false;
    let controller: AbortController | undefined;
    const load = async (background: boolean) => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      if (!background) setThreadLoading(true);
      try {
        const response = await apiFetch<ApiEnvelope<CodexThread>>(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(activeThreadId)}`,
          { signal: requestController.signal },
        );
        if (disposed) return;
        setThread(response.data);
        setThreadError("");
      } catch (cause) {
        if (!disposed && !requestController.signal.aborted) {
          setThreadError(
            cause instanceof Error
              ? cause.message
              : language === "zh-CN"
                ? "无法读取 Agent Thread。"
                : "Could not load the Agent Thread.",
          );
        }
      } finally {
        if (!disposed && !background) setThreadLoading(false);
      }
    };
    setThread(undefined);
    setThreadError("");
    void load(false);
    const shouldPoll =
      activeThreadId !== tree?.root.id &&
      activeRow?.thread.status.type === "active";
    const timer = shouldPoll
      ? window.setInterval(() => void load(true), 3_000)
      : undefined;
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [
    activeRow?.thread.status.type,
    activeThreadId,
    language,
    refreshSequence,
    sessionId,
    tree?.root.id,
  ]);

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
          if (event.key === "Tab") {
            const focusable = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
              ) ?? [],
            );
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className={styles.header}>
          <span className={styles.headerIcon}>
            <UsersRound size={18} aria-hidden="true" />
          </span>
          <span className={styles.headerCopy}>
            <strong id={titleId}>Agent Threads</strong>
            <small>
              {language === "zh-CN"
                ? "Codex 原生线程树与各子 Agent 对话"
                : "Native Codex thread tree and sub-agent conversations"}
            </small>
          </span>
          <button
            type="button"
            aria-label={language === "zh-CN" ? "刷新" : "Refresh"}
            title={language === "zh-CN" ? "刷新" : "Refresh"}
            onClick={() => setRefreshSequence((value) => value + 1)}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={
              language === "zh-CN" ? "关闭 Agent Threads" : "Close Agent Threads"
            }
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>
          <nav
            className={styles.threadList}
            aria-label={
              language === "zh-CN"
                ? "Codex Agent Threads"
                : "Codex Agent Threads"
            }
          >
            <div className={styles.listHeading}>
              <span>{language === "zh-CN" ? "线程" : "Threads"}</span>
              <small>{rows.length}</small>
            </div>
            {listLoading && rows.length === 0 ? (
              <div className={styles.loading}>
                <LoaderCircle size={17} aria-hidden="true" />
                {language === "zh-CN" ? "读取中…" : "Loading…"}
              </div>
            ) : null}
            {listError ? (
              <div className={styles.error} role="alert">
                {listError}
              </div>
            ) : null}
            {rows.map((row) => {
              const name = row.root
                ? sessionTitle
                : codexAgentThreadName(row.thread);
              return (
                <button
                  type="button"
                  className={
                    activeThreadId === row.thread.id ? styles.selected : undefined
                  }
                  aria-current={
                    activeThreadId === row.thread.id ? "true" : undefined
                  }
                  style={{
                    paddingLeft: `${10 + Math.min(row.depth, 5) * 13}px`,
                  }}
                  key={row.thread.id}
                  onClick={() => {
                    setActiveThreadId(row.thread.id);
                    onSelectedThreadChange(row.root ? undefined : row.thread.id);
                  }}
                >
                  <span
                    className={styles.status}
                    data-status={row.thread.status.type}
                    aria-hidden="true"
                  />
                  <span className={styles.threadCopy}>
                    <strong>{name}</strong>
                    <small>
                      {row.root
                        ? language === "zh-CN"
                          ? "主线程"
                          : "Main thread"
                        : row.thread.agentRole ||
                          (language === "zh-CN" ? "子 Agent" : "Sub-agent")}
                    </small>
                  </span>
                  <span className={styles.threadState}>
                    {threadStatusLabel(row.thread, language)}
                  </span>
                </button>
              );
            })}
          </nav>

          <section
            className={styles.detail}
            aria-label={
              language === "zh-CN"
                ? "Agent Thread 详情"
                : "Agent Thread details"
            }
          >
            {activeRow ? (
              <header className={styles.detailHeader}>
                <span>
                  <strong>{activeName}</strong>
                  <small>
                    {activeRow.thread.agentRole
                      ? activeRow.thread.agentRole
                      : activeRow.root
                        ? language === "zh-CN"
                          ? "当前 Sandpi Session"
                          : "Current Sandpi Session"
                        : language === "zh-CN"
                          ? "Codex 子 Agent"
                          : "Codex sub-agent"}
                  </small>
                </span>
                <span className={styles.detailMeta}>
                  <b data-status={activeRow.thread.status.type}>
                    {threadStatusLabel(activeRow.thread, language)}
                  </b>
                  {threadUpdatedAt(activeRow.thread, language, timeZone) ? (
                    <time>
                      {threadUpdatedAt(activeRow.thread, language, timeZone)}
                    </time>
                  ) : null}
                </span>
              </header>
            ) : null}
            <div className={styles.detailScroll}>
              {threadLoading ? (
                <div className={styles.detailLoading} role="status">
                  <LoaderCircle size={19} aria-hidden="true" />
                  {language === "zh-CN"
                    ? "读取原生 Agent Thread…"
                    : "Loading native Agent Thread…"}
                </div>
              ) : null}
              {threadError ? (
                <div className={styles.detailError} role="alert">
                  <strong>
                    {language === "zh-CN"
                      ? "无法打开 Agent Thread"
                      : "Could not open Agent Thread"}
                  </strong>
                  <p>{threadError}</p>
                </div>
              ) : null}
              {thread && !threadLoading ? (
                <AgentThreadTranscript
                  thread={thread}
                  agentName={activeRow?.root ? harnessLabel : activeName}
                  root={activeRow?.root ?? false}
                  harnessLabel={harnessLabel}
                  language={language}
                  onOpenWorkspacePath={onOpenWorkspacePath}
                  onOpenFiles={onOpenFiles}
                />
              ) : null}
            </div>
          </section>
        </div>

        <footer className={styles.footer}>
          <span>
            <code>/agent</code>
          </span>
          <span>
            {language === "zh-CN"
              ? "Activity 仍用于查看父线程的审计记录"
              : "Activity remains the parent-thread audit trail"}
          </span>
        </footer>
      </section>
    </div>
  );
}
