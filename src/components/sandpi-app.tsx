"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Menu, Plus, Settings2 } from "lucide-react";

import { Conversation } from "@/components/conversation";
import { EnvironmentSettings } from "@/components/environment-settings";
import { Inspector, type InspectorTab } from "@/components/inspector";
import { NewEnvironmentDialog } from "@/components/new-environment-dialog";
import { NewSessionWorkspace } from "@/components/new-session-workspace";
import { PreferencesDrawer } from "@/components/preferences-drawer";
import { Sidebar } from "@/components/sidebar";
import { TerminalDock } from "@/components/terminal-dock";
import type {
  ChatMessage,
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
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    initialData.selectedEnvironmentId,
  );
  const [selectedSessionId, setSelectedSessionId] = useState(initialData.selectedSessionId);
  const [settingsEnvironmentId, setSettingsEnvironmentId] = useState<string | null>(null);
  const [newSessionEnvironmentId, setNewSessionEnvironmentId] = useState<string | null>(null);
  const [newEnvironmentOpen, setNewEnvironmentOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("files");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const narrowViewport = window.matchMedia("(max-width: 960px)");
    const closeInspectorOnNarrowViewport = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) {
        setInspectorOpen(false);
      }
    };

    closeInspectorOnNarrowViewport(narrowViewport);
    narrowViewport.addEventListener("change", closeInspectorOnNarrowViewport);
    return () => {
      narrowViewport.removeEventListener("change", closeInspectorOnNarrowViewport);
    };
  }, []);

  const selectedEnvironment = useMemo(
    () =>
      environments.find((environment) => environment.id === selectedEnvironmentId) ??
      environments[0],
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
      environments.find((environment) => environment.id === settingsEnvironmentId) ??
      null,
    [environments, settingsEnvironmentId],
  );

  const settingsSandbox0Connection = useMemo(
    () =>
      preferences.sandbox0.connections.find(
        (connection) => connection.id === settingsEnvironment?.sandbox0ConnectionId,
      ),
    [preferences.sandbox0.connections, settingsEnvironment?.sandbox0ConnectionId],
  );

  const handleSelectEnvironment = useCallback(
    (environmentId: string) => {
      setNewSessionEnvironmentId(null);
      setSelectedEnvironmentId(environmentId);
      const firstSession = sessions.find(
        (session) => session.environmentId === environmentId,
      );
      if (firstSession) {
        setSelectedSessionId(firstSession.id);
      } else {
        setSelectedSessionId("");
      }
      setSidebarOpen(false);
    },
    [sessions],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setNewSessionEnvironmentId(null);
      const session = sessions.find((item) => item.id === sessionId);
      if (session) {
        setSelectedSessionId(sessionId);
        setSelectedEnvironmentId(session.environmentId);
      }
      setSidebarOpen(false);
    },
    [sessions],
  );

  const handleEnvironmentChange = useCallback((nextEnvironment: Environment) => {
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === nextEnvironment.id ? nextEnvironment : environment,
      ),
    );
  }, []);

  const handleSessionCreated = useCallback((session: CodingSession) => {
    setSessions((current) => [session, ...current]);
    setSelectedEnvironmentId(session.environmentId);
    setSelectedSessionId(session.id);
    setNewSessionEnvironmentId(null);
  }, []);

  const handleEnvironmentCreated = useCallback((environment: Environment) => {
    setEnvironments((current) => [...current, environment]);
    setSelectedEnvironmentId(environment.id);
    setSelectedSessionId("");
    setNewSessionEnvironmentId(null);
    setNewEnvironmentOpen(false);
  }, []);

  const handleSendMessage = useCallback(
    (content: string) => {
      const now = new Date().toISOString();
      const userMessage: ChatMessage = {
        id: `message-${crypto.randomUUID()}`,
        role: "user",
        content,
        createdAt: now,
      };
      const agentMessage: ChatMessage = {
        id: `message-${crypto.randomUUID()}`,
        role: "assistant",
        content:
          `I’ve queued that instruction for the running ${selectedEnvironment?.codingAgent.label ?? "coding agent"} session. This prototype mirrors the durable event flow; the next backend slice will replace this mock response with Supervisor events.`,
        createdAt: now,
        activities: [
          {
            id: `activity-${crypto.randomUUID()}`,
            label: "Instruction accepted",
            detail: "Durable cursor advanced · client may disconnect safely",
            status: "completed",
          },
        ],
      };

      setSessions((current) =>
        current.map((session) =>
          session.id === selectedSessionId
            ? {
                ...session,
                updatedAt: now,
                messages: [...session.messages, userMessage, agentMessage],
              }
            : session,
        ),
      );
    },
    [selectedEnvironment?.codingAgent.label, selectedSessionId],
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
      } ${sidebarOpen ? "sidebar-is-open" : ""}`}
    >
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      <Sidebar
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
          setNewSessionEnvironmentId(environmentId);
          setSidebarOpen(false);
        }}
        onEnvironmentSettings={(environmentId) => {
          handleSelectEnvironment(environmentId);
          setSettingsEnvironmentId(environmentId);
        }}
        onPreferences={() => {
          setPreferencesOpen(true);
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
          environment={selectedEnvironment}
          session={selectedSession}
          inspectorOpen={showInspector}
          terminalOpen={showTerminal}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onToggleTerminal={() => setTerminalOpen((open) => !open)}
          onOpenSettings={() => setSettingsEnvironmentId(selectedEnvironment.id)}
          onOpenInspector={(tab) => {
            setInspectorTab(tab);
            setInspectorOpen(true);
          }}
          onSendMessage={handleSendMessage}
        />
      ) : newSessionEnvironmentId === selectedEnvironment.id ? (
        <NewSessionWorkspace
          environment={selectedEnvironment}
          onCreated={handleSessionCreated}
          onOpenSettings={() => setSettingsEnvironmentId(selectedEnvironment.id)}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
        />
      ) : (
        <EnvironmentEmptyState
          environment={selectedEnvironment}
          onNewSession={() => setNewSessionEnvironmentId(selectedEnvironment.id)}
          onOpenSettings={() => setSettingsEnvironmentId(selectedEnvironment.id)}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
        />
      )}

      {showInspector && selectedSession ? (
        <Inspector
          session={selectedSession}
          activeTab={inspectorTab}
          onTabChange={setInspectorTab}
          onClose={() => setInspectorOpen(false)}
        />
      ) : null}

      {showTerminal && selectedSession ? (
        <TerminalDock session={selectedSession} onClose={() => setTerminalOpen(false)} />
      ) : null}

      {settingsEnvironment ? (
        <EnvironmentSettings
          environment={settingsEnvironment}
          sandbox0Connection={settingsSandbox0Connection}
          onChange={handleEnvironmentChange}
          onClose={() => setSettingsEnvironmentId(null)}
        />
      ) : null}

      {newEnvironmentOpen ? (
        <NewEnvironmentDialog
          environments={environments}
          sandbox0Connections={preferences.sandbox0.connections}
          defaultSandbox0ConnectionId={preferences.sandbox0.defaultConnectionId}
          onCreated={handleEnvironmentCreated}
          onClose={() => setNewEnvironmentOpen(false)}
        />
      ) : null}

      {preferencesOpen ? (
        <PreferencesDrawer
          preferences={preferences}
          onChange={setPreferences}
          onClose={() => setPreferencesOpen(false)}
        />
      ) : null}
    </main>
  );
}

function EnvironmentEmptyState({
  environment,
  onNewSession,
  onOpenSettings,
  onToggleSidebar,
}: {
  environment: Environment;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}) {
  return (
    <section id="conversation" className="environment-empty-workspace" tabIndex={-1}>
      <header>
        <button
          type="button"
          className="icon-button mobile-menu-button"
          aria-label="Open navigation"
          onClick={onToggleSidebar}
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        <div>
          <span>Environment</span>
          <strong>{environment.name}</strong>
        </div>
        <button type="button" className="icon-button" aria-label="Environment settings" onClick={onOpenSettings}>
          <Settings2 size={17} aria-hidden="true" />
        </button>
      </header>
      <div>
        <span
          className="environment-empty-avatar"
          style={{ backgroundColor: environment.color }}
          aria-hidden="true"
        >
          {environment.name.slice(0, 1)}
        </span>
        <h1>{environment.name} is ready</h1>
        <p>
          {environment.codingAgent.label} is bound to this Environment. Start a Session to fork
          revision {environment.revision} into an isolated Sandbox and private /workspace Volume.
        </p>
        <button type="button" className="button-primary" onClick={onNewSession}>
          <Plus size={15} aria-hidden="true" /> New session
        </button>
      </div>
    </section>
  );
}
