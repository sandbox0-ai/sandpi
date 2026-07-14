"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

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
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
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

function replaceWorkspaceUrl(
  teamId: string,
  environmentId: string,
  sessionId?: string,
) {
  const url = new URL(window.location.href);
  url.searchParams.set("team", teamId);
  url.searchParams.set("environment", environmentId);
  if (sessionId) {
    url.searchParams.set("session", sessionId);
    url.searchParams.delete("new");
  } else {
    url.searchParams.delete("session");
    url.searchParams.set("new", "1");
  }
  window.history.replaceState(window.history.state, "", url);
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
  const [terminalHeight, setTerminalHeight] = useState(320);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [terminalRestoreHeight, setTerminalRestoreHeight] = useState(320);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("files");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const hydrateSession = useCallback(async (sessionId: string) => {
    try {
      const response = await apiFetch<ApiEnvelope<CodingSession>>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      );
      setSessions((current) =>
        current.map((session) =>
          session.id === response.data.id ? response.data : session,
        ),
      );
    } catch (error) {
      console.error("Unable to load Session history", error);
    }
  }, []);

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

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    const warnBeforeClosingSession = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers intentionally replace custom text with their native warning.
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", warnBeforeClosingSession);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeClosingSession);
    };
  }, [selectedSession]);

  useEffect(() => {
    if (!environments.some((environment) => environment.status === "updating")) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiFetch<ApiEnvelope<Environment[]>>("/api/v1/environments", {
        signal: controller.signal,
      })
        .then((response) => setEnvironments(response.data))
        .catch((error) => {
          if (!controller.signal.aborted) {
            console.error("Unable to refresh Environment provisioning", error);
          }
        });
    }, 1_500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [environments]);

  useEffect(() => {
    if (!selectedSession?.unread) return;
    setSessions((current) =>
      current.map((session) =>
        session.id === selectedSession.id ? { ...session, unread: false } : session,
      ),
    );
    void apiFetch(`/api/v1/sessions/${encodeURIComponent(selectedSession.id)}/metadata`, {
      method: "PUT",
      body: JSON.stringify({ unread: false }),
    }).catch((error) => console.error("Unable to mark Session as read", error));
  }, [selectedSession?.id, selectedSession?.unread]);

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
      if (nextSession) void hydrateSession(nextSession.id);
      setSettingsEnvironmentId(null);
      setInspectorOpen(false);
      setTerminalOpen(false);
      setSidebarOpen(false);
      if (nextEnvironment) {
        replaceWorkspaceUrl(nextTeam.id, nextEnvironment.id, nextSession?.id);
      }
    },
    [environments, hydrateSession, initialData.teams, selectedTeamId, sessions],
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
        replaceWorkspaceUrl(selectedTeamId, environmentId, firstSession.id);
        void hydrateSession(firstSession.id);
        setSessions((current) =>
          current.map((session) =>
            session.id === firstSession.id && session.unread
              ? { ...session, unread: false }
              : session,
          ),
        );
      } else {
        setSelectedSessionId("");
        replaceWorkspaceUrl(selectedTeamId, environmentId);
      }
      setSidebarOpen(false);
    },
    [hydrateSession, selectedTeamId, sessions, teamEnvironments],
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
        replaceWorkspaceUrl(selectedTeamId, session.environmentId, sessionId);
        void hydrateSession(sessionId);
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
    [environments, hydrateSession, selectedTeamId, sessions],
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

  const handleSessionCreated = useCallback(
    (session: CodingSession) => {
      setSessions((current) => [
        session,
        ...current.filter((candidate) => candidate.id !== session.id),
      ]);
      setSelectedEnvironmentId(session.environmentId);
      setSelectedSessionId(session.id);
      replaceWorkspaceUrl(selectedTeamId, session.environmentId, session.id);
      setInspectorOpen(false);
      setTerminalOpen(false);
    },
    [selectedTeamId],
  );

  const persistSessionMetadata = useCallback(
    async (
      sessionId: string,
      metadata: {
        title?: string;
        pinned?: boolean;
        archived?: boolean;
        unread?: boolean;
      },
    ) => {
      const response = await apiFetch<ApiEnvelope<CodingSession>>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/metadata`,
        {
          method: "PUT",
          body: JSON.stringify(metadata),
        },
      );
      setSessions((current) =>
        current.map((session) =>
          session.id === response.data.id ? response.data : session,
        ),
      );
      return response.data;
    },
    [],
  );

  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      void persistSessionMetadata(sessionId, { title }).catch((error) => {
        console.error("Unable to rename Session", error);
      });
    },
    [persistSessionMetadata],
  );

  const handleTogglePinSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        return;
      }
      void persistSessionMetadata(sessionId, {
        pinned: !session.pinned,
      }).catch((error) => {
        console.error("Unable to update pinned Session", error);
      });
    },
    [persistSessionMetadata, sessions],
  );

  const handleForkSession = useCallback((sessionId: string) => {
    void apiFetch<ApiEnvelope<CodingSession>>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/fork`,
      { method: "POST", body: JSON.stringify({}) },
    )
      .then((response) => {
        handleSessionCreated(response.data);
      })
      .catch((error) => console.error("Unable to fork Session", error));
  }, [handleSessionCreated]);

  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      const archivedSession = sessions.find(
        (session) => session.id === sessionId,
      );
      if (!archivedSession) {
        return;
      }

      void persistSessionMetadata(sessionId, { archived: true })
        .then(() => {
          if (selectedSessionId === sessionId) {
            const nextSession = visibleSessionsForEnvironment(
              sessions,
              archivedSession.environmentId,
              sessionId,
            )[0];
            setSelectedSessionId(nextSession?.id ?? "");
            replaceWorkspaceUrl(
              selectedTeamId,
              archivedSession.environmentId,
              nextSession?.id,
            );
          }
        })
        .catch((error) => {
          console.error("Unable to archive Session", error);
        });
    },
    [persistSessionMetadata, selectedSessionId, selectedTeamId, sessions],
  );

  const handleRestoreSession = useCallback(
    (sessionId: string) => {
      void persistSessionMetadata(sessionId, { archived: false }).catch(
        (error) => {
          console.error("Unable to restore Session", error);
        },
      );
    },
    [persistSessionMetadata],
  );

  const handleEnvironmentCreated = useCallback((environment: Environment) => {
    if (environment.teamId !== selectedTeamId) {
      return;
    }
    setEnvironments((current) => [...current, environment]);
    setSelectedEnvironmentId(environment.id);
    setSelectedSessionId("");
    replaceWorkspaceUrl(selectedTeamId, environment.id);
    setNewEnvironmentOpen(false);
  }, [selectedTeamId]);

  const handleSessionChange = useCallback((nextSession: CodingSession) => {
    setSessions((current) =>
      current.map((session) =>
        session.id === nextSession.id ? nextSession : session,
      ),
    );
  }, []);

  const handleTerminalHeightChange = useCallback((height: number) => {
    setTerminalHeight(height);
    setTerminalMaximized(false);
  }, []);

  const handleToggleTerminalMaximize = useCallback(() => {
    if (terminalMaximized) {
      setTerminalHeight(terminalRestoreHeight);
      setTerminalMaximized(false);
      return;
    }
    setTerminalRestoreHeight(terminalHeight);
    setTerminalHeight(Math.max(360, Math.floor(window.innerHeight * 0.72)));
    setTerminalMaximized(true);
  }, [terminalHeight, terminalMaximized, terminalRestoreHeight]);

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
      style={
        showTerminal
          ? ({ "--terminal-height": `${terminalHeight}px` } as CSSProperties)
          : undefined
      }
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
          replaceWorkspaceUrl(selectedTeam.id, environmentId);
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
          onDerivedSessionCreated={handleSessionCreated}
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
          onEnvironmentChange={handleEnvironmentChange}
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
          height={terminalHeight}
          maximized={terminalMaximized}
          onHeightChange={handleTerminalHeightChange}
          onToggleMaximize={handleToggleTerminalMaximize}
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
