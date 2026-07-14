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
  Menu,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Pencil,
  Settings2,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type UIEvent } from "react";

import type { InspectorTab } from "@/components/inspector";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import {
  codexModelOptionsFromNativeResult,
  type CodexModelOption,
} from "@/harnesses/codex/models";
import {
  clipboardCodexImageFiles,
  encodeCodexComposerImage,
  MAX_CODEX_COMPOSER_IMAGES,
  readCodexComposerImage,
  selectCodexImageFiles,
  type CodexImageSelectionIssue,
} from "@/harnesses/codex/composer-images";
import { visibleCodexConversationWhileEditing } from "@/harnesses/codex/timeline";
import type {
  CodexComposerImage,
  CodexSession,
} from "@/harnesses/codex/types";
import type {
  CodexMessageView,
  CodexToolActivityView,
} from "@/harnesses/codex/events";
import {
  apiFetch,
  apiUrl,
  type ApiEnvelope,
} from "@/lib/api-client";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import { getCodexUiCopy } from "@/harnesses/codex/ui";
import type { Environment } from "@/lib/types";

interface ConversationProps {
  language: OperationLanguage;
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

function activityIcon(status: CodexToolActivityView["status"]) {
  if (status === "completed") {
    return <Check size={13} strokeWidth={2.6} />;
  }
  return <span className="activity-spinner" />;
}

function syncComposerHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function completedTurnUserItemId(
  events: CodexSession["harnessState"]["events"],
  turnId: string,
) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const notification = events[index]?.notification;
    if (
      notification?.method === "item/completed" &&
      notification.params.turnId === turnId &&
      notification.params.item.type === "userMessage"
    ) {
      return notification.params.item.id;
    }
  }
  return undefined;
}

