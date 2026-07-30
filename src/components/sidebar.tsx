"use client";

import { useState } from "react";
import {
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";

import { SidebarAccountFooter } from "@/components/sidebar-account-footer";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import { SessionSearchDialog } from "@/components/session-search-dialog";
import { AppSidebar } from "@/components/app-frame";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import { sessionStateMarker } from "@/lib/session-state-marker";
import type {
  CodingSession,
  Environment,
  SandpiUser,
} from "@/lib/types";
import { visibleSessionsForEnvironment } from "@/lib/session-list";

interface SidebarProps {
  language: OperationLanguage;
  viewer: SandpiUser;
  environments: Environment[];
  sessions: CodingSession[];
  selectedEnvironmentId: string;
  selectedSessionId: string;
  onSelectEnvironment: (environmentId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewEnvironment: () => void;
  onNewSession: (environmentId: string) => void;
  onEnvironmentSettings: (environmentId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onForkSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
  onCollapse: () => void;
  onCloseMobile: () => void;
}

function SessionStateIndicator({
  session,
  unreadLabel,
  runningLabel,
}: {
  session: CodingSession;
  unreadLabel: "Unread" | "未读";
  runningLabel: "Running" | "运行中";
}) {
  const marker = sessionStateMarker(session);
  if (!marker) return null;

  return (
    <span className="session-state-indicator">
      {marker === "running" ? (
        <span
          className="session-running-indicator"
          role="img"
          aria-label={runningLabel}
        />
      ) : (
        <span
          className="session-unread-dot"
          role="img"
          aria-label={unreadLabel}
        />
      )}
    </span>
  );
}

export function Sidebar({
  language,
  viewer,
  environments,
  sessions,
  selectedEnvironmentId,
  selectedSessionId,
  onSelectEnvironment,
  onSelectSession,
  onNewEnvironment,
  onNewSession,
  onEnvironmentSettings,
  onRenameSession,
  onForkSession,
  onArchiveSession,
  onTogglePinSession,
  onCollapse,
  onCloseMobile,
}: SidebarProps) {
  const ui = getOperationUiCopy(language).sidebar;
  const unreadLabel = language === "zh-CN" ? "未读" : "Unread";
  const runningLabel = language === "zh-CN" ? "运行中" : "Running";
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);

  return (
    <>
      <AppSidebar
        className="sidebar"
        label={ui.navigation}
        footer={
          <SidebarAccountFooter
            language={language}
            viewer={viewer}
          />
        }
        headerAction={
          <>
            <button
              className="icon-button sidebar-collapse-button"
              type="button"
              aria-label={ui.collapse}
              title={ui.collapse}
              onClick={onCollapse}
            >
              <PanelLeftClose size={17} aria-hidden="true" />
            </button>
            <button
              className="icon-button sidebar-close-button"
              type="button"
              aria-label={ui.close}
              onClick={onCloseMobile}
            >
              <X size={18} />
            </button>
          </>
        }
      >
        <button
          className="new-session-button"
          type="button"
          onClick={onNewEnvironment}
        >
          <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
          {ui.newEnvironment}
        </button>

        <button
          className="sidebar-search"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={sessionSearchOpen}
          onClick={() => setSessionSearchOpen(true)}
        >
          <Search size={16} aria-hidden="true" />
          <span>{ui.searchSessions}</span>
        </button>

        <div className="sidebar-scroll-region">
          <div className="sidebar-section-heading">
            <span>{ui.environments}</span>
          </div>

          <div className="environment-list">
            {environments.map((environment) => {
              const environmentSessions = visibleSessionsForEnvironment(
                sessions,
                environment.id,
              );
              const selected = environment.id === selectedEnvironmentId;
              const canManage = environment.ownerId === viewer.id;

              return (
                <section className="environment-group" key={environment.id}>
                  <div
                    className={`environment-row ${selected ? "is-selected" : ""}`}
                  >
                    <button
                      className="environment-main-button"
                      type="button"
                      aria-current={selected ? "page" : undefined}
                      onClick={() => onSelectEnvironment(environment.id)}
                    >
                      <span
                        className="environment-avatar"
                        style={{ backgroundColor: environment.color }}
                        aria-hidden="true"
                      >
                        {environment.name.slice(0, 1)}
                      </span>
                      <span className="environment-name">
                        {environment.name}
                      </span>
                    </button>
                    <span className="environment-row-actions">
                      <button
                        type="button"
                        aria-label={ui.newSessionIn(environment.name)}
                        title={ui.newSession}
                        onClick={() => onNewSession(environment.id)}
                      >
                        <Plus size={14} aria-hidden="true" />
                      </button>
                      {canManage ? (
                        <button
                          type="button"
                          aria-label={ui.environmentSettingsFor(environment.name)}
                          title={ui.environmentSettings}
                          onClick={() => onEnvironmentSettings(environment.id)}
                        >
                          <Settings2 size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                    </span>
                  </div>

                  <div className="session-list">
                    {environmentSessions.map((session) => (
                      <div
                        className={`session-row ${
                          session.id === selectedSessionId ? "is-selected" : ""
                        }`}
                        key={session.id}
                      >
                        <button
                          className="session-main-button"
                          type="button"
                          onClick={() => onSelectSession(session.id)}
                        >
                          {session.pinned ? (
                            <Pin
                              className="session-pinned-icon"
                              size={10}
                              aria-label={ui.pinned}
                            />
                          ) : null}
                          <SessionStateIndicator
                            session={session}
                            unreadLabel={unreadLabel}
                            runningLabel={runningLabel}
                          />
                          {session.owner && session.owner.id !== viewer.id ? (
                            <span
                              className="session-owner-avatar"
                              title={`Owner: ${session.owner.name}`}
                              aria-label={`Owner: ${session.owner.name}`}
                            >
                              {session.owner.avatarInitials}
                            </span>
                          ) : null}
                          <span className="session-title">{session.title}</span>
                        </button>

                        <SessionActionsMenu
                          language={language}
                          session={session}
                          triggerClassName="session-more-button"
                          sessionForkEnabled={session.status === "waiting"}
                          onForkSession={onForkSession}
                          onRenameSession={onRenameSession}
                          onArchiveSession={onArchiveSession}
                          onTogglePinSession={onTogglePinSession}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </AppSidebar>
      {sessionSearchOpen ? (
        <SessionSearchDialog
          environments={environments}
          sessions={sessions}
          viewerId={viewer.id}
          onClose={() => setSessionSearchOpen(false)}
          onSelect={(sessionId) => {
            setSessionSearchOpen(false);
            onSelectSession(sessionId);
          }}
        />
      ) : null}
    </>
  );
}
