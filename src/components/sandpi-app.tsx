"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Conversation } from "@/components/conversation";
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
import { createId, randomToken } from "@/lib/id";
import {
  replaceTimelineFromUserMessage,
  truncateTimelineFromUserMessage,
} from "@/lib/message-timeline";
import { visibleSessionsForEnvironment } from "@/lib/session-list";
import type {
  ChatMessage,
  CodingSession,
  Environment,
  SandpiBootstrap,
} from "@/lib/types";

interface SandpiAppProps {
  initialData: SandpiBootstrap;
}

/**
 * Production turns remain `finalizing` until their Workspace Volume snapshot is durable.
 * This helper only creates the optimistic message pair used by the frontend prototype.
 */
function createMockTurn(
  content: string,
  codingAgentLabel: string,
  createdAt: string,
): ChatMessage[] {
  return [
    {
      id: createId("message"),
      role: "user",
      content,
      createdAt,
    },
    {
      id: createId("message"),
      role: "assistant",
      content: `I’ve queued that instruction for the running ${codingAgentLabel} session. This prototype mirrors the durable event flow; the next backend slice will replace this mock response with Supervisor events.`,
      createdAt,
      activities: [
        {
          id: createId("activity"),
          label: "Instruction accepted",
          detail: "Durable cursor advanced · client may disconnect safely",
          status: "completed",
        },
      ],
    },
  ];
}

