"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Archive,
  CircleHelp,
  FolderKanban,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";

import { SessionSearchDialog } from "@/components/session-search-dialog";
import type { CodingSession, Environment } from "@/lib/types";
import { visibleSessionsForEnvironment } from "@/lib/session-list";

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
  onRenameSession: (sessionId: string, title: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
  onCloseMobile: () => void;
}

interface SessionMenuPosition {
  top: number;
  left: number;
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
  onRenameSession,
  onArchiveSession,
  onTogglePinSession,
  onCloseMobile,
}: SidebarProps) {
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionMenuPosition, setSessionMenuPosition] =
    useState<SessionMenuPosition | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const sessionMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const skipRenameCommitRef = useRef(false);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setOpenSessionMenuId(null);
        setSessionMenuPosition(null);
        setSessionSearchOpen(true);
      }
    };

    document.addEventListener("keydown", handleSearchShortcut);
    return () => document.removeEventListener("keydown", handleSearchShortcut);
  }, []);

  useEffect(() => {
    if (!openSessionMenuId) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;

      if (
        !sessionMenuRef.current?.contains(target) &&
        !sessionMenuTriggerRef.current?.contains(target)
      ) {
        setOpenSessionMenuId(null);
        setSessionMenuPosition(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      setOpenSessionMenuId(null);
      setSessionMenuPosition(null);
      sessionMenuTriggerRef.current?.focus();
    };

    const handleViewportChange = () => {
      setOpenSessionMenuId(null);
      setSessionMenuPosition(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [openSessionMenuId]);

  useEffect(() => {
    if (!openSessionMenuId) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      sessionMenuRef.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']")
        ?.focus();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [openSessionMenuId]);

  const closeSessionMenu = () => {
    setOpenSessionMenuId(null);
    setSessionMenuPosition(null);
  };

  const toggleSessionMenu = (
    sessionId: string,
    trigger: HTMLButtonElement,
  ) => {
    if (openSessionMenuId === sessionId) {
      closeSessionMenu();
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = 158;
    const menuHeight = 112;
    const viewportGap = 8;
    const top =
      triggerRect.bottom + 4 + menuHeight <= window.innerHeight - viewportGap
        ? triggerRect.bottom + 4
        : triggerRect.top - menuHeight - 4;

    sessionMenuTriggerRef.current = trigger;
    setSessionMenuPosition({
      top: Math.max(viewportGap, top),
      left: Math.min(
        Math.max(viewportGap, triggerRect.right - menuWidth),
        window.innerWidth - menuWidth - viewportGap,
      ),
    });
    setOpenSessionMenuId(sessionId);
  };

  const beginRename = (session: CodingSession) => {
    closeSessionMenu();
    skipRenameCommitRef.current = false;
    setRenameDraft(session.title);
    setRenamingSessionId(session.id);
  };

  const commitRename = (session: CodingSession) => {
    const nextTitle = renameDraft.trim();

    if (nextTitle && nextTitle !== session.title) {
      onRenameSession(session.id, nextTitle);
    }

    setRenamingSessionId(null);
    setRenameDraft("");
  };

  const cancelRename = () => {
    skipRenameCommitRef.current = true;
    setRenamingSessionId(null);
    setRenameDraft("");
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
    );
    const activeIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
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
  };

  return (
    <>
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

      <button
        className="sidebar-search"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={sessionSearchOpen}
        onClick={() => setSessionSearchOpen(true)}
      >
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
            const environmentSessions = visibleSessionsForEnvironment(
              sessions,
              environment.id,
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
                  {environmentSessions.map((session) => {
                    const menuIsOpen = openSessionMenuId === session.id;
                    const isRenaming = renamingSessionId === session.id;

                    return (
                      <div
                        className={`session-row ${
                          session.id === selectedSessionId ? "is-selected" : ""
                        } ${menuIsOpen ? "menu-is-open" : ""}`}
                        key={session.id}
                      >
                        {isRenaming ? (
                          <span className="session-rename-shell">
                            {session.pinned ? (
                              <Pin
                                className="session-pinned-icon"
                                size={10}
                                aria-label="Pinned"
                              />
                            ) : null}
                            <StatusDot status={session.status} />
                            <input
                              className="session-rename-input"
                              aria-label={`Rename ${session.title}`}
                              autoFocus
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onBlur={() => {
                                if (skipRenameCommitRef.current) {
                                  skipRenameCommitRef.current = false;
                                  return;
                                }
                                commitRename(session);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitRename(session);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelRename();
                                }
                              }}
                            />
                          </span>
                        ) : (
                          <button
                            className="session-main-button"
                            type="button"
                            onClick={() => onSelectSession(session.id)}
                          >
                            {session.pinned ? (
                              <Pin
                                className="session-pinned-icon"
                                size={10}
                                aria-label="Pinned"
                              />
                            ) : null}
                            <StatusDot status={session.status} />
                            <span className="session-title">{session.title}</span>
                          </button>
                        )}

                        <button
                          className="session-more-button"
                          type="button"
                          aria-label={`Session actions for ${session.title}`}
                          aria-haspopup="menu"
                          aria-expanded={menuIsOpen}
                          onClick={(event) =>
                            toggleSessionMenu(session.id, event.currentTarget)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                              event.preventDefault();
                              if (!menuIsOpen) {
                                toggleSessionMenu(session.id, event.currentTarget);
                              }
                            }
                          }}
                        >
                          <MoreHorizontal size={15} aria-hidden="true" />
                        </button>

                        {menuIsOpen && sessionMenuPosition ? (
                          <div
                            className="session-action-menu"
                            ref={sessionMenuRef}
                            role="menu"
                            aria-label={`Actions for ${session.title}`}
                            style={sessionMenuPosition}
                            onKeyDown={handleMenuKeyDown}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                closeSessionMenu();
                                onTogglePinSession(session.id);
                              }}
                            >
                              {session.pinned ? (
                                <PinOff size={14} aria-hidden="true" />
                              ) : (
                                <Pin size={14} aria-hidden="true" />
                              )}
                              {session.pinned ? "Unpin" : "Pin"}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => beginRename(session)}
                            >
                              <Pencil size={14} aria-hidden="true" />
                              Rename
                            </button>
                            <button
                              className="is-destructive"
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                closeSessionMenu();
                                onArchiveSession(session.id);
                              }}
                            >
                              <Archive size={14} aria-hidden="true" />
                              Archive
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="sidebar-footer">
        <Link className="sidebar-footer-button" href="/preferences">
          <Settings size={16} />
          Preferences
        </Link>
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
