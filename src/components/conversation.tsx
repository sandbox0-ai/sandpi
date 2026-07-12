"use client";

import {
  Archive,
  ArrowUp,
  AtSign,
  Check,
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
import { useEffect, useRef, useState } from "react";

import type { InspectorTab } from "@/components/inspector";
import { SessionActionsMenu } from "@/components/session-actions-menu";
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
  onSendMessage: (content: string) => void;
  onDeleteUserMessage: (messageId: string) => void;
  onEditUserMessage: (messageId: string, content: string) => void;
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
  onDeleteUserMessage,
  onEditUserMessage,
  onForkUserMessage,
  onForkSession,
  onRenameSession,
  onArchiveSession,
  onTogglePinSession,
}: ConversationProps) {
  const ui = getOperationUiCopy(language).conversation;
  const [draft, setDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
  }, [session.id]);

  useEffect(() => {
    if (composerRef.current) {
      syncComposerHeight(composerRef.current);
    }
  }, [draft]);

  function submitMessage() {
    const content = draft.trim();
    if (!content) {
      return;
    }
    if (editingMessageId) {
      onEditUserMessage(editingMessageId, content);
      setEditingMessageId(null);
    } else {
      onSendMessage(content);
    }
    setDraft("");
  }

  function beginEditing(message: ChatMessage) {
    setDeleteMessageId(null);
    setEditingMessageId(message.id);
    setDraft(message.content);
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

      <div className="conversation-scroll">
        <div className="message-column">
          <div className="session-origin-card">
            <span className="origin-icon">
              <Archive size={15} />
            </span>
            <div>
              <strong>
                {session.origin?.kind === "session"
                  ? ui.sessionForkFrom(session.origin.label)
                  : session.origin?.kind === "turn"
                    ? ui.turnForkFrom(session.origin.label)
                    : ui.forkedFrom(session.origin?.label ?? environment.name)}
              </strong>
              {session.origin?.kind === "session" ? (
                <span>{ui.sessionForkDetail}</span>
              ) : session.origin?.kind === "turn" ? (
                <span>{ui.turnForkDetail(session.environmentRevision)}</span>
              ) : (
                <span>
                  {ui.environmentForkDetail(
                    session.environmentRevision,
                    environment.credentialRevision,
                  )}
                </span>
              )}
            </div>
            <span className="origin-duration">1.2s</span>
          </div>

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
                <p>{message.content}</p>

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
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
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
                {environment.codingAgent.label}
                <small>{ui.environment}</small>
              </span>
            </div>
            <div className="composer-send-area">
              <span className="connection-copy">
                <span /> {ui.durableSession}
              </span>
              <button
                type="button"
                className="send-button"
                disabled={!draft.trim()}
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