function createMockForkedSession(
  source: CodingSession,
  messages: ChatMessage[],
  auditAction: "session.forked" | "turn.forked",
  auditDetail: string,
  createdAt: string,
  sourceMessageId?: string,
): CodingSession {
  const idSuffix = randomToken(10);
  const createdAtDate = new Date(createdAt);

  return {
    ...source,
    id: `session-${idSuffix}`,
    title: `Fork of ${source.title}`,
    pinned: false,
    archived: false,
    unread: false,
    createdAt,
    updatedAt: createdAt,
    hardExpiresAt: new Date(
      createdAtDate.getTime() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    sandboxId: `sbx_${idSuffix}`,
    supervisorSessionId: `ses_${idSuffix}`,
    workspaceVolumeId: `vol_${idSuffix}`,
    origin: {
      kind: auditAction === "session.forked" ? "session" : "turn",
      label: source.title,
      sourceSessionId: source.id,
      sourceMessageId,
    },
    messages,
    files: structuredClone(source.files),
    auditEvents: [
      {
        id: `audit-${idSuffix}`,
        source: "supervisor",
        category: "lifecycle",
        action: auditAction,
        detail: auditDetail,
        outcome: "success",
        timestamp: createdAt,
      },
      ...source.auditEvents,
    ],
    metrics: structuredClone(source.metrics),
  };
}

export function SandpiApp({ initialData }: SandpiAppProps) {
  const [environments, setEnvironments] = useState(initialData.environments);
  const [sessions, setSessions] = useState(initialData.sessions);
  const [preferences, setPreferences] = useState(initialData.preferences);
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

  const selectedEnvironment = useMemo(
    () =>
      environments.find(
        (environment) => environment.id === selectedEnvironmentId,
      ) ?? environments[0],
    [environments, selectedEnvironmentId],
  );

  const selectedSession = useMemo(
    () =>
      sessions.find(
        (session) =>
          session.id === selectedSessionId &&
          session.environmentId === selectedEnvironmentId,
      ),
    [selectedEnvironmentId, sessions, selectedSessionId],
  );

  const settingsEnvironment = useMemo(
    () =>
      environments.find(
        (environment) => environment.id === settingsEnvironmentId,
      ) ?? null,
    [environments, settingsEnvironmentId],
  );

  const handleSelectEnvironment = useCallback(
    (environmentId: string) => {
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
    [sessions],
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
      if (session) {
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
    [sessions],
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
      const forkedSession = createMockForkedSession(
        source,
        structuredClone(source.messages),
        "session.forked",
        `Prototype Session fork from ${source.id}: rootfs + Workspace Volume`,
        createdAt,
      );

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
    setEnvironments((current) => [...current, environment]);
    setSelectedEnvironmentId(environment.id);
    setSelectedSessionId("");
    setNewEnvironmentOpen(false);
  }, []);

  const handleSendMessage = useCallback(
    (content: string) => {
      const now = new Date().toISOString();
      const turn = createMockTurn(
        content,
        selectedEnvironment?.codingAgent.label ?? "coding agent",
        now,
      );

      setSessions((current) =>
        current.map((session) =>
          session.id === selectedSessionId
            ? {
                ...session,
                updatedAt: now,
                messages: [...session.messages, ...turn],
              }
            : session,
        ),
      );
    },
    [selectedEnvironment?.codingAgent.label, selectedSessionId],
  );

  const handleDeleteUserMessage = useCallback(
    (messageId: string) => {
      const now = new Date().toISOString();
      // Timeline-only mock. Production restores the Workspace Volume snapshot immediately
      // before this Turn; the Session rootfs deliberately remains unchanged.
      setSessions((current) =>
        current.map((session) => {
          if (session.id !== selectedSessionId) {
            return session;
          }
          const messages = truncateTimelineFromUserMessage(
            session.messages,
            messageId,
          );
          return messages ? { ...session, messages, updatedAt: now } : session;
        }),
      );
    },
    [selectedSessionId],
  );

  const handleEditUserMessage = useCallback(
    (messageId: string, content: string) => {
      const now = new Date().toISOString();
      const replacement = createMockTurn(
        content,
        selectedEnvironment?.codingAgent.label ?? "coding agent",
        now,
      );
      // Editing shares the Turn rollback boundary with delete, then submits a replacement
      // instruction and persists a new Workspace Volume snapshot before completing the Turn.
      setSessions((current) =>
        current.map((session) => {
          if (session.id !== selectedSessionId) {
            return session;
          }
          const messages = replaceTimelineFromUserMessage(
            session.messages,
            messageId,
            replacement,
          );
          return messages ? { ...session, messages, updatedAt: now } : session;
        }),
      );
    },
    [selectedEnvironment?.codingAgent.label, selectedSessionId],
  );

  const handleForkUserMessage = useCallback(
    (messageId: string) => {
      if (!selectedSession || !selectedEnvironment) {
        return;
      }
      const sourceMessage = selectedSession.messages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!sourceMessage) {
        return;
      }

      const createdAt = new Date().toISOString();
      const messages = replaceTimelineFromUserMessage(
        selectedSession.messages,
        messageId,
        createMockTurn(
          sourceMessage.content,
          selectedEnvironment.codingAgent.label,
          createdAt,
        ),
      );
      if (!messages) {
        return;
      }

      // This user-message action forks the checkpoint immediately before the selected Turn,
      // then replays its instruction. Production claims the new Sandbox from the pinned
      // Environment revision and never copies the source Session rootfs.
      const forkedSession = createMockForkedSession(
        selectedSession,
        messages,
        "turn.forked",
        `Prototype Turn fork before message ${messageId}: Workspace Volume only`,
        createdAt,
        messageId,
      );

      setSessions((current) => [forkedSession, ...current]);
      setSelectedEnvironmentId(forkedSession.environmentId);
      setSelectedSessionId(forkedSession.id);
    },
    [selectedEnvironment, selectedSession],
  );

  if (!selectedEnvironment) {
    return <div className="empty-app">No Environment is available.</div>;
  }

  const showInspector = inspectorOpen && Boolean(selectedSession);
  const showTerminal = terminalOpen && Boolean(selectedSession);

  return (
    <main
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
        environments={environments}
        sessions={sessions}
        selectedEnvironmentId={selectedEnvironment.id}
        selectedSessionId={selectedSession?.id ?? ""}
        onSelectEnvironment={handleSelectEnvironment}
        onSelectSession={handleSelectSession}
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
          onSendMessage={handleSendMessage}
          onDeleteUserMessage={handleDeleteUserMessage}
          onEditUserMessage={handleEditUserMessage}
          onForkUserMessage={handleForkUserMessage}
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
          archivedSessions={sessions
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
          environments={environments}
          onCreated={handleEnvironmentCreated}
          onClose={() => setNewEnvironmentOpen(false)}
        />
      ) : null}
    </main>
  );
}
