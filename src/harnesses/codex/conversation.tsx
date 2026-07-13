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
  getMockCodexModel,
  getMockCodexModels,
} from "@/harnesses/codex/models";
import {
  appendMockCodexTurn,
  deleteMockCodexTurn,
  editMockCodexTurn,
  forkMockCodexTurn,
} from "@/harnesses/codex/session-actions";
import { visibleCodexConversationWhileEditing } from "@/harnesses/codex/timeline";
import type {
  CodexComposerImage,
  CodexSession,
} from "@/harnesses/codex/types";
import type {
  CodexMessageView,
  CodexToolActivityView,
} from "@/harnesses/codex/events";
import { createId } from "@/lib/id";
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
  onCreateSession: (session: CodexSession) => void;
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

async function copyText(content: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(content);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = content;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.select();
  document.execCommand("copy");
  fallback.remove();
}

function syncComposerHeight(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

const MAX_COMPOSER_IMAGES = 6;
const MAX_COMPOSER_IMAGE_BYTES = 10 * 1024 * 1024;

function readImageAttachment(file: File): Promise<CodexComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Clipboard image did not produce a preview URL."));
        return;
      }
      resolve({
        id: createId("image", 10),
        name: file.name || "clipboard-image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: reader.result,
      });
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
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
  onCreateSession,
  onForkSession,
  onRenameSession,
  onArchiveSession,
  onTogglePinSession,
}: ConversationProps) {
  const ui = getCodexUiCopy(language).conversation;
  const modelOptions = getMockCodexModels();
  const selectedModel = getMockCodexModel(session.harnessState.modelId);
  const [draft, setDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<CodexComposerImage[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  // This operates on Codex-native Turn/item boundaries. Other clients must implement the same
  // editing UX in their own harness reducer instead of consuming a shared message timeline.
  const visibleMessages = visibleCodexConversationWhileEditing(
    session.harnessState.events,
    editingMessageId,
  );

  useEffect(() => {
    setDraft("");
    setDeleteMessageId(null);
    setEditingMessageId(null);
    setPastedImages([]);
    setAttachmentError("");
  }, [session.id]);

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

  function submitMessage() {
    const content = draft.trim();
    if (!content && pastedImages.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    if (editingMessageId) {
      const next = editMockCodexTurn(
        session,
        editingMessageId,
        content,
        pastedImages,
        now,
      );
      if (next) {
        onSessionChange(next);
      }
      setEditingMessageId(null);
    } else {
      onSessionChange(appendMockCodexTurn(session, content, pastedImages, now));
    }
    setDraft("");
    setPastedImages([]);
    setAttachmentError("");
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
      await copyText(message.content);
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
    const availableSlots = MAX_COMPOSER_IMAGES - pastedImages.length;
    if (availableSlots <= 0) {
      setAttachmentError(ui.imageLimit(MAX_COMPOSER_IMAGES));
      return;
    }

    const filesWithinLimit = files
      .filter((file) => file.size <= MAX_COMPOSER_IMAGE_BYTES)
      .slice(0, availableSlots);
    if (filesWithinLimit.length === 0) {
      setAttachmentError(ui.imageTooLarge);
      return;
    }

    if (files.some((file) => file.size > MAX_COMPOSER_IMAGE_BYTES)) {
      setAttachmentError(ui.imageTooLarge);
    } else if (files.length > availableSlots) {
      setAttachmentError(ui.imageLimit(MAX_COMPOSER_IMAGES));
    } else {
      setAttachmentError("");
    }

    try {
      const attachments = await Promise.all(
        filesWithinLimit.map(readImageAttachment),
      );
      setPastedImages((current) =>
        [...current, ...attachments].slice(0, MAX_COMPOSER_IMAGES),
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
                          onClick={() => {
                            const next = deleteMockCodexTurn(
                              session,
                              message.id,
                              new Date().toISOString(),
                            );
                            if (next) {
                              onSessionChange(next);
                            }
                            setDeleteMessageId(null);
                          }}
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
                          onClick={() => beginEditing(message)}
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={ui.forkTurnMessage}
                          title={ui.forkTurnHere}
                          onClick={() => {
                            const forked = forkMockCodexTurn(
                              session,
                              message.id,
                              new Date().toISOString(),
                            );
                            if (forked) {
                              onCreateSession(forked);
                            }
                          }}
                        >
                          <GitFork size={14} aria-hidden="true" />
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
              const imageFiles = Array.from(event.clipboardData.items)
                .filter(
                  (item) =>
                    item.kind === "file" && item.type.startsWith("image/"),
                )
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
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
                submitMessage();
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
              >
                <Paperclip size={17} />
              </button>
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
                    onChange={(event) =>
                      onSessionChange({
                        ...session,
                        harnessState: {
                          ...session.harnessState,
                          modelId: event.target.value,
                        },
                      })
                    }
                  >
                    {modelOptions.map((model) => (
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
                disabled={!draft.trim() && pastedImages.length === 0}
                aria-label={ui.sendMessage}
                onClick={submitMessage}
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
