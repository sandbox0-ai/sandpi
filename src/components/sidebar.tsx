"use client";

import {
  CircleHelp,
  FolderKanban,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";

import type { CodingSession, Environment } from "@/lib/types";

interface SidebarProps {
  environments: Environment[];
  sessions: CodingSession[];
  selectedEnvironmentId: string;
  selectedSessionId: string;
  onSelectEnvironment: (environmentId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewEnvironment: () => void;
  onNewSession: (environmentId: string) => void;
  onEnvironmentSettings: (environmentId: string) => void;
  onPreferences: () => void;
  onCloseMobile: () => void;
}

function StatusDot({ status }: { status: CodingSession["status"] }) {
  return <span className={`session-status-dot status-${status}`} aria-hidden="true" />;
}

export function Sidebar({
  environments,
  sessions,
  selectedEnvironmentId,
  selectedSessionId,
  onSelectEnvironment,
  onSelectSession,
  onNewEnvironment,
  onNewSession,
  onEnvironmentSettings,
  onPreferences,
  onCloseMobile,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Sandpi navigation">
      <div className="sidebar-brand-row">
        <div className="brand-lockup" aria-label="Sandpi">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>sandpi</span>
        </div>
        <button
          className="icon-button sidebar-close-button"
          type="button"
          aria-label="Close navigation"
          onClick={onCloseMobile}
        >
          <X size={18} />
        </button>
      </div>

      <button className="new-session-button" type="button" onClick={onNewEnvironment}>
        <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
        New environment
        <span className="keyboard-hint">⌘ ⇧ N</span>
      </button>

      <button className="sidebar-search" type="button">
        <Search size={16} aria-hidden="true" />
        <span>Search sessions</span>
        <span className="keyboard-hint">⌘ K</span>
      </button>

      <div className="sidebar-scroll-region">
        <div className="sidebar-section-heading">
          <span>Environments</span>
        </div>

        <div className="environment-list">
          {environments.map((environment) => {
            const environmentSessions = sessions.filter(
              (session) => session.environmentId === environment.id,
            );
            const selected = environment.id === selectedEnvironmentId;

            return (
              <section className="environment-group" key={environment.id}>
                <div className={`environment-row ${selected ? "is-selected" : ""}`}>
                  <button
                    className="environment-main-button"
                    type="button"
                    onClick={() => onSelectEnvironment(environment.id)}
                  >
                    <span
                      className="environment-avatar"
                      style={{ backgroundColor: environment.color }}
                      aria-hidden="true"
                    >
                      {environment.name.slice(0, 1)}
                    </span>
                    <span className="environment-name">{environment.name}</span>
                  </button>
                  <span className="environment-row-actions">
                    <button
                      type="button"
                      aria-label={`New session in ${environment.name}`}
                      title="New session"
                      onClick={() => onNewSession(environment.id)}
                    >
                      <Plus size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`${environment.name} settings`}
                      title="Environment settings"
                      onClick={() => onEnvironmentSettings(environment.id)}
                    >
                      <MoreHorizontal size={15} aria-hidden="true" />
                    </button>
                  </span>
                </div>

                <div className="session-list">
                  {environmentSessions.map((session) => (
                    <button
                      className={`session-row ${
                        session.id === selectedSessionId ? "is-selected" : ""
                      }`}
                      type="button"
                      key={session.id}
                      onClick={() => onSelectSession(session.id)}
                    >
                      <StatusDot status={session.status} />
                      <span className="session-title">{session.title}</span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-footer-button" onClick={onPreferences}>
          <Settings size={16} />
          Preferences
        </button>
        <button type="button" className="sidebar-footer-button">
          <CircleHelp size={16} />
          Help & feedback
        </button>
        <div className="account-row">
          <span className="account-avatar">YA</span>
          <span className="account-copy">
            <strong>Yan Assistant</strong>
            <small>Personal team</small>
          </span>
          <FolderKanban size={15} />
        </div>
      </div>
    </aside>
  );
}
