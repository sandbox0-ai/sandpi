"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Conversation } from "@/components/conversation";
import { AppFrame } from "@/components/app-frame";
import { EnvironmentSettings } from "@/components/environment-settings";
import { Inspector, type InspectorTab } from "@/components/inspector";
import { NewEnvironmentDialog } from "@/components/new-environment-dialog";
import { NewSessionWorkspace } from "@/components/new-session-workspace";
import { Sidebar } from "@/components/sidebar";
import { TerminalDock } from "@/components/terminal-dock";
import {
  applyClientPreferences,
  CLIENT_PREFERENCES_CHANGED_EVENT,
  CLIENT_PREFERENCES_STORAGE_KEY,
  loadClientPreferences,
} from "@/lib/client-preferences";
import { forkSessionForHarness } from "@/harnesses/registry";
import { visibleSessionsForEnvironment } from "@/lib/session-list";
import { environmentsForTeam, sessionsForTeam } from "@/lib/team";
import type {
  CodingSession,
  Environment,
  SandpiBootstrap,
} from "@/lib/types";

interface SandpiAppProps {
  initialData: SandpiBootstrap;
}

export function SandpiApp({ initialData }: SandpiAppProps) {
  const [environments, setEnvironments] = useState(initialData.environments);
  const [sessions, setSessions] = useState(initialData.sessions);
  const [preferences, setPreferences] = useState(initialData.preferences);
  const [selectedTeamId, setSelectedTeamId] = useState(
    initialData.selectedTeamId,
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    initialData.selectedEnvironmentId,
  );
  const [selectedSessionId, setSelectedSessionId] = useState(
    initialData.selectedSessionId,
  );
  const [settingsEnvironmentId, setSettingsEnvironmentId] = useState<
    string | null
  >(null);
  const [newEnvironmentOpen, setNewEnvironmentOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("files");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const synchronizePreferences = () => {
      const next = loadClientPreferences(initialData.preferences);
      setPreferences(next);
      applyClientPreferences(next);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === CLIENT_PREFERENCES_STORAGE_KEY) {
        synchronizePreferences();
      }
    };

    synchronizePreferences();
    window.addEventListener(
      CLIENT_PREFERENCES_CHANGED_EVENT,
      synchronizePreferences,
    );
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        CLIENT_PREFERENCES_CHANGED_EVENT,
        synchronizePreferences,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [initialData.preferences]);

  useEffect(() => {
    const narrowViewport = window.matchMedia("(max-width: 960px)");
    const closeInspectorOnNarrowViewport = (
      event: MediaQueryListEvent | MediaQueryList,
    ) => {
      if (event.matches) {
        setInspectorOpen(false);
      }
    };

    closeInspectorOnNarrowViewport(narrowViewport);
    narrowViewport.addEventListener("change", closeInspectorOnNarrowViewport);
    return () => {
      narrowViewport.removeEventListener(
        "change",
        closeInspectorOnNarrowViewport,
      );
    };
  }, []);

  const selectedTeam = useMemo(
    () =>
      initialData.teams.find((team) => team.id === selectedTeamId) ??
      initialData.teams[0],
    [initialData.teams, selectedTeamId],
  );

  const teamEnvironments = useMemo(
    () => environmentsForTeam(environments, selectedTeamId),
    [environments, selectedTeamId],
  );

  const teamSessions = useMemo(
    () => sessionsForTeam(sessions, environments, selectedTeamId),
    [environments, selectedTeamId, sessions],
  );

  const selectedEnvironment = useMemo(
    () =>
      teamEnvironments.find(
        (environment) => environment.id === selectedEnvironmentId,
      ) ?? teamEnvironments[0],
    [selectedEnvironmentId, teamEnvironments],
  );

  const selectedSession = useMemo(
    () =>
      teamSessions.find(
        (session) =>
          session.id === selectedSessionId &&
          session.environmentId === selectedEnvironmentId,
      ),
    [selectedEnvironmentId, selectedSessionId, teamSessions],
  );

  const settingsEnvironment = useMemo(
    () =>
      teamEnvironments.find(
        (environment) => environment.id === settingsEnvironmentId,
      ) ?? null,
    [settingsEnvironmentId, teamEnvironments],
  );

  const handleSelectTeam = useCallback(
    (teamId: string) => {
      const nextTeam = initialData.teams.find((team) => team.id === teamId);
      if (!nextTeam || nextTeam.id === selectedTeamId) {
        return;
      }
      const nextEnvironments = environmentsForTeam(environments, nextTeam.id);
      const nextEnvironment = nextEnvironments[0];
      const nextSession = nextEnvironment
        ? visibleSessionsForEnvironment(sessions, nextEnvironment.id)[0]
        : undefined;

      setSelectedTeamId(nextTeam.id);
      setSelectedEnvironmentId(nextEnvironment?.id ?? "");
      setSelectedSessionId(nextSession?.id ?? "");
      setSettingsEnvironmentId(null);
      setInspectorOpen(false);
      setTerminalOpen(false);
      setSidebarOpen(false);
      const url = new URL(window.location.href);
      url.searchParams.set("team", nextTeam.id);
      window.history.replaceState(window.history.state, "", url);
    },
    [environments, initialData.teams, selectedTeamId, sessions],
  );

  const handleSelectEnvironment = useCallback(
    (environmentId: string) => {
      const environment = teamEnvironments.find(
        (item) => item.id === environmentId,
      );
      if (!environment) {
        return;
      }
      setSelectedEnvironmentId(environmentId);
      const firstSession = visibleSessionsForEnvironment(
        sessions,
        environmentId,
      )[0];
      if (firstSession) {
        setSelectedSessionId(firstSession.id);
        setSessions((current) =>
          current.map((session) =>
            session.id === firstSession.id && session.unread
              ? { ...session, unread: false }
              : session,
          ),
        );
      } else {
        setSelectedSessionId("");
      }
      setSidebarOpen(false);
    },
    [sessions, teamEnvironments],
  );

  const handleToggleNavigation = useCallback(() => {
    if (window.matchMedia("(max-width: 960px)").matches) {
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed(false);
  }, []);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find(
        (item) => item.id === sessionId && !item.archived,
      );
      const environment = session
        ? environments.find((item) => item.id === session.environmentId)
        : undefined;
      if (session && environment?.teamId === selectedTeamId) {
        setSelectedSessionId(sessionId);
        setSelectedEnvironmentId(session.environmentId);
        setSessions((current) =>
          current.map((item) =>
            item.id === sessionId && item.unread
              ? { ...item, unread: false }
              : item,
          ),
        );
      }
      setSidebarOpen(false);
    },
    [environments, selectedTeamId, sessions],
  );

  const handleEnvironmentChange = useCallback(
    (nextEnvironment: Environment) => {
      setEnvironments((current) =>
        current.map((environment) =>
          environment.id === nextEnvironment.id ? nextEnvironment : environment,
        ),
      );
    },
    [],
  );

  const handleSessionCreated = useCallback((session: CodingSession) => {
    setSessions((current) => [session, ...current]);
    setSelectedEnvironmentId(session.environmentId);
    setSelectedSessionId(session.id);
  }, []);

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId
            ? { ...session, title, updatedAt: new Date().toISOString() }
            : session,
        ),
      );
    },
    [],
  );

  const handleTogglePinSession = useCallback((sessionId: string) => {
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId
          ? { ...session, pinned: !session.pinned }
          : session,
      ),
    );
  }, []);

  const handleForkSession = useCallback(
    (sessionId: string) => {
      const source = sessions.find(
        (session) => session.id === sessionId && !session.archived,
      );
      if (!source) {
        return;
      }

      const createdAt = new Date().toISOString();
      // Future Session fork: atomically branch the source Sandbox rootfs and its current
      // Workspace Volume. Unlike a Turn fork, this preserves Session-scoped rootfs changes.
      // Rootfs/Volume lifecycle is shared, but the matching native thread/session fork is
      // dispatched to the bound harness instead of cloning a normalized conversation state.
      const forkedSession = forkSessionForHarness(source, createdAt);

      setSessions((current) => [forkedSession, ...current]);
      setSelectedEnvironmentId(forkedSession.environmentId);
      setSelectedSessionId(forkedSession.id);
    },
    [sessions],
  );

  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      const archivedSession = sessions.find(
        (session) => session.id === sessionId,
      );
      if (!archivedSession) {
        return;
      }

      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, archived: true } : session,
        ),
      );

      if (selectedSessionId === sessionId) {
        const nextSession = visibleSessionsForEnvironment(
          sessions,
          archivedSession.environmentId,
          sessionId,
        )[0];
        setSelectedSessionId(nextSession?.id ?? "");
      }
    },
    [selectedSessionId, sessions],
  );

  const handleRestoreSession = useCallback((sessionId: string) => {
    const restoredAt = new Date().toISOString();
    setSessions((current) =>
      current.map((session) =>
        session.id === sessionId && session.archived
          ? { ...session, archived: false, updatedAt: restoredAt }
          : session,
      ),
    );
  }, []);

  const handleEnvironmentCreated = useCallback((environment: Environment) => {
    if (environment.teamId !== selectedTeamId) {
      return;
    }
    setEnvironments((current) => [...current, environment]);
    setSelectedEnvironmentId(environment.id);
    setSelectedSessionId("");
    setNewEnvironmentOpen(false);
  }, [selectedTeamId]);

  const handleSessionChange = useCallback((nextSession: CodingSession) => {
    setSessions((current) =>
      current.map((session) =>
        session.id === nextSession.id ? nextSession : session,
      ),
    );
  }, []);

  if (!selectedTeam || !selectedEnvironment) {
    return <div className="empty-app">No Team Environment is available.</div>;
  }

  const showInspector = inspectorOpen && Boolean(selectedSession);
  const showTerminal = terminalOpen && Boolean(selectedSession);

  return (
    <AppFrame
      as="main"
      className={`app-shell ${showInspector ? "inspector-is-open" : ""} ${
        showTerminal ? "terminal-is-open" : ""
      } ${sidebarOpen ? "sidebar-is-open" : ""} ${
        sidebarCollapsed ? "sidebar-is-collapsed" : ""
      }`}
    >
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      <Sidebar
        language={preferences.general.language}
        viewer={initialData.viewer}
        teams={initialData.teams}
        viewerMemberships={initialData.viewerMemberships}
        plans={initialData.plans}
        selectedTeamId={selectedTeam.id}
        environments={teamEnvironments}
        sessions={teamSessions}
        selectedEnvironmentId={selectedEnvironment.id}
        selectedSessionId={selectedSession?.id ?? ""}
        onSelectEnvironment={handleSelectEnvironment}
        onSelectSession={handleSelectSession}
        onSelectTeam={handleSelectTeam}
        onNewEnvironment={() => setNewEnvironmentOpen(true)}
        onNewSession={(environmentId) => {
          setSelectedEnvironmentId(environmentId);
          setSelectedSessionId("");
          setSidebarOpen(false);
        }}
        onEnvironmentSettings={(environmentId) => {
          handleSelectEnvironment(environmentId);
          setSettingsEnvironmentId(environmentId);
        }}
        onRenameSession={handleRenameSession}
        onForkSession={handleForkSession}
        onArchiveSession={handleArchiveSession}
        onTogglePinSession={handleTogglePinSession}
        onCollapse={() => {
          setSidebarCollapsed(true);
          setSidebarOpen(false);
        }}
        onCloseMobile={() => setSidebarOpen(false)}
      />

      {sidebarOpen ? (
        <button
          type="button"
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      {selectedSession ? (
        <Conversation
          language={preferences.general.language}
          sendShortcut={preferences.general.sendShortcut}
          environment={selectedEnvironment}
          session={selectedSession}
          inspectorOpen={showInspector}
          terminalOpen={showTerminal}
          onToggleSidebar={handleToggleNavigation}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onToggleTerminal={() => setTerminalOpen((open) => !open)}
          onOpenSettings={() =>
            setSettingsEnvironmentId(selectedEnvironment.id)
          }
          onOpenInspector={(tab) => {
            setInspectorTab(tab);
            setInspectorOpen(true);
          }}
          onSessionChange={handleSessionChange}
          onCreateSession={handleSessionCreated}
          onForkSession={handleForkSession}
          onRenameSession={handleRenameSession}
          onArchiveSession={handleArchiveSession}
          onTogglePinSession={handleTogglePinSession}
        />
      ) : (
        <NewSessionWorkspace
          language={preferences.general.language}
          sendShortcut={preferences.general.sendShortcut}
          environment={selectedEnvironment}
          onCreated={handleSessionCreated}
          onOpenSettings={() =>
            setSettingsEnvironmentId(selectedEnvironment.id)
          }
          onToggleSidebar={handleToggleNavigation}
        />
      )}

      {showInspector && selectedSession ? (
        <Inspector
          language={preferences.general.language}
          timeZone={preferences.general.timeZone}
          session={selectedSession}
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          onClose={() => setInspectorOpen(false)}
        />
      ) : null}

      {showTerminal && selectedSession ? (
        <TerminalDock
          session={selectedSession}
          onClose={() => setTerminalOpen(false)}
        />
      ) : null}

      {settingsEnvironment ? (
        <EnvironmentSettings
          environment={settingsEnvironment}
          teamName={selectedTeam.name}
          archivedSessions={teamSessions
            .filter(
              (session) =>
                session.environmentId === settingsEnvironment.id &&
                session.archived,
            )
            .sort(
              (left, right) =>
                Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
            )}
          onChange={handleEnvironmentChange}
          onRestoreSession={handleRestoreSession}
          onClose={() => setSettingsEnvironmentId(null)}
        />
      ) : null}

      {newEnvironmentOpen ? (
        <NewEnvironmentDialog
          teamId={selectedTeam.id}
          teamName={selectedTeam.name}
          environments={teamEnvironments}
          onCreated={handleEnvironmentCreated}
          onClose={() => setNewEnvironmentOpen(false)}
        />
      ) : null}
    </AppFrame>
  );
}
