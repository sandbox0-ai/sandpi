"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  CircleHelp,
  CreditCard,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings,
  Settings2,
  UsersRound,
  X,
} from "lucide-react";

import { SessionActionsMenu } from "@/components/session-actions-menu";
import { SessionSearchDialog } from "@/components/session-search-dialog";
import {
  SidebarAccountSummary,
} from "@/components/sidebar-primitives";
import { AppSidebar } from "@/components/app-frame";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import { quotaPercent } from "@/lib/team";
import type {
  CodingSession,
  Environment,
  SandpiUser,
  Team,
} from "@/lib/types";
import { visibleSessionsForEnvironment } from "@/lib/session-list";

interface SidebarProps {
  language: OperationLanguage;
  viewer: SandpiUser;
  teams: Team[];
  selectedTeamId: string;
  environments: Environment[];
  sessions: CodingSession[];
  selectedEnvironmentId: string;
  selectedSessionId: string;
  onSelectEnvironment: (environmentId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectTeam: (teamId: string) => void;
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
  viewer,
  teams,
  selectedTeamId,
  environments,
  sessions,
  selectedEnvironmentId,
  selectedSessionId,
  onSelectEnvironment,
  onSelectSession,
  onSelectTeam,
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
  const selectedTeam =
    teams.find((team) => team.id === selectedTeamId) ?? teams[0];
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
      event.currentTarget.querySelectorAll<HTMLElement>(
        "[role='menuitem'], [role='menuitemradio']",
      ),
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

  const accountFooter = (
    <>
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
        <SidebarAccountSummary
          viewer={viewer}
          context={selectedTeam?.name ?? ui.noTeam}
        />
      </button>
      {accountMenuOpen ? (
        <div
          ref={accountMenuRef}
          className="sidebar-account-menu"
          role="menu"
          aria-label={ui.accountActions}
          onKeyDown={handleAccountMenuKeyDown}
        >
          <div className="account-menu-section-label">{ui.switchTeam}</div>
          <div className="account-team-list" role="group" aria-label={ui.teams}>
            {teams.map((team) => {
              const selected = team.id === selectedTeamId;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  key={team.id}
                  onClick={() => {
                    onSelectTeam(team.id);
                    setAccountMenuOpen(false);
                  }}
                >
                  <span
                    className="account-team-avatar"
                    style={{ backgroundColor: team.color }}
                    aria-hidden="true"
                  >
                    {team.name.slice(0, 1)}
                  </span>
                  <span className="account-team-copy">
                    <strong>{team.name}</strong>
                    <small>{ui.members(team.memberCount)}</small>
                  </span>
                  {selected ? <Check size={14} aria-label={ui.currentTeam} /> : null}
                </button>
              );
            })}
          </div>
          {selectedTeam ? (
            <div className="account-quota-summary">
              <div>
                <span>
                  <CreditCard size={13} aria-hidden="true" />
                  {selectedTeam.subscription.planName}
                </span>
                <strong>
                  {quotaPercent(
                    selectedTeam.subscription.quotas.weeklyExecution.used,
                    selectedTeam.subscription.quotas.weeklyExecution.limit,
                  )}
                  %
                </strong>
              </div>
              <span className="account-quota-track" aria-hidden="true">
                <i
                  style={{
                    width: `${quotaPercent(
                      selectedTeam.subscription.quotas.weeklyExecution.used,
                      selectedTeam.subscription.quotas.weeklyExecution.limit,
                    )}%`,
                  }}
                />
              </span>
              <small>
                {ui.weeklyExecution(
                  Math.round(
                    selectedTeam.subscription.quotas.weeklyExecution.used / 60,
                  ),
                  Math.round(
                    selectedTeam.subscription.quotas.weeklyExecution.limit / 60,
                  ),
                )}
              </small>
            </div>
          ) : null}
          <div className="account-menu-separator" role="separator" />
          {selectedTeam ? (
            <Link
              href={`/team?team=${encodeURIComponent(selectedTeam.id)}`}
              role="menuitem"
              onClick={() => setAccountMenuOpen(false)}
            >
              <UsersRound size={15} aria-hidden="true" />
              {ui.teamSettings}
            </Link>
          ) : null}
          <Link
            href={
              selectedTeam
                ? `/preferences?team=${encodeURIComponent(selectedTeam.id)}`
                : "/preferences"
            }
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
    </>
  );

  return (
    <>
      <AppSidebar
        className="sidebar"
        label={ui.navigation}
        footer={accountFooter}
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
      </AppSidebar>
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
