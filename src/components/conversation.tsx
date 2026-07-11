"use client";

import {
  Archive,
  ArrowUp,
  AtSign,
  Check,
  Files,
  Gauge,
  GitBranch,
  Menu,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { useState } from "react";

import type { InspectorTab } from "@/components/inspector";
import type { CodingSession, Environment, ToolActivity } from "@/lib/types";

interface ConversationProps {
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
}

function activityIcon(status: ToolActivity["status"]) {
  if (status === "completed") {
    return <Check size={13} strokeWidth={2.6} />;
  }
  return <span className="activity-spinner" />;
}

function formatExpiry(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function Conversation({
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
}: ConversationProps) {
  const [draft, setDraft] = useState("");

  function submitMessage() {
    const content = draft.trim();
    if (!content) {
      return;
    }
    onSendMessage(content);
    setDraft("");
  }

  return (
    <section
      id="conversation"
      className="conversation-pane"
      aria-label="Coding agent conversation"
      tabIndex={-1}
    >
      <header className="conversation-header">
        <div className="conversation-title-area">
          <button
            type="button"
            className="icon-button mobile-menu-button"
            aria-label="Open navigation"
            onClick={onToggleSidebar}
          >
            <Menu size={19} />
          </button>
          <div>
            <div className="conversation-breadcrumb">
              <button type="button" onClick={onOpenSettings}>
                {environment.name}
              </button>
              <span>/</span>
              <span>{session.title}</span>
            </div>
            <div className="conversation-meta">
              <span className={`live-indicator status-${session.status}`} />
              <span>{session.status === "running" ? "Agent running" : session.status}</span>
              <span className="meta-separator">·</span>
              <GitBranch size={12} />
              <span>{session.branch}</span>
            </div>
          </div>
        </div>

        <div className="conversation-header-actions">
          <button
            type="button"
            className={`header-action-button ${terminalOpen ? "is-active" : ""}`}
            onClick={onToggleTerminal}
          >
            <SquareTerminal size={15} aria-hidden="true" />
            <span>Terminal</span>
          </button>
          <button
            type="button"
            className="header-action-button"
            onClick={() => onOpenInspector("audit")}
          >
            <ShieldCheck size={15} />
            <span>Audit</span>
          </button>
          <button
            type="button"
            className="header-action-button"
            onClick={() => onOpenInspector("metrics")}
          >
            <Gauge size={15} />
            <span>Metrics</span>
          </button>
          <button
            type="button"
            className={`icon-button ${inspectorOpen ? "is-active" : ""}`}
            aria-label={inspectorOpen ? "Close inspector" : "Open inspector"}
            onClick={onToggleInspector}
          >
            <PanelRight size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="More session actions">
            <MoreHorizontal size={19} />
          </button>
        </div>
      </header>

      <div className="session-context-strip">
        <span>
          <SquareTerminal size={13} />
          {session.harnessLabel} · {session.modelLabel}
        </span>
        <span>Environment r{session.environmentRevision}</span>
        <span className="context-spacer" />
        <span>Hard TTL · {formatExpiry(session.hardExpiresAt)}</span>
      </div>

      <div className="conversation-scroll">
        <div className="message-column">
          <div className="session-origin-card">
            <span className="origin-icon">
              <Archive size={15} />
            </span>
            <div>
              <strong>Forked from {environment.name}</strong>
              <span>
                Revision {session.environmentRevision} · private workspace Volume · credential
                revision {environment.credentialRevision}
              </span>
            </div>
            <span className="origin-duration">1.2s</span>
          </div>

          {session.messages.map((message) => (
            <article className={`message message-${message.role}`} key={message.id}>
              {message.role === "assistant" ? (
                <div className="assistant-avatar" aria-label="Codex">
                  <span />
                </div>
              ) : null}
              <div className="message-body">
                <div className="message-author">
                  {message.role === "user" ? "You" : session.harnessLabel}
                </div>
                <p>{message.content}</p>

                {message.activities ? (
                  <div className="activity-list">
                    {message.activities.map((activity) => (
                      <div className="activity-row" key={activity.id}>
                        <span className={`activity-status status-${activity.status}`}>
                          {activityIcon(activity.status)}
                        </span>
                        <span className="activity-copy">
                          <strong>{activity.label}</strong>
                          <small>{activity.detail}</small>
                        </span>
                        {activity.duration ? (
                          <span className="activity-duration">{activity.duration}</span>
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
                      Open file
                    </button>
                  </div>
                ) : null}

                {message.role === "assistant" ? (
                  <div className="message-actions">
                    <button type="button" aria-label="Retry response">
                      <RotateCcw size={13} />
                    </button>
                    <button type="button">Copy</button>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="composer-region">
        <div className="composer-shell">
          <textarea
            name="message"
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitMessage();
              }
            }}
            aria-label="Message Codex"
            placeholder="Ask Codex to work in this session…"
            rows={1}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <button type="button" className="composer-icon-button" aria-label="Attach file">
                <Paperclip size={17} />
              </button>
              <button type="button" className="composer-icon-button" aria-label="Mention file">
                <AtSign size={17} />
              </button>
              <span className="composer-agent-bound" title="Bound to this Environment">
                <span className="codex-glyph" />
                {environment.codingAgent.label}
                <small>Environment</small>
              </span>
            </div>
            <div className="composer-send-area">
              <span className="connection-copy">
                <span /> Durable session
              </span>
              <button
                type="button"
                className="send-button"
                disabled={!draft.trim()}
                aria-label="Send message"
                onClick={submitMessage}
              >
                <ArrowUp size={17} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
        <p className="composer-footnote">
          <Files size={12} /> Working in /workspace
          <span>·</span>
          <Settings2 size={12} /> Network policy inherited from {environment.name}
        </p>
      </div>
    </section>
  );
}
