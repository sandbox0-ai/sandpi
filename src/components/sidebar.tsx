"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CircleHelp,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings,
  Settings2,
  X,
} from "lucide-react";

import { SessionActionsMenu } from "@/components/session-actions-menu";
import { SessionSearchDialog } from "@/components/session-search-dialog";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import type { CodingSession, Environment } from "@/lib/types";
import { visibleSessionsForEnvironment } from "@/lib/session-list";

interface SidebarProps {
  language: OperationLanguage;
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

/**
 * Cross-client contract: Web, iOS, Android, and HarmonyOS use this marker only
 * for unread Session activity. It must never represent runtime or Session status,
 * and its accessible name is localized as "Unread" or "未读".
 */
function UnreadActivityDot({
  unread,
  label,
}: {
  unread: boolean;
  label: "Unread" | "未读";
}) {
  return (
    <span
      className="session-unread-dot"
      role={unread ? "img" : undefined}
      aria-label={unread ? label : undefined}
      aria-hidden={unread ? undefined : true}
      style={{ visibility: unread ? "visible" : "hidden" }}
    />
  );
}

export function Sidebar({
  language,
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
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "k"
      ) {
        event.preventDefault();
        setSessionSearchOpen(true);
      }
    };

    document.addEventListener("keydown", handleSearchShortcut);
    return () => document.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      accountMenuRef.current
        ?.querySelector<HTMLElement>("[role='menuitem']")
        ?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !accountMenuRef.current?.contains(target) &&
        !accountTriggerRef.current?.contains(target)
      ) {
        setAccountMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setAccountMenuOpen(false);
      window.requestAnimationFrame(() => accountTriggerRef.current?.focus());
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  function handleAccountMenuKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
    );
    const activeIndex = menuItems.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown") {
      nextIndex = activeIndex < menuItems.length - 1 ? activeIndex + 1 : 0;
    } else if (event.key === "ArrowUp") {
      nextIndex = activeIndex > 0 ? activeIndex - 1 : menuItems.length - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = menuItems.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    }
  }

  return (
    <>
      <aside className="sidebar" aria-label={ui.navigation}>
        <div className="sidebar-brand-row">
          <div className="brand-lockup" aria-label="Sandpi">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
            </span>
            <span>sandpi</span>
          </div>
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
        </div>

        <button
          className="new-session-button"
          type="button"
          onClick={onNewEnvironment}
        >
          <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
          {ui.newEnvironment}
          <span className="keyboard-hint">⌘ ⇧ N</span>
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
          <span className="keyboard-hint">⌘ K</span>
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
                      <button
                        type="button"
                        aria-label={ui.environmentSettingsFor(environment.name)}
                        title={ui.environmentSettings}
                        onClick={() => onEnvironmentSettings(environment.id)}
                      >
                        <Settings2 size={14} aria-hidden="true" />
                      </button>
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
                          <UnreadActivityDot
                            unread={session.unread}
                            label={unreadLabel}
                          />
                          <span className="session-title">{session.title}</span>
                        </button>

                        <SessionActionsMenu
                          language={language}
                          session={session}
                          triggerClassName="session-more-button"
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

        <div className="sidebar-footer">
          <button
            ref={accountTriggerRef}
            type="button"
            className={`account-menu-trigger ${accountMenuOpen ? "is-open" : ""}`}
            aria-label={ui.accountMenu}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            onClick={() => setAccountMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (
                !accountMenuOpen &&
                (event.key === "ArrowUp" || event.key === "ArrowDown")
              ) {
                event.preventDefault();
                setAccountMenuOpen(true);
              }
            }}
          >
            <span className="account-avatar">YA</span>
            <span className="account-copy">
              <strong>Yan Assistant</strong>
              <small>{ui.personalTeam}</small>
            </span>
          </button>
          {accountMenuOpen ? (
            <div
              ref={accountMenuRef}
              className="sidebar-account-menu"
              role="menu"
              aria-label={ui.accountActions}
              onKeyDown={handleAccountMenuKeyDown}
            >
              <Link
                href="/preferences"
                role="menuitem"
                onClick={() => setAccountMenuOpen(false)}
              >
                <Settings size={15} aria-hidden="true" />
                {ui.preferences}
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => setAccountMenuOpen(false)}
              >
                <CircleHelp size={15} aria-hidden="true" />
                {ui.help}
              </button>
            </div>
          ) : null}
        </div>
      </aside>
      {sessionSearchOpen ? (
        <SessionSearchDialog
          environments={environments}
          sessions={sessions}
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
