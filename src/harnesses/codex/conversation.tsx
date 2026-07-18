"use client";

import Image from "next/image";
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Copy,
  Files,
  GitFork,
  ListTree,
  LoaderCircle,
  Menu,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Settings2,
  Square,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";

import type { InspectorTab } from "@/components/inspector";
import { MarkdownContent } from "@/components/markdown-content";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import {
  codexModelOptionsFromNativeResult,
  type CodexModelOption,
} from "@/harnesses/codex/models";
import { codexTurnCapabilitySets } from "@/harnesses/codex/capabilities";
import {
  clipboardCodexImageFiles,
  encodeCodexComposerImage,
  MAX_CODEX_COMPOSER_IMAGES,
  readCodexComposerImage,
  selectCodexImageFiles,
  type CodexImageSelectionIssue,
} from "@/harnesses/codex/composer-images";
import {
  CodexCommandActivity,
  CodexFileChangeActivity,
  CodexNativeItemActivity,
  CodexNativeToolActivity,
  CodexTurnActivity,
  CodexTurnResult,
} from "@/harnesses/codex/activity";
import { CodexSessionActivityView } from "@/harnesses/codex/session-activity-view";
import { groupCodexTimelineByTurn } from "@/harnesses/codex/timeline";
import type {
  CodexComposerImage,
  CodexEventEnvelope,
  CodexNativeInvalidation,
  CodexNativeSnapshot,
  CodexNativeStreamFailure,
  CodexSession,
} from "@/harnesses/codex/types";
import {
  projectCodexTimeline,
  shouldRefreshCodexNativeSnapshot,
  type CodexMessageView,
  type CodexTimelineEntry,
} from "@/harnesses/codex/events";
import {
  apiFetch,
  apiUrl,
  type ApiEnvelope,
} from "@/lib/api-client";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useConversationAutoScroll } from "@/lib/use-conversation-auto-scroll";
import {
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import { getCodexUiCopy } from "@/harnesses/codex/ui";
import type { Environment } from "@/lib/types";

interface ConversationProps {
  language: OperationLanguage;
  timeZone: string;
  sendShortcut: SendShortcut;
  environment: Environment;
  session: CodexSession;
  inspectorOpen: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onOpenInspector: (tab: InspectorTab) => void;
  onSessionChange: (session: CodexSession) => void;
  onDerivedSessionCreated: (session: CodexSession) => void;
  onForkSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
}

function syncComposerHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

const CODEX_SESSION_STATUSES = new Set<CodexNativeSnapshot["sessionStatus"]>([
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
]);

export function CodexConversation({
  language,
  timeZone,
  sendShortcut,
  environment,
  session,
  inspectorOpen,
  terminalOpen,
  onToggleSidebar,
  onToggleInspector,
  onToggleTerminal,
  onOpenSettings,
  onOpenInspector,
  onSessionChange,
  onDerivedSessionCreated,
  onForkSession,
  onRenameSession,
  onArchiveSession,
  onTogglePinSession,
}: ConversationProps) {
  const ui = getCodexUiCopy(language).conversation;
  const [modelOptions, setModelOptions] = useState<CodexModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState(
    session.harnessState.modelId,
  );
  const selectedModel = modelOptions.find(
    (model) => model.id === selectedModelId,
  ) ?? {
    id: selectedModelId || session.harnessState.modelId || "default",
    displayName: selectedModelId || session.harnessState.modelId || "Default",
    isDefault: false,
  };
  const [draft, setDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<CodexComposerImage[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [modelCatalogUnavailable, setModelCatalogUnavailable] = useState("");
  const [nativeSnapshot, setNativeSnapshot] =
    useState<CodexNativeSnapshot | null>(null);
  const [liveNotifications, setLiveNotifications] = useState<
    CodexEventEnvelope[]
  >([]);
  const [nativeStreamEpoch, setNativeStreamEpoch] = useState(0);
  const [nativeStreamReady, setNativeStreamReady] = useState(false);
  const [nativeHistoryError, setNativeHistoryError] = useState("");
  const [activeSurface, setActiveSurface] = useState<
    "conversation" | "activity"
  >("conversation");
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  const pendingTurnStartedAtRef = useRef<number | null>(null);
  const hasNativeSnapshotRef = useRef(false);
  const hasNativeStreamFailureRef = useRef(false);
  const liveNotificationSequencesRef = useRef(new Set<number>());
  const liveNotificationCountRef = useRef(0);
  const nativeSnapshotRefreshRequestedRef = useRef(false);
  const sessionRef = useRef(session);
  const visibleTimeline = useMemo(() => {
    return projectCodexTimeline(nativeSnapshot?.thread, liveNotifications);
  }, [liveNotifications, nativeSnapshot?.thread]);
  const timelineTurns = useMemo(
    () => groupCodexTimelineByTurn(visibleTimeline),
    [visibleTimeline],
  );
  const turnCapabilities = useMemo(
    () => codexTurnCapabilitySets(nativeSnapshot),
    [nativeSnapshot],
  );
  const runningTurn =
    visibleTimeline.activeTurn ??
    (session.status === "running"
      ? {
          turnId: `pending:${session.id}`,
          startedAt: pendingTurnStartedAtRef.current ?? session.updatedAt,
          state: "working" as const,
        }
      : undefined);
  const runningTurnId = runningTurn?.turnId;
  const interruptibleTurnId = visibleTimeline.activeTurn?.turnId;
  const turnRunning = Boolean(runningTurnId);
  const nativeReady =
    Boolean(nativeSnapshot) && nativeStreamReady && !nativeHistoryError;
  // Sandpi deliberately stores no secondary chat transcript. Until the native
  // harness snapshot arrives, this is runtime recovery—not an empty history.
  // Do not infer a cold start from persisted Sandbox state here: bootstrap may
  // still say paused while an ordinary refresh is already loading the runtime.
  const nativeHistoryLoading = !nativeSnapshot && !nativeHistoryError;
  const {
    scrollRef: conversationScrollRef,
    contentRef: conversationContentRef,
    onScroll: handleAutoScroll,
  } = useConversationAutoScroll({ resetKey: session.id });

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    pendingTurnStartedAtRef.current = null;
    setDraft("");
    setPastedImages([]);
    setAttachmentError("");
    setSending(false);
    setInterrupting(false);
    setForkingMessageId(null);
    setModelCatalogUnavailable("");
    setNativeSnapshot(null);
    setLiveNotifications([]);
    setNativeStreamReady(false);
    setNativeHistoryError("");
    setActiveSurface("conversation");
    hasNativeSnapshotRef.current = false;
    hasNativeStreamFailureRef.current = false;
    liveNotificationSequencesRef.current.clear();
    liveNotificationCountRef.current = 0;
    nativeSnapshotRefreshRequestedRef.current = false;
  }, [session.id]);

  useEffect(() => {
    if (!runningTurnId) return;
    setActivityClock(Date.now());
    const timer = window.setInterval(() => setActivityClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runningTurnId]);

  useEffect(() => {
    setInterrupting(false);
  }, [runningTurnId]);

  useEffect(() => {
    setSelectedModelId(session.harnessState.modelId);
  }, [session.id, session.harnessState.modelId]);

  useEffect(() => {
    const controller = new AbortController();
    setModelCatalogUnavailable("");
    void apiFetch<ApiEnvelope<unknown>>(
      `/api/v1/sessions/${encodeURIComponent(session.id)}/models`,
      { signal: controller.signal },
    )
      .then((response) => {
        const models = codexModelOptionsFromNativeResult(response.data);
        setModelOptions(models);
        setModelCatalogUnavailable(
          response.meta?.availability === "runtime-unavailable"
            ? typeof response.meta.message === "string"
              ? response.meta.message
              : ui.modelListUnavailable
            : "",
        );
        setSelectedModelId((current) =>
          models.some((model) => model.id === current)
            ? current
            : (models.find((model) => model.isDefault)?.id ??
              models[0]?.id ??
              current),
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setModelOptions([]);
          setModelCatalogUnavailable(
            error instanceof Error ? error.message : ui.modelListUnavailable,
          );
        }
      });
    return () => controller.abort();
  }, [session.id, ui.modelListUnavailable]);

  useEffect(() => {
    const source = new EventSource(
      apiUrl(`/api/v1/sessions/${encodeURIComponent(session.id)}/events`),
      { withCredentials: true },
    );

    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as CodexNativeSnapshot;
        if (
          snapshot.protocol !== "codex-app-server" ||
          !snapshot.thread ||
          snapshot.thread.id !== snapshot.nativeSessionId ||
          !Array.isArray(snapshot.thread.turns) ||
          !Number.isSafeInteger(snapshot.historyRevision) ||
          snapshot.historyRevision < 0 ||
          !CODEX_SESSION_STATUSES.has(snapshot.sessionStatus) ||
          !Array.isArray(snapshot.forkableTurnIds) ||
          snapshot.forkableTurnIds.some((turnId) => typeof turnId !== "string")
        ) {
          throw new Error("Invalid Codex native snapshot");
        }
        hasNativeSnapshotRef.current = true;
        hasNativeStreamFailureRef.current = false;
        nativeSnapshotRefreshRequestedRef.current = false;
        liveNotificationSequencesRef.current.clear();
        liveNotificationCountRef.current = 0;
        setNativeSnapshot(snapshot);
        // A snapshot is the new native authority. Never replay the prior
        // connection's notification suffix on top of it.
        setLiveNotifications([]);
        setNativeStreamReady(true);
        setNativeHistoryError("");
        setSelectedModelId(snapshot.modelId);
        const current = sessionRef.current;
        const next: CodexSession = {
          ...current,
          updatedAt: snapshot.thread.updatedAt ?? current.updatedAt,
          status: snapshot.sessionStatus,
          harnessState: {
            ...current.harnessState,
            threadId: snapshot.thread.id,
            modelId: snapshot.modelId,
            historyRevision: snapshot.historyRevision,
          },
        };
        sessionRef.current = next;
        onSessionChange(next);
      } catch (error) {
        hasNativeSnapshotRef.current = false;
        hasNativeStreamFailureRef.current = true;
        liveNotificationSequencesRef.current.clear();
        liveNotificationCountRef.current = 0;
        setNativeSnapshot(null);
        setLiveNotifications([]);
        setNativeStreamReady(false);
        setNativeHistoryError(ui.nativeRolloutUnavailableBody);
        console.error("Unable to decode Codex native snapshot", error);
      }
    };

    const handleNotification = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as CodexEventEnvelope;
        if (envelope.harness !== "codex" || !hasNativeSnapshotRef.current) {
          return;
        }
        if (liveNotificationSequencesRef.current.has(envelope.sequence)) return;
        if (shouldRefreshCodexNativeSnapshot(liveNotificationCountRef.current)) {
          // Projection replays the suffix over the native Thread snapshot. Cap
          // that work and reconnect so app-server supplies a fresh authority
          // instead of letting a long Turn grow memory and replay cost without
          // bound.
          if (!nativeSnapshotRefreshRequestedRef.current) {
            nativeSnapshotRefreshRequestedRef.current = true;
            hasNativeSnapshotRef.current = false;
            setNativeStreamReady(false);
            setNativeStreamEpoch((current) => current + 1);
          }
          return;
        }
        liveNotificationSequencesRef.current.add(envelope.sequence);
        liveNotificationCountRef.current += 1;
        setLiveNotifications((current) => [...current, envelope]);

        const current = sessionRef.current;
        const started = envelope.notification.method === "turn/started";
        const completed = envelope.notification.method === "turn/completed";
        const next: CodexSession = {
          ...current,
          updatedAt: envelope.receivedAt,
          status: started ? "running" : completed ? "waiting" : current.status,
          unread:
            completed && document.visibilityState !== "visible"
              ? true
              : current.unread,
        };
        sessionRef.current = next;
        onSessionChange(next);
        if (completed && document.visibilityState === "visible") {
          void apiFetch(
            `/api/v1/sessions/${encodeURIComponent(session.id)}/metadata`,
            {
              method: "PUT",
              body: JSON.stringify({ unread: false }),
            },
          ).catch((error) =>
            console.error("Unable to mark completed Codex Turn as read", error),
          );
        }
      } catch (error) {
        console.error("Unable to decode Codex live notification", error);
      }
    };

    const handleInvalidation = (event: MessageEvent<string>) => {
      let invalidation: CodexNativeInvalidation = {};
      try {
        invalidation = event.data
          ? (JSON.parse(event.data) as CodexNativeInvalidation)
          : {};
      } catch (error) {
        console.error("Unable to decode Codex native invalidation", error);
      }
      hasNativeSnapshotRef.current = false;
      liveNotificationSequencesRef.current.clear();
      liveNotificationCountRef.current = 0;
      setNativeSnapshot(null);
      setLiveNotifications([]);
      setNativeStreamReady(false);
      const reason = invalidation.reason?.toLowerCase() ?? "";
      const unrecoverable =
        invalidation.unrecoverable === true ||
        reason.includes("unrecoverable") ||
        reason.includes("rollout-lost") ||
        reason.includes("rollout_lost");
      setNativeHistoryError(
        unrecoverable
          ? invalidation.message || ui.nativeRolloutUnavailableBody
          : "",
      );
      hasNativeStreamFailureRef.current = unrecoverable;
    };

    const handleStreamFailure = (event: MessageEvent<string>) => {
      try {
        const failure = JSON.parse(event.data) as CodexNativeStreamFailure;
        if (
          !Number.isInteger(failure.status) ||
          typeof failure.code !== "string" ||
          typeof failure.message !== "string" ||
          typeof failure.retryable !== "boolean"
        ) {
          throw new Error("Invalid Codex native stream failure");
        }
        hasNativeStreamFailureRef.current = true;
        setNativeStreamReady(false);
        setNativeHistoryError(failure.message || ui.nativeStreamUnavailableBody);
        if (!failure.retryable) source.close();
      } catch (error) {
        hasNativeStreamFailureRef.current = true;
        setNativeStreamReady(false);
        setNativeHistoryError(ui.nativeStreamUnavailableBody);
        console.error("Unable to decode Codex native stream failure", error);
      }
    };

    const handleStreamError = () => {
      setNativeStreamReady(false);
      if (
        !hasNativeSnapshotRef.current &&
        !hasNativeStreamFailureRef.current
      ) {
        setNativeHistoryError(
          (current) => current || ui.nativeStreamUnavailableBody,
        );
      }
    };

    source.addEventListener("snapshot", handleSnapshot as EventListener);
    source.addEventListener("notification", handleNotification as EventListener);
    source.addEventListener("invalidation", handleInvalidation as EventListener);
    source.addEventListener("stream-error", handleStreamFailure as EventListener);
    source.addEventListener("error", handleStreamError);
    return () => source.close();
  }, [
    nativeStreamEpoch,
    onSessionChange,
    session.id,
    ui.nativeRolloutUnavailableBody,
    ui.nativeStreamUnavailableBody,
  ]);

  useEffect(() => {
    if (composerRef.current) {
      syncComposerHeight(composerRef.current);
    }
  }, [draft]);

  useEffect(
    () => () => {
      if (scrollbarHideTimerRef.current !== null) {
        window.clearTimeout(scrollbarHideTimerRef.current);
      }
    },
    [],
  );

  async function submitMessage() {
    const content = draft.trim();
    if (!content && pastedImages.length === 0) {
      return;
    }
    if (sending || turnRunning || session.status !== "waiting" || !nativeReady) {
      return;
    }
    setSending(true);
    setAttachmentError("");
    try {
      await apiFetch<ApiEnvelope<{ requestId: string }>>(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            text: content,
            images: pastedImages.map(encodeCodexComposerImage),
            ...(selectedModel.id !== "default"
              ? { modelId: selectedModel.id }
              : {}),
          }),
        },
      );
      const next = {
        ...sessionRef.current,
        status: "running" as const,
        unread: false,
        harnessState: {
          ...sessionRef.current.harnessState,
          modelId: selectedModel.id,
        },
      };
      pendingTurnStartedAtRef.current = Date.now() / 1_000;
      sessionRef.current = next;
      onSessionChange(next);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Could not start the Codex Turn.",
      );
      setSending(false);
      return;
    }
    setDraft("");
    setPastedImages([]);
    setAttachmentError("");
    setSending(false);
  }

  async function interruptActiveTurn() {
    if (!interruptibleTurnId || interrupting) {
      return;
    }
    setInterrupting(true);
    setAttachmentError("");
    try {
      await apiFetch<ApiEnvelope<{ requestId: string }>>(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns/interrupt`,
        {
          method: "POST",
          body: JSON.stringify({ turnId: interruptibleTurnId }),
        },
      );
      // Keep the stop state until the native active Turn disappears. Product
      // Session status converges from the shared native event stream/snapshot.
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : ui.interruptTurnFailed,
      );
      setInterrupting(false);
    }
  }

  async function forkTurn(message: CodexMessageView) {
    if (sending || !turnCapabilities.forkableTurnIds.has(message.turnId)) {
      return;
    }
    setSending(true);
    setForkingMessageId(message.id);
    setAttachmentError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexSession>>(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns/${encodeURIComponent(message.turnId)}/fork`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onDerivedSessionCreated(response.data);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : ui.forkTurnFailed,
      );
    } finally {
      setForkingMessageId(null);
      setSending(false);
    }
  }

  async function copyMessage(message: CodexMessageView) {
    try {
      await copyTextToClipboard(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) =>
          current === message.id ? null : current,
        );
      }, 1600);
    } catch {
      setCopiedMessageId(null);
    }
  }

  async function addPastedImages(files: File[]) {
    const selection = selectCodexImageFiles(files, pastedImages);
    setAttachmentError(imageSelectionError(selection.issue));
    if (selection.files.length === 0) return;

    try {
      const attachments = await Promise.all(
        selection.files.map(readCodexComposerImage),
      );
      setPastedImages((current) =>
        [...current, ...attachments].slice(0, MAX_CODEX_COMPOSER_IMAGES),
      );
    } catch {
      setAttachmentError(ui.imagePasteFailed);
    }
  }

  function handleConversationScroll(event: UIEvent<HTMLDivElement>) {
    const scrollRegion = event.currentTarget;
    handleAutoScroll(event);
    scrollRegion.classList.add("is-scrolling");
    if (scrollbarHideTimerRef.current !== null) {
      window.clearTimeout(scrollbarHideTimerRef.current);
    }
    scrollbarHideTimerRef.current = window.setTimeout(() => {
      scrollRegion.classList.remove("is-scrolling");
      scrollbarHideTimerRef.current = null;
    }, 700);
  }

  function openMarkdownWorkspacePath(path: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("path", path);
    window.history.replaceState(window.history.state, "", url);
    onOpenInspector("files");
  }

  function renderTimelineEntry(entry: CodexTimelineEntry) {
    if (entry.kind === "command") {
      return (
        <CodexCommandActivity
          key={entry.id}
          activity={entry}
          language={language}
        />
      );
    }
    if (entry.kind === "fileChange") {
      return (
        <CodexFileChangeActivity
          key={entry.id}
          activity={entry}
          language={language}
          onOpenFiles={() => onOpenInspector("files")}
        />
      );
    }
    if (entry.kind === "nativeItem") {
      return (
        <CodexNativeItemActivity
          key={entry.id}
          activity={entry}
          language={language}
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
        />
      );
    }
    if (entry.kind === "turnResult") {
      return (
        <CodexTurnResult key={entry.id} result={entry} language={language} />
      );
    }

    const message = entry;
    return (
      <article
        className={`message message-${message.role}`}
        key={message.id}
      >
        {message.role === "assistant" ? (
          <div className="assistant-avatar" aria-label="Codex">
            <span />
          </div>
        ) : null}
        <div className="message-body">
          <div className="message-author">
            {message.role === "user" ? ui.you : session.harnessLabel}
          </div>
          {message.attachments?.length ? (
            <div
              className={`message-image-attachments ${
                message.attachments.length === 1 ? "is-single" : ""
              }`}
              aria-label={ui.attachedImages}
            >
              {message.attachments.map((attachment) => (
                <Image
                  key={attachment.id}
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  width={440}
                  height={300}
                  sizes="(max-width: 680px) 72vw, 320px"
                  unoptimized
                />
              ))}
            </div>
          ) : null}
          {message.content ? (
            <MarkdownContent
              content={message.content}
              onOpenWorkspacePath={openMarkdownWorkspacePath}
            />
          ) : message.streaming ? (
            <div
              className="assistant-streaming"
              aria-label={ui.turnActivity("responding")}
            >
              <span />
              <span />
              <span />
            </div>
          ) : null}

          {message.role === "assistant" ? (
            <div className="message-actions message-actions-assistant">
              <button
                type="button"
                aria-label={ui.copyResponse}
                title={ui.copy}
                onClick={() => void copyMessage(message)}
              >
                {copiedMessageId === message.id ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          ) : (
            <div className="message-actions message-actions-user">
              <button
                type="button"
                aria-label={ui.forkTurnMessage}
                title={ui.forkTurnHere}
                aria-busy={forkingMessageId === message.id}
                disabled={
                  sending ||
                  session.status !== "waiting" ||
                  !turnCapabilities.forkableTurnIds.has(message.turnId)
                }
                onClick={() => void forkTurn(message)}
              >
                {forkingMessageId === message.id ? (
                  <span className="activity-spinner" aria-hidden="true" />
                ) : (
                  <GitFork size={14} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                aria-label={ui.copyMessage}
                title={ui.copy}
                onClick={() => void copyMessage(message)}
              >
                {copiedMessageId === message.id ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          )}
        </div>
        {message.role === "user" ? (
          <div className="user-avatar" role="img" aria-label={ui.you}>
            YA
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <section
      id="conversation"
      className="conversation-pane"
      aria-label={ui.label}
      tabIndex={-1}
    >
      <header className="conversation-header">
        <div className="conversation-title-area">
          <button
            type="button"
            className="icon-button sidebar-expand-button"
            aria-label={ui.expandSidebar}
            title={ui.expandSidebar}
            onClick={onToggleSidebar}
          >
            <PanelLeftOpen size={19} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button mobile-menu-button"
            aria-label={ui.openNavigation}
            onClick={onToggleSidebar}
          >
            <Menu size={19} aria-hidden="true" />
          </button>
          <div className="conversation-title-line">
            <div className="conversation-breadcrumb">
              <button type="button" onClick={onOpenSettings}>
                {environment.name}
              </button>
              <span>/</span>
              <span>{session.title}</span>
            </div>
            <span className="conversation-context">
              <span
                className={`live-indicator status-${session.status}`}
                aria-hidden="true"
              />
              <span>{ui.status(session.status)}</span>
              <span aria-hidden="true">·</span>
              <span className="conversation-context-summary">
                {session.harnessLabel} · {selectedModel.displayName} ·{" "}
                {ui.environmentRevision(session.environmentRevision)}
              </span>
            </span>
          </div>
        </div>

        <div className="conversation-header-actions">
          <button
            type="button"
            className={`header-action-button ${
              activeSurface === "activity" ? "is-active" : ""
            }`}
            aria-label={
              activeSurface === "activity"
                ? ui.returnToConversation
                : ui.sessionActivity
            }
            aria-pressed={activeSurface === "activity"}
            title={
              activeSurface === "activity"
                ? ui.returnToConversation
                : ui.sessionActivity
            }
            onClick={() =>
              setActiveSurface((current) =>
                current === "activity" ? "conversation" : "activity",
              )
            }
          >
            <ListTree size={15} aria-hidden="true" />
            <span>
              {activeSurface === "activity"
                ? ui.returnToConversation
                : ui.activity}
            </span>
          </button>
          <button
            type="button"
            className={`header-action-button ${terminalOpen ? "is-active" : ""}`}
            aria-label={ui.terminal}
            aria-pressed={terminalOpen}
            title={ui.terminal}
            onClick={onToggleTerminal}
          >
            <SquareTerminal size={15} aria-hidden="true" />
            <span>{ui.terminal}</span>
          </button>
          <button
            type="button"
            className={`icon-button ${inspectorOpen ? "is-active" : ""}`}
            aria-label={inspectorOpen ? ui.closeInspector : ui.openInspector}
            onClick={onToggleInspector}
          >
            <PanelRight size={18} />
          </button>
          <SessionActionsMenu
            key={session.id}
            language={language}
            session={session}
            triggerClassName="icon-button"
            triggerIconSize={19}
            sessionForkEnabled={session.status === "waiting"}
            onForkSession={onForkSession}
            onRenameSession={onRenameSession}
            onArchiveSession={onArchiveSession}
            onTogglePinSession={onTogglePinSession}
          />
        </div>
      </header>

      {activeSurface === "activity" ? (
        <CodexSessionActivityView
          key={nativeSnapshot?.thread.id ?? session.harnessState.threadId}
          language={language}
          timeZone={timeZone}
          projection={visibleTimeline}
          nativeThreadId={
            nativeSnapshot?.thread.id ?? session.harnessState.threadId
          }
          historyRevision={
            nativeSnapshot?.historyRevision ??
            session.harnessState.historyRevision
          }
          loading={nativeHistoryLoading}
          error={nativeHistoryError}
          onOpenEnvironmentAudit={() => onOpenInspector("audit")}
          onOpenFiles={() => onOpenInspector("files")}
        />
      ) : (
        <>
          <div
            ref={conversationScrollRef}
            className="conversation-scroll"
            onScroll={handleConversationScroll}
          >
            <div
              ref={conversationContentRef}
              className="message-column"
              aria-busy={nativeHistoryLoading}
            >
              {nativeHistoryLoading ? (
                <div
                  className="conversation-runtime-loading"
                  role="status"
                  aria-live="polite"
                >
                  <span className="conversation-runtime-loading-icon">
                    <LoaderCircle size={18} aria-hidden="true" />
                  </span>
                  <span className="conversation-runtime-loading-copy">
                    <strong>{ui.loadingConversation}</strong>
                    <small>{ui.loadingConversationBody}</small>
                  </span>
                </div>
              ) : null}
              {nativeHistoryError ? (
                <div className="native-context-reset-notice" role="alert">
                  <TriangleAlert size={16} aria-hidden="true" />
                  <span>
                    <strong>{ui.nativeRolloutUnavailableTitle}</strong>
                    <small>{nativeHistoryError}</small>
                  </span>
                </div>
              ) : null}
              {timelineTurns.map((timelineTurn) => {
                const activeTurn =
                  runningTurn?.turnId === timelineTurn.turnId
                    ? runningTurn
                    : undefined;
                const hasActivity =
                  timelineTurn.activityEntries.length > 0 ||
                  Boolean(activeTurn);
                return (
                  <Fragment key={timelineTurn.turnId}>
                    {timelineTurn.userMessages.map(renderTimelineEntry)}
                    {hasActivity ? (
                      <CodexTurnActivity
                        activeTurn={activeTurn}
                        turn={timelineTurn.turn}
                        language={language}
                        now={activityClock}
                      >
                        {timelineTurn.activityEntries.map(renderTimelineEntry)}
                      </CodexTurnActivity>
                    ) : null}
                    {timelineTurn.finalMessage
                      ? renderTimelineEntry(timelineTurn.finalMessage)
                      : null}
                    {timelineTurn.results.map(renderTimelineEntry)}
                  </Fragment>
                );
              })}
              {runningTurn &&
              !nativeHistoryLoading &&
              !timelineTurns.some(
                (turn) => turn.turnId === runningTurn.turnId,
              ) ? (
                <CodexTurnActivity
                  activeTurn={runningTurn}
                  language={language}
                  now={activityClock}
                />
              ) : null}
            </div>
          </div>

          <div className="composer-region">
            <div className="composer-shell">
          {pastedImages.length ? (
            <div
              className="composer-image-previews"
              aria-label={ui.attachedImages}
            >
              {pastedImages.map((attachment) => (
                <div className="composer-image-preview" key={attachment.id}>
                  <Image
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    width={64}
                    height={64}
                    unoptimized
                  />
                  <button
                    type="button"
                    aria-label={ui.removeImage(attachment.name)}
                    title={ui.removeImage(attachment.name)}
                    onClick={() => {
                      setPastedImages((current) =>
                        current.filter((image) => image.id !== attachment.id),
                      );
                      setAttachmentError("");
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {attachmentError ? (
            <div className="composer-attachment-error" role="status">
              {attachmentError}
            </div>
          ) : null}
          {/*
            Slash commands, approvals, steering and other composer behavior are Codex-native.
            Do not lift them into the shared dispatcher when additional harnesses are added.
          */}
          <textarea
            ref={composerRef}
            name="message"
            autoComplete="off"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              syncComposerHeight(event.currentTarget);
            }}
            onPaste={(event) => {
              const imageFiles = clipboardCodexImageFiles(event.clipboardData);
              if (imageFiles.length === 0) {
                return;
              }
              event.preventDefault();
              void addPastedImages(imageFiles);
            }}
            onKeyDown={(event) => {
              if (
                shouldSubmitComposer(
                  {
                    key: event.key,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    isComposing: event.nativeEvent.isComposing,
                  },
                  sendShortcut,
                )
              ) {
                event.preventDefault();
                void submitMessage();
              }
            }}
            aria-label={ui.messageAgent(environment.codingAgent.label)}
            placeholder={ui.askPlaceholder(environment.codingAgent.label)}
            rows={1}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <button
                type="button"
                className="composer-icon-button"
                aria-label={ui.attachFile}
                onClick={() => imageInputRef.current?.click()}
              >
                <Paperclip size={17} />
              </button>
              <input
                ref={imageInputRef}
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                tabIndex={-1}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length > 0) void addPastedImages(files);
                }}
              />
              <button
                type="button"
                className="composer-icon-button"
                aria-label={ui.mentionFile}
              >
                <AtSign size={17} />
              </button>
              <span
                className="composer-agent-bound"
                title={ui.boundToEnvironment}
              >
                <span className="codex-glyph" />
                <span className="composer-harness-label">
                  {environment.codingAgent.label}
                </span>
                <label
                  className="composer-model-picker"
                  title={modelCatalogUnavailable || undefined}
                  data-availability={
                    modelCatalogUnavailable ? "runtime-unavailable" : "available"
                  }
                >
                  <span className="sr-only">
                    {ui.selectModel(environment.codingAgent.label)}
                  </span>
                  <select
                    name="coding-agent-model"
                    aria-label={ui.selectModel(
                      environment.codingAgent.label,
                    )}
                    value={selectedModel.id}
                    disabled={modelOptions.length === 0 || sending}
                    onChange={(event) => setSelectedModelId(event.target.value)}
                  >
                    {(modelOptions.length > 0
                      ? modelOptions
                      : [selectedModel]
                    ).map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} aria-hidden="true" />
                </label>
              </span>
            </div>
            <div className="composer-send-area">
              <span
                className={`connection-copy ${
                  nativeHistoryError
                    ? "is-unavailable"
                    : !nativeReady
                      ? "is-loading"
                      : ""
                }`}
              >
                <span />
                {nativeHistoryError
                  ? ui.runtimeUnavailable
                  : nativeReady
                    ? ui.durableSession
                    : ui.checkingRuntime}
              </span>
              {turnRunning ? (
                <button
                  type="button"
                  className={`send-button is-running ${
                    interrupting ? "is-interrupting" : ""
                  }`}
                  disabled={interrupting || !interruptibleTurnId}
                  aria-label={
                    interrupting
                      ? ui.interruptingTurn
                      : interruptibleTurnId
                        ? ui.interruptTurn
                        : ui.turnStarting
                  }
                  aria-busy={interrupting}
                  title={ui.interruptTurn}
                  onClick={() => void interruptActiveTurn()}
                >
                  {interrupting ? (
                    <span className="activity-spinner" aria-hidden="true" />
                  ) : (
                    <Square size={10} fill="currentColor" aria-hidden="true" />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="send-button"
                  disabled={
                    sending ||
                    session.status !== "waiting" ||
                    !nativeReady ||
                    (!draft.trim() && pastedImages.length === 0)
                  }
                  aria-label={ui.sendMessage}
                  onClick={() => void submitMessage()}
                >
                  <ArrowUp size={17} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
            </div>
            <p className="composer-footnote">
              <Files size={12} /> {ui.workingInWorkspace}
              <span>·</span>
              <Settings2 size={12} /> {ui.networkInherited(environment.name)}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function imageSelectionError(issue?: CodexImageSelectionIssue) {
  if (!issue) return "";
  if (issue === "too-many") return `Attach up to ${MAX_CODEX_COMPOSER_IMAGES} images.`;
  if (issue === "unsupported") return "Use PNG, JPEG, GIF, or WebP images.";
  if (issue === "total-too-large") return "The combined image size is too large.";
  return "Each image must be 10 MB or smaller.";
}