export function CodexConversation({
  language,
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
  const selectedModel = modelOptions.find(
    (model) => model.id === session.harnessState.modelId,
  ) ?? {
    id: session.harnessState.modelId || "default",
    displayName: session.harnessState.modelId || "Default",
  };
  const [draft, setDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<CodexComposerImage[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [sending, setSending] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  const sessionRef = useRef(session);
  // This operates on Codex-native Turn/item boundaries. Other clients must implement the same
  // editing UX in their own harness reducer instead of consuming a shared message timeline.
  const visibleMessages = visibleCodexConversationWhileEditing(
    session.harnessState.events,
    editingMessageId,
  );

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    setDraft("");
    setDeleteMessageId(null);
    setEditingMessageId(null);
    setPastedImages([]);
    setAttachmentError("");
    setSending(false);
    setForkingMessageId(null);
  }, [session.id]);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<ApiEnvelope<unknown>>(
      `/api/v1/sessions/${encodeURIComponent(session.id)}/models`,
      { signal: controller.signal },
    )
      .then((response) => {
        const models = codexModelOptionsFromNativeResult(response.data);
        setModelOptions(models);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          console.error("Unable to load Codex models", error);
        }
      });
    return () => controller.abort();
  }, [session.id]);

  useEffect(() => {
    const latestSequence = sessionRef.current.harnessState.events.at(-1)?.sequence ?? 0;
    const search = new URLSearchParams({
      after: String(latestSequence),
      revision: String(sessionRef.current.harnessState.historyRevision ?? 0),
    });
    const source = new EventSource(
      apiUrl(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/events?${search.toString()}`,
      ),
      { withCredentials: true },
    );

    const handleHarnessEvent = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as CodexSession["harnessState"]["events"][number];
        const current = sessionRef.current;
        if (
          envelope.harness !== "codex" ||
          current.harnessState.events.some(
            (candidate) => candidate.sequence === envelope.sequence,
          )
        ) {
          return;
        }
        const events = [...current.harnessState.events, envelope];
        const completedTurnId =
          envelope.notification.method === "turn/completed"
            ? envelope.notification.params.turn.id
            : undefined;
        const recoverableItemId = completedTurnId
          ? completedTurnUserItemId(events, completedTurnId)
          : undefined;
        const next: CodexSession = {
          ...current,
          updatedAt: envelope.receivedAt,
          status:
            envelope.notification.method === "turn/completed"
              ? "waiting"
              : envelope.notification.method === "turn/started"
                ? "running"
                : current.status,
          unread:
            envelope.notification.method === "turn/completed"
              ? document.visibilityState !== "visible"
              : current.unread,
          harnessState: {
            ...current.harnessState,
            events,
            recoverableUserMessageItemIds: recoverableItemId
              ? [
                  ...(current.harnessState.recoverableUserMessageItemIds ?? []),
                  recoverableItemId,
                ].filter((itemId, index, all) => all.indexOf(itemId) === index)
              : current.harnessState.recoverableUserMessageItemIds,
          },
        };
        sessionRef.current = next;
        onSessionChange(next);
        if (
          envelope.notification.method === "turn/completed" &&
          document.visibilityState === "visible"
        ) {
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
        console.error("Unable to decode Codex event", error);
      }
    };

    source.addEventListener("harness", handleHarnessEvent as EventListener);
    source.addEventListener("reset", ((event: MessageEvent<string>) => {
      try {
        const replacement = JSON.parse(event.data) as CodexSession;
        sessionRef.current = replacement;
        setDeleteMessageId(null);
        setEditingMessageId(null);
        onSessionChange(replacement);
      } catch (error) {
        console.error("Unable to replace superseded Codex history", error);
      }
    }) as EventListener);
    return () => source.close();
  }, [onSessionChange, session.id]);

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
    if (sending) {
      return;
    }
    if (editingMessageId) {
      setSending(true);
      setAttachmentError("");
      try {
        const response = await apiFetch<
          ApiEnvelope<{ requestId: string; session: CodexSession }>
        >(
          `/api/v1/sessions/${encodeURIComponent(session.id)}/turns/${encodeURIComponent(editingMessageId)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              text: content,
              images: pastedImages.map(encodeCodexComposerImage),
            }),
          },
        );
        sessionRef.current = response.data.session;
        onSessionChange(response.data.session);
        setEditingMessageId(null);
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : "Could not edit the Codex Turn.",
        );
        setSending(false);
        return;
      }
    } else {
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
            }),
          },
        );
        const next = {
          ...sessionRef.current,
          status: "running" as const,
          unread: false,
        };
        sessionRef.current = next;
        onSessionChange(next);
      } catch (error) {
        setAttachmentError(
          error instanceof Error ? error.message : "Could not start the Codex Turn.",
        );
        setSending(false);
        return;
      }
    }
    setDraft("");
    setPastedImages([]);
    setAttachmentError("");
    setSending(false);
  }

  async function deleteTurn(message: CodexMessageView) {
    if (sending) return;
    setSending(true);
    setDeleteMessageId(null);
    setAttachmentError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexSession>>(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns/${encodeURIComponent(message.id)}`,
        { method: "DELETE" },
      );
      sessionRef.current = response.data;
      onSessionChange(response.data);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : "Could not delete the Codex Turn.",
      );
    } finally {
      setSending(false);
    }
  }

  async function forkTurn(message: CodexMessageView) {
    if (sending) return;
    setSending(true);
    setForkingMessageId(message.id);
    setDeleteMessageId(null);
    setAttachmentError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexSession>>(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns/${encodeURIComponent(message.id)}/fork`,
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

  function beginEditing(message: CodexMessageView) {
    setDeleteMessageId(null);
    setEditingMessageId(message.id);
    setDraft(message.content);
    setPastedImages(message.attachments ?? []);
    setAttachmentError("");
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(
        message.content.length,
        message.content.length,
      );
    });
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
    scrollRegion.classList.add("is-scrolling");
    if (scrollbarHideTimerRef.current !== null) {
      window.clearTimeout(scrollbarHideTimerRef.current);
    }
    scrollbarHideTimerRef.current = window.setTimeout(() => {
      scrollRegion.classList.remove("is-scrolling");
      scrollbarHideTimerRef.current = null;
    }, 700);
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

      <div className="conversation-scroll" onScroll={handleConversationScroll}>
        <div className="message-column">
          {visibleMessages.map((message) => (
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
                {message.content ? <p>{message.content}</p> : null}

                {message.activities ? (
                  <div className="activity-list">
                    {message.activities.map((activity) => (
                      <div className="activity-row" key={activity.id}>
                        <span
                          className={`activity-status status-${activity.status}`}
                        >
                          {activityIcon(activity.status)}
                        </span>
                        <span className="activity-copy">
                          <strong>{activity.label}</strong>
                          <small>{activity.detail}</small>
                        </span>
                        {activity.duration ? (
                          <span className="activity-duration">
                            {activity.duration}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {message.diff ? (
                  <div className="diff-card">
                    <div className="diff-header">
                      <span>{message.diff.file}</span>
                      <span className="diff-stats">
                        <b>+{message.diff.additions}</b>
                        <i>-{message.diff.deletions}</i>
                      </span>
                    </div>
                    <pre>
                      <code>
                        {message.diff.lines.map((line, index) => (
                          <span
                            className={
                              line.startsWith("+")
                                ? "diff-addition"
                                : line.startsWith("-")
                                  ? "diff-deletion"
                                  : ""
                            }
                            key={`${line}-${index}`}
                          >
                            {line}
                          </span>
                        ))}
                      </code>
                    </pre>
                    <button
                      type="button"
                      className="diff-open-button"
                      onClick={() => onOpenInspector("files")}
                    >
                      {ui.openFile}
                    </button>
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
                  <div
                    className={`message-actions message-actions-user ${
                      deleteMessageId === message.id ? "is-confirming" : ""
                    }`}
                  >
                    {deleteMessageId === message.id ? (
                      <div
                        className="message-delete-confirm"
                        role="group"
                        aria-label={ui.confirmDelete}
                      >
                        <span>{ui.deleteFromHere}</span>
                        <button
                          type="button"
                          className="message-confirm-button"
                          onClick={() => void deleteTurn(message)}
                        >
                          {ui.delete}
                        </button>
                        <button
                          type="button"
                          aria-label={ui.cancelDelete}
                          title={ui.cancel}
                          onClick={() => setDeleteMessageId(null)}
                        >
                          <X size={13} aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={ui.editMessage}
                          title={ui.editFromHere}
                          disabled={
                            sending ||
                            session.status !== "waiting" ||
                            !session.harnessState.recoverableUserMessageItemIds?.includes(
                              message.id,
                            )
                          }
                          onClick={() => beginEditing(message)}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={ui.forkTurnMessage}
                          title={ui.forkTurnHere}
                          aria-busy={forkingMessageId === message.id}
                          disabled={
                            sending ||
                            session.status !== "waiting" ||
                            !session.harnessState.recoverableUserMessageItemIds?.includes(
                              message.id,
                            )
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
                        <button
                          type="button"
                          aria-label={ui.deleteMessage}
                          title={ui.deleteFromHere}
                          disabled={
                            sending ||
                            session.status !== "waiting" ||
                            !session.harnessState.recoverableUserMessageItemIds?.includes(
                              message.id,
                            )
                          }
                          onClick={() => setDeleteMessageId(message.id)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {message.role === "user" ? (
                <div className="user-avatar" role="img" aria-label={ui.you}>
                  YA
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>

      <div className="composer-region">
        <div className="composer-shell">
          {editingMessageId ? (
            <div className="composer-editing-notice" aria-live="polite">
              <span>
                <Pencil size={13} aria-hidden="true" /> {ui.editing}
              </span>
              <small>{ui.descendantsHidden}</small>
              <button
                type="button"
                aria-label={ui.cancelEditing}
                title={ui.cancelEditing}
                onClick={() => {
                  setEditingMessageId(null);
                  setDraft("");
                  setPastedImages([]);
                  setAttachmentError("");
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
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
            placeholder={
              editingMessageId
                ? ui.editPlaceholder
                : ui.askPlaceholder(environment.codingAgent.label)
            }
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
                <label className="composer-model-picker">
                  <span className="sr-only">
                    {ui.selectModel(environment.codingAgent.label)}
                  </span>
                  <select
                    name="coding-agent-model"
                    aria-label={ui.selectModel(
                      environment.codingAgent.label,
                    )}
                    value={selectedModel.id}
                    disabled
                    title="The model is fixed when this Codex Session starts."
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
              <span className="connection-copy">
                <span /> {ui.durableSession}
              </span>
              <button
                type="button"
                className="send-button"
                disabled={
                  sending ||
                  session.status !== "waiting" ||
                  (!draft.trim() && pastedImages.length === 0)
                }
                aria-label={ui.sendMessage}
                onClick={() => void submitMessage()}
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
        <p className="composer-footnote">
          <Files size={12} /> {ui.workingInWorkspace}
          <span>·</span>
          <Settings2 size={12} /> {ui.networkInherited(environment.name)}
        </p>
      </div>
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
