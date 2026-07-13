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
import { getMockCodingAgentModels } from "@/lib/coding-agent-models";
import { createId } from "@/lib/id";
import { visibleTimelineWhileEditing } from "@/lib/message-timeline";
import {
  getOperationUiCopy,
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import type {
  ChatMessage,
  CodingSession,
  Environment,
  MessageImageAttachment,
  ToolActivity,
} from "@/lib/types";

interface ConversationProps {
  language: OperationLanguage;
  sendShortcut: SendShortcut;
  environment: Environment;
  session: CodingSession;
  inspectorOpen: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onOpenInspector: (tab: InspectorTab) => void;
  onSendMessage: (
    content: string,
    attachments: MessageImageAttachment[],
  ) => void;
  onSelectModel: (sessionId: string, modelLabel: string) => void;
  onDeleteUserMessage: (messageId: string) => void;
  onEditUserMessage: (
    messageId: string,
    content: string,
    attachments: MessageImageAttachment[],
  ) => void;
  onForkUserMessage: (messageId: string) => void;
  onForkSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
}

function activityIcon(status: ToolActivity["status"]) {
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

function readImageAttachment(file: File): Promise<MessageImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Clipboard image did not produce a preview URL."));
        return;
      }
      resolve({
        id: createId("image", 10),
        kind: "image",
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

export function Conversation({
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
  onSendMessage,
  onSelectModel,
  onDeleteUserMessage,
  onEditUserMessage,
  onForkUserMessage,
  onForkSession,
  onRenameSession,
  onArchiveSession,
  onTogglePinSession,
}: ConversationProps) {
  const ui = getOperationUiCopy(language).conversation;
  const modelOptions = getMockCodingAgentModels(
    environment.codingAgent.harness,
  );
  const selectedModelLabel = modelOptions.some(
    (model) => model.label === session.modelLabel,
  )
    ? session.modelLabel
    : modelOptions[0].label;
  const [draft, setDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<MessageImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  // Do not render session.messages directly while editing. Edit is a branch rewrite, and all
  // clients must hide the stale Turn and descendants so Send cannot be mistaken for append.
  const visibleMessages = visibleTimelineWhileEditing(
    session.messages,
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
    if (editingMessageId) {
      onEditUserMessage(editingMessageId, content, pastedImages);
      setEditingMessageId(null);
    } else {
      onSendMessage(content, pastedImages);
    }
    setDraft("");
    setPastedImages([]);
    setAttachmentError("");
  }

  function beginEditing(message: ChatMessage) {
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

  async function copyMessage(message: ChatMessage) {
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
                {session.harnessLabel} · {session.modelLabel} ·{" "}
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
                            onDeleteUserMessage(message.id);
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
                          onClick={() => onForkUserMessage(message.id)}
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
                    value={selectedModelLabel}
                    onChange={(event) =>
                      onSelectModel(session.id, event.target.value)
                    }
                  >
                    {modelOptions.map((model) => (
                      <option value={model.label} key={model.id}>
                        {model.label}
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
