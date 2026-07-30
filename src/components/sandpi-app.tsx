"use client";

import { Box, PanelLeftOpen, Plus } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Conversation } from "@/components/conversation";
import { AppFrame } from "@/components/app-frame";
import {
  EnvironmentSettings,
  type EnvironmentSettingsOpenOptions,
  type EnvironmentSettingsTab,
} from "@/components/environment-settings";
import type { EnvironmentBrowserNavigationRequest } from "@/components/environment-browser";
import {
  Inspector,
  INSPECTOR_KEEP_ALIVE_MS,
  type InspectorTab,
} from "@/components/inspector";
import { NativePullToRefresh } from "@/components/native-pull-to-refresh";
import { NewEnvironmentDialog } from "@/components/new-environment-dialog";
import { NewSessionWorkspace } from "@/components/new-session-workspace";
import { Sidebar } from "@/components/sidebar";
import { TerminalDock } from "@/components/terminal-dock";
import type { WorkspaceFileNavigationRequest } from "@/components/workspace-ide";
import {
  applyClientPreferences,
  CLIENT_PREFERENCES_CHANGED_EVENT,
  CLIENT_PREFERENCES_STORAGE_KEY,
  loadClientPreferences,
  saveClientPreferences,
} from "@/lib/client-preferences";
import {
  mergeCloudEnvironments,
  mergeCloudSessions,
  reconcileCloudWorkspaceState,
} from "@/lib/cloud-state-sync";
import {
  loadLocalUiPreferences,
  updateLocalUiPreferences,
} from "@/lib/local-ui-preferences";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { visibleSessionsForEnvironment } from "@/lib/session-list";
import { useLocalUiPreferences } from "@/lib/use-local-ui-preferences";
import { useCloudStateSync } from "@/lib/use-cloud-state-sync";
import { useNativeChromeSurfaces } from "@/lib/use-native-chrome-surfaces";
import { userVisibleWorkspacePath } from "@/lib/workspace-path-policy";
import { normalizeInspectorWidthRatio } from "@/lib/workspace-layout";
import type {
  CodingSession,
  Environment,
  SandpiBootstrap,
  SandpiCloudSnapshot,
} from "@/lib/types";

interface SandpiAppProps {
  initialData: SandpiBootstrap;
}

const SESSION_HYDRATION_FRESHNESS_MS = 30_000;

function replaceWorkspaceUrl(
  environmentId: string,
  sessionId?: string,
) {
  const url = new URL(window.location.href);
  const previousEnvironmentId = url.searchParams.get("environment");
  const previousPath = url.searchParams.get("path");
  url.search = "";
  url.searchParams.set("environment", environmentId);
  if (previousEnvironmentId === environmentId && previousPath) {
    url.searchParams.set("path", previousPath);
  }
  if (sessionId) {
    url.searchParams.set("session", sessionId);
    url.searchParams.delete("new");
  } else {
    url.searchParams.delete("session");
    url.searchParams.set("new", "1");
  }
  window.history.replaceState(window.history.state, "", url);
}

function replaceEmptyWorkspaceUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  window.history.replaceState(window.history.state, "", url);
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
  const [settingsTarget, setSettingsTarget] = useState<{
    environmentId: string;
    initialTab: EnvironmentSettingsTab;
    mcpVerbose?: boolean;
  } | null>(null);
  const [newSessionPreset, setNewSessionPreset] = useState<{
    title?: string;
    source?: "startup" | "clear";
  } | null>(null);
  const [newEnvironmentOpen, setNewEnvironmentOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(320);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [terminalRestoreHeight, setTerminalRestoreHeight] = useState(320);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorCoversViewport, setInspectorCoversViewport] = useState(false);
  const fullWidthInspectorOpen = inspectorOpen && inspectorCoversViewport;
  useNativeChromeSurfaces(
    sidebarOpen ? "sidebar" : fullWidthInspectorOpen ? "panel" : "canvas",
    sidebarOpen
      ? "sidebar"
      : fullWidthInspectorOpen
        ? "panel"
        : terminalOpen
          ? "terminal"
          : "canvas",
  );
  const [workspaceNavigationRequest, setWorkspaceNavigationRequest] =
    useState<WorkspaceFileNavigationRequest>();
  const [browserNavigationRequest, setBrowserNavigationRequest] =
    useState<EnvironmentBrowserNavigationRequest>();
  const localUiPreferences = useLocalUiPreferences();
  const inspectorTab = localUiPreferences.workspace.inspectorTab;
  const sidebarCollapsed = localUiPreferences.workspace.sidebarCollapsed;
  const storedInspectorOpen = localUiPreferences.workspace.inspectorOpen;
  const storedInspectorWidthRatio =
    localUiPreferences.workspace.inspectorWidthRatio;
  const storedTerminalHeight = localUiPreferences.workspace.terminalHeight;
  const [inspectorWidthRatio, setInspectorWidthRatio] = useState(
    storedInspectorWidthRatio,
  );
  const workspaceNavigationRequestIdRef = useRef(0);
  const browserNavigationRequestIdRef = useRef(0);
  const restoredWorkspaceNavigationRef = useRef(false);
  const sessionHydratedAtRef = useRef(
    new Map(
      initialData.sessions.map((session) => [session.id, Date.now()] as const),
    ),
  );
  const sessionHydrationsRef = useRef(new Map<string, Promise<void>>());
  const environmentsRef = useRef(environments);
  const sessionsRef = useRef(sessions);
  const selectedEnvironmentIdRef = useRef(selectedEnvironmentId);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const cloudStateVersionRef = useRef(0);
  const [cloudRefreshEpoch, setCloudRefreshEpoch] = useState(0);
  environmentsRef.current = environments;
  sessionsRef.current = sessions;
  selectedEnvironmentIdRef.current = selectedEnvironmentId;
  selectedSessionIdRef.current = selectedSessionId;

  useEffect(() => {
    cloudStateVersionRef.current += 1;
  }, [environments, preferences, sessions]);

  const applyCloudSnapshot = useCallback(
    (snapshot: SandpiCloudSnapshot) => {
      const nextEnvironments = mergeCloudEnvironments(
        environmentsRef.current,
        snapshot.environments,
      );
      const nextSessions = mergeCloudSessions(
        sessionsRef.current,
        snapshot.sessions,
      );
      const next = reconcileCloudWorkspaceState(
        {
          environments: environmentsRef.current,
          sessions: sessionsRef.current,
          selectedEnvironmentId: selectedEnvironmentIdRef.current,
          selectedSessionId: selectedSessionIdRef.current,
        },
        {
          environments: nextEnvironments,
          sessions: nextSessions,
        },
      );
      const environmentChanged =
        next.selectedEnvironmentId !== selectedEnvironmentIdRef.current;
      const selectionChanged =
        environmentChanged ||
        next.selectedSessionId !== selectedSessionIdRef.current;

      environmentsRef.current = next.environments;
      sessionsRef.current = next.sessions;
      selectedEnvironmentIdRef.current = next.selectedEnvironmentId;
      selectedSessionIdRef.current = next.selectedSessionId;
      setEnvironments(next.environments);
      setSessions(next.sessions);
      setSelectedEnvironmentId(next.selectedEnvironmentId);
      setSelectedSessionId(next.selectedSessionId);
      setPreferences(snapshot.preferences);
      saveClientPreferences(snapshot.preferences);
      const hydratedAt = Date.now();
      sessionHydratedAtRef.current = new Map(
        next.sessions.map((session) => [session.id, hydratedAt] as const),
      );

      setSettingsTarget((current) =>
        current &&
        next.environments.some(
          (environment) => environment.id === current.environmentId,
        )
          ? current
          : null,
      );
      if (environmentChanged) setTerminalOpen(false);
      if (selectionChanged) {
        setNewSessionPreset(null);
        const environment = next.environments.find(
          (candidate) => candidate.id === next.selectedEnvironmentId,
        );
        if (environment) {
          replaceWorkspaceUrl(
            environment.id,
            next.selectedSessionId || undefined,
          );
        } else {
          replaceEmptyWorkspaceUrl();
        }
      }
    },
    [],
  );
  const getCloudStateVersion = useCallback(
    () => cloudStateVersionRef.current,
    [],
  );
  const handleCloudSynchronized = useCallback(() => {
    setCloudRefreshEpoch((current) => current + 1);
  }, []);
  const cloudSync = useCloudStateSync({
    applySnapshot: applyCloudSnapshot,
    getLocalStateVersion: getCloudStateVersion,
    onSynchronized: handleCloudSynchronized,
  });

  const hydrateSession = useCallback((sessionId: string) => {
    const now = Date.now();
    const lastHydratedAt = sessionHydratedAtRef.current.get(sessionId);
    if (
      lastHydratedAt !== undefined &&
      now - lastHydratedAt < SESSION_HYDRATION_FRESHNESS_MS
    ) {
      return Promise.resolve();
    }
    const active = sessionHydrationsRef.current.get(sessionId);
    if (active) return active;
    const hydration = apiFetch<ApiEnvelope<CodingSession>>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
    )
      .then((response) => {
        sessionHydratedAtRef.current.set(sessionId, Date.now());
        setSessions((current) =>
          current.map((session) =>
            session.id === response.data.id ? response.data : session,
          ),
        );
      })
      .catch((error) => {
        console.error("Unable to refresh Session metadata", error);
      })
      .finally(() => {
        if (sessionHydrationsRef.current.get(sessionId) === hydration) {
          sessionHydrationsRef.current.delete(sessionId);
        }
      });
    sessionHydrationsRef.current.set(sessionId, hydration);
    return hydration;
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

    window.addEventListener(
      CLIENT_PREFERENCES_CHANGED_EVENT,
      synchronizePreferences,
    );
    window.addEventListener("storage", handleStorage);
    setPreferences(initialData.preferences);
    saveClientPreferences(initialData.preferences);
    return () => {
      window.removeEventListener(
        CLIENT_PREFERENCES_CHANGED_EVENT,
        synchronizePreferences,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [initialData.preferences]);

  useEffect(() => {
    setInspectorOpen(storedInspectorOpen);
  }, [storedInspectorOpen]);

  useEffect(() => {
    setInspectorWidthRatio(storedInspectorWidthRatio);
  }, [storedInspectorWidthRatio]);

  useEffect(() => {
    if (terminalMaximized) return;
    setTerminalHeight(storedTerminalHeight);
    setTerminalRestoreHeight(storedTerminalHeight);
  }, [storedTerminalHeight, terminalMaximized]);

  useEffect(() => {
    const narrowViewport = window.matchMedia("(max-width: 960px)");
    const fullWidthInspector = window.matchMedia("(max-width: 680px)");
    const closeInspectorOnNarrowViewport = (
      event: MediaQueryListEvent | MediaQueryList,
    ) => {
      if (event.matches) {
        setInspectorOpen(false);
      } else {
        setInspectorOpen(loadLocalUiPreferences().workspace.inspectorOpen);
      }
    };
    const synchronizeInspectorCoverage = (
      event: MediaQueryListEvent | MediaQueryList,
    ) => setInspectorCoversViewport(event.matches);

    closeInspectorOnNarrowViewport(narrowViewport);
    synchronizeInspectorCoverage(fullWidthInspector);
    narrowViewport.addEventListener("change", closeInspectorOnNarrowViewport);
    fullWidthInspector.addEventListener(
      "change",
      synchronizeInspectorCoverage,
    );
    return () => {
      narrowViewport.removeEventListener(
        "change",
        closeInspectorOnNarrowViewport,
      );
      fullWidthInspector.removeEventListener(
        "change",
        synchronizeInspectorCoverage,
      );
    };
  }, []);

  const canManageEnvironment = useCallback(
    (environment: Environment) => environment.ownerId === initialData.viewer.id,
    [initialData.viewer.id],
  );

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
    [selectedEnvironmentId, selectedSessionId, sessions],
  );
  const [
    mountedNewSessionInspectorEnvironmentId,
    setMountedNewSessionInspectorEnvironmentId,
  ] = useState("");

  useEffect(() => {
    if (!selectedEnvironment) {
      setMountedNewSessionInspectorEnvironmentId("");
      return;
    }
    if (selectedSession) {
      setMountedNewSessionInspectorEnvironmentId("");
      return;
    }
    if (inspectorOpen) {
      setMountedNewSessionInspectorEnvironmentId(selectedEnvironment.id);
      return;
    }
    setMountedNewSessionInspectorEnvironmentId((current) =>
      current === selectedEnvironment.id ? current : "",
    );
    const environmentId = selectedEnvironment.id;
    const timeout = window.setTimeout(() => {
      setMountedNewSessionInspectorEnvironmentId((current) =>
        current === environmentId ? "" : current,
      );
    }, INSPECTOR_KEEP_ALIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [inspectorOpen, selectedEnvironment, selectedSession]);

  const openWorkspacePath = useCallback(
    (requestedPath: string) => {
      const path = userVisibleWorkspacePath(requestedPath);
      if (!path || !selectedEnvironment) return;
      workspaceNavigationRequestIdRef.current += 1;
      setWorkspaceNavigationRequest({
        environmentId: selectedEnvironment.id,
        path,
        requestId: workspaceNavigationRequestIdRef.current,
      });
      const url = new URL(window.location.href);
      url.searchParams.set("path", path);
      window.history.replaceState(window.history.state, "", url);
      updateLocalUiPreferences((current) => ({
        ...current,
        workspace: {
          ...current.workspace,
          inspectorOpen: true,
          inspectorTab: "files",
        },
      }));
      setInspectorOpen(true);
    },
    [selectedEnvironment],
  );

  const handleWorkspaceNavigationHandled = useCallback(
    (handled: WorkspaceFileNavigationRequest) => {
      setWorkspaceNavigationRequest((current) =>
        current?.environmentId === handled.environmentId &&
        current.requestId === handled.requestId
          ? undefined
          : current,
      );
    },
    [],
  );

  const openBrowserUrl = useCallback(
    (url: string) => {
      if (!selectedEnvironment) return;
      browserNavigationRequestIdRef.current += 1;
      setBrowserNavigationRequest({
        id: browserNavigationRequestIdRef.current,
        environmentId: selectedEnvironment.id,
        url,
      });
      updateLocalUiPreferences((current) => ({
        ...current,
        workspace: {
          ...current.workspace,
          inspectorOpen: true,
          inspectorTab: "browser",
        },
      }));
      setInspectorOpen(true);
    },
    [selectedEnvironment],
  );

  const handleBrowserNavigationHandled = useCallback(
    (handled: EnvironmentBrowserNavigationRequest) => {
      setBrowserNavigationRequest((current) =>
        current?.environmentId === handled.environmentId &&
        current.id === handled.id
          ? undefined
          : current,
      );
    },
    [],
  );

  useEffect(() => {
    setWorkspaceNavigationRequest((current) =>
      current?.environmentId === selectedEnvironment?.id ? current : undefined,
    );
    setBrowserNavigationRequest((current) =>
      current?.environmentId === selectedEnvironment?.id ? current : undefined,
    );
  }, [selectedEnvironment?.id]);

  useEffect(() => {
    if (
      restoredWorkspaceNavigationRef.current ||
      !selectedEnvironment ||
      !selectedSession
    ) {
      return;
    }
    restoredWorkspaceNavigationRef.current = true;
    const requestedPath = new URLSearchParams(window.location.search).get(
      "path",
    );
    if (requestedPath) openWorkspacePath(requestedPath);
  }, [openWorkspacePath, selectedEnvironment, selectedSession]);

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
      environments.find(
        (environment) => environment.id === settingsTarget?.environmentId,
      ) ?? null,
    [environments, settingsTarget?.environmentId],
  );

  const openEnvironmentSettings = useCallback(
    (
      environmentId: string,
      initialTab: EnvironmentSettingsTab = "general",
      options: EnvironmentSettingsOpenOptions = {},
    ) => {
      const environment = environments.find(
        (candidate) => candidate.id === environmentId,
      );
      if (environment && canManageEnvironment(environment)) {
        setSettingsTarget({
          environmentId,
          initialTab,
          mcpVerbose: options.mcpVerbose,
        });
      }
    },
    [canManageEnvironment, environments],
  );

  const handleSelectEnvironment = useCallback(
    (environmentId: string) => {
      const environment = environments.find(
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
        replaceWorkspaceUrl(environmentId, firstSession.id);
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
        replaceWorkspaceUrl(environmentId);
      }
      setNewSessionPreset(null);
      setSidebarOpen(false);
    },
    [environments, hydrateSession, sessions],
  );

  const handleNewSession = useCallback(
    (
      environmentId: string,
      options?: { title?: string; source?: "startup" | "clear" },
    ) => {
      if (
        !environments.some(
          (environment) => environment.id === environmentId,
        )
      ) {
        return;
      }
      setSelectedEnvironmentId(environmentId);
      setSelectedSessionId("");
      setNewSessionPreset(options ?? null);
      replaceWorkspaceUrl(environmentId);
      setSidebarOpen(false);
    },
    [environments],
  );

  const handleToggleNavigation = useCallback(() => {
    if (window.matchMedia("(max-width: 960px)").matches) {
      setSidebarOpen((open) => !open);
      return;
    }
    updateLocalUiPreferences((current) => ({
      ...current,
      workspace: { ...current.workspace, sidebarCollapsed: false },
    }));
  }, []);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find(
        (item) => item.id === sessionId && !item.archived,
      );
      const environment = session
        ? environments.find((item) => item.id === session.environmentId)
        : undefined;
      if (session && environment) {
        setSelectedSessionId(sessionId);
        setSelectedEnvironmentId(session.environmentId);
        replaceWorkspaceUrl(session.environmentId, sessionId);
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
    [environments, hydrateSession, sessions],
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

  const handleEnvironmentWorkspaceRestore = useCallback(
    (nextEnvironment: Environment) => {
      handleEnvironmentChange(nextEnvironment);
      void apiFetch<ApiEnvelope<CodingSession[]>>("/api/v1/sessions")
        .then((response) => setSessions(response.data))
        .catch((error) =>
          console.error(
            "Unable to refresh Sessions after Workspace restore",
            error,
          ),
        );
    },
    [handleEnvironmentChange],
  );

  const handleEnvironmentDeleted = useCallback(
    (environmentId: string) => {
      const remainingEnvironments = environments.filter(
        (environment) => environment.id !== environmentId,
      );
      const remainingSessions = sessions.filter(
        (session) => session.environmentId !== environmentId,
      );
      const nextEnvironment = remainingEnvironments[0];
      const nextSession = nextEnvironment
        ? visibleSessionsForEnvironment(
            remainingSessions,
            nextEnvironment.id,
          )[0]
        : undefined;

      setEnvironments((current) =>
        current.filter((environment) => environment.id !== environmentId),
      );
      setSessions((current) =>
        current.filter((session) => session.environmentId !== environmentId),
      );
      setSettingsTarget(null);
      setTerminalOpen(false);

      if (selectedEnvironmentId === environmentId) {
        setSelectedEnvironmentId(nextEnvironment?.id ?? "");
        setSelectedSessionId(nextSession?.id ?? "");
        if (nextEnvironment) {
          replaceWorkspaceUrl(nextEnvironment.id, nextSession?.id);
          if (nextSession) void hydrateSession(nextSession.id);
        } else {
          replaceEmptyWorkspaceUrl();
        }
      }
    },
    [
      environments,
      hydrateSession,
      selectedEnvironmentId,
      sessions,
    ],
  );

  const handleSessionCreated = useCallback(
    (session: CodingSession) => {
      setSessions((current) => [
        session,
        ...current.filter((candidate) => candidate.id !== session.id),
      ]);
      setSelectedEnvironmentId(session.environmentId);
      setSelectedSessionId(session.id);
      setNewSessionPreset(null);
      replaceWorkspaceUrl(session.environmentId, session.id);
      setTerminalOpen(false);
    },
    [],
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
              archivedSession.environmentId,
              nextSession?.id,
            );
          }
        })
        .catch((error) => {
          console.error("Unable to archive Session", error);
        });
    },
    [persistSessionMetadata, selectedSessionId, sessions],
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
    setEnvironments((current) => [...current, environment]);
    setSelectedEnvironmentId(environment.id);
    setSelectedSessionId("");
    replaceWorkspaceUrl(environment.id);
    setTerminalOpen(false);
    setNewEnvironmentOpen(false);
  }, []);

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
    updateLocalUiPreferences((current) => ({
      ...current,
      workspace: { ...current.workspace, terminalHeight: height },
    }));
  }, []);

  const handleInspectorTabChange = useCallback((tab: InspectorTab) => {
    updateLocalUiPreferences((current) => ({
      ...current,
      workspace: { ...current.workspace, inspectorTab: tab },
    }));
  }, []);

  const handleInspectorOpenChange = useCallback((open: boolean) => {
    setInspectorOpen(open);
    if (!open) {
      const url = new URL(window.location.href);
      url.searchParams.delete("path");
      window.history.replaceState(window.history.state, "", url);
    }
    updateLocalUiPreferences((current) => ({
      ...current,
      workspace: { ...current.workspace, inspectorOpen: open },
    }));
  }, []);

  const handleInspectorWidthRatioChange = useCallback(
    (ratio: number, persist: boolean) => {
      const normalizedRatio = normalizeInspectorWidthRatio(ratio);
      setInspectorWidthRatio(normalizedRatio);
      if (!persist) return;
      updateLocalUiPreferences((current) => ({
        ...current,
        workspace: {
          ...current.workspace,
          inspectorWidthRatio: normalizedRatio,
        },
      }));
    },
    [],
  );

  const handleSidebarCollapsedChange = useCallback((collapsed: boolean) => {
    updateLocalUiPreferences((current) => ({
      ...current,
      workspace: { ...current.workspace, sidebarCollapsed: collapsed },
    }));
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

  const showInspector = inspectorOpen;
  const showTerminal = terminalOpen;
  const workspaceStyle = {
    "--conversation-pane-size": `${1 - inspectorWidthRatio}fr`,
    "--inspector-pane-size": `${inspectorWidthRatio}fr`,
    ...(showTerminal
      ? { "--terminal-height": `${terminalHeight}px` }
      : {}),
  } as CSSProperties;
  const sidebar = (
    <Sidebar
      language={preferences.general.language}
      viewer={initialData.viewer}
      environments={environments}
      sessions={sessions}
      selectedEnvironmentId={selectedEnvironment?.id ?? ""}
      selectedSessionId={selectedSession?.id ?? ""}
      onSelectEnvironment={handleSelectEnvironment}
      onSelectSession={handleSelectSession}
      onNewEnvironment={() => setNewEnvironmentOpen(true)}
      onNewSession={handleNewSession}
      onEnvironmentSettings={(environmentId) => {
        handleSelectEnvironment(environmentId);
        openEnvironmentSettings(environmentId);
      }}
      onRenameSession={handleRenameSession}
      onForkSession={handleForkSession}
      onArchiveSession={handleArchiveSession}
      onTogglePinSession={handleTogglePinSession}
      onCollapse={() => {
        handleSidebarCollapsedChange(true);
        setSidebarOpen(false);
      }}
      onCloseMobile={() => setSidebarOpen(false)}
    />
  );

  if (!selectedEnvironment) {
    return (
      <AppFrame
        as="main"
        className={`app-shell environment-empty-shell ${
          sidebarOpen ? "sidebar-is-open" : ""
        } ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}
      >
        <NativePullToRefresh
          language={preferences.general.language}
          onRefresh={() => cloudSync.refresh("pull", { force: true })}
        />
        {sidebar}
        {sidebarOpen ? (
          <button
            type="button"
            className="mobile-scrim"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}
        <section className="environment-empty-pane">
          <header data-tauri-drag-region="deep">
            <button
              type="button"
              className="icon-button sidebar-expand-button"
              aria-label="Expand sidebar"
              onClick={() => handleSidebarCollapsedChange(false)}
            >
              <PanelLeftOpen size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button mobile-menu-button"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen size={17} aria-hidden="true" />
            </button>
          </header>
          <div className="environment-empty-card">
            <span aria-hidden="true">
              <Box size={25} />
            </span>
            <h1>Create an Environment</h1>
            <p>
              Environments own the Sandbox, Workspace and coding-agent account
              shared by their Sessions.
            </p>
            <button
              type="button"
              className="button-primary"
              onClick={() => setNewEnvironmentOpen(true)}
            >
              <Plus size={15} aria-hidden="true" />
              New Environment
            </button>
          </div>
        </section>
        {newEnvironmentOpen ? (
          <NewEnvironmentDialog
            environments={environments}
            onCreated={handleEnvironmentCreated}
            onClose={() => setNewEnvironmentOpen(false)}
          />
        ) : null}
      </AppFrame>
    );
  }

  return (
    <AppFrame
      as="main"
      className={`app-shell ${showInspector ? "inspector-is-open" : ""} ${
        showTerminal ? "terminal-is-open" : ""
      } ${sidebarOpen ? "sidebar-is-open" : ""} ${
        sidebarCollapsed ? "sidebar-is-collapsed" : ""
      }`}
      style={workspaceStyle}
    >
      <NativePullToRefresh
        language={preferences.general.language}
        onRefresh={() => cloudSync.refresh("pull", { force: true })}
      />
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      {sidebar}

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
          timeZone={preferences.general.timeZone}
          sendShortcut={preferences.general.sendShortcut}
          viewer={initialData.viewer}
          environment={selectedEnvironment}
          session={selectedSession}
          refreshEpoch={cloudRefreshEpoch}
          inspectorOpen={showInspector}
          inspectorTab={inspectorTab}
          inspectorWidthRatio={inspectorWidthRatio}
          terminalOpen={showTerminal}
          onToggleSidebar={handleToggleNavigation}
          onToggleInspector={() => handleInspectorOpenChange(!showInspector)}
          onInspectorTabChange={handleInspectorTabChange}
          onInspectorWidthRatioChange={handleInspectorWidthRatioChange}
          onToggleTerminal={() => setTerminalOpen((open) => !open)}
          onNewSession={(options) =>
            handleNewSession(selectedEnvironment.id, options)
          }
          onOpenEnvironmentSettings={(tab, options) =>
            openEnvironmentSettings(selectedEnvironment.id, tab, options)
          }
          onOpenInspector={(tab) => {
            handleInspectorTabChange(tab);
            handleInspectorOpenChange(true);
          }}
          workspaceNavigationRequest={workspaceNavigationRequest}
          onOpenWorkspacePath={openWorkspacePath}
          onOpenBrowserUrl={openBrowserUrl}
          onWorkspaceNavigationHandled={handleWorkspaceNavigationHandled}
          browserNavigationRequest={browserNavigationRequest}
          onBrowserNavigationHandled={handleBrowserNavigationHandled}
          onSessionChange={handleSessionChange}
          onDerivedSessionCreated={handleSessionCreated}
        />
      ) : (
        <NewSessionWorkspace
          language={preferences.general.language}
          sendShortcut={preferences.general.sendShortcut}
          environment={selectedEnvironment}
          canManageEnvironment={canManageEnvironment(selectedEnvironment)}
          onEnvironmentChange={handleEnvironmentChange}
          onCreated={handleSessionCreated}
          initialTitle={newSessionPreset?.title}
          sessionStartSource={newSessionPreset?.source}
          onOpenAgentHarnessSettings={() =>
            openEnvironmentSettings(selectedEnvironment.id, "credentials")
          }
          onOpenEnvironmentSettings={(tab, options) =>
            openEnvironmentSettings(selectedEnvironment.id, tab, options)
          }
          onToggleSidebar={handleToggleNavigation}
          inspectorOpen={showInspector}
          onToggleInspector={() => handleInspectorOpenChange(!showInspector)}
          terminalOpen={showTerminal}
          onToggleTerminal={() => setTerminalOpen((open) => !open)}
          onOpenWorkspacePath={openWorkspacePath}
        />
      )}

      {!selectedSession &&
      (showInspector ||
        mountedNewSessionInspectorEnvironmentId === selectedEnvironment.id) ? (
        <Inspector
          language={preferences.general.language}
          timeZone={preferences.general.timeZone}
          environment={selectedEnvironment}
          hidden={!showInspector}
          workspaceNavigationRequest={workspaceNavigationRequest}
          onWorkspaceNavigationHandled={handleWorkspaceNavigationHandled}
          browserNavigationRequest={browserNavigationRequest}
          onBrowserNavigationHandled={handleBrowserNavigationHandled}
          activeTab={inspectorTab === "activity" ? "files" : inspectorTab}
          onTabChange={handleInspectorTabChange}
          widthRatio={inspectorWidthRatio}
          onWidthRatioChange={handleInspectorWidthRatioChange}
          onClose={() => handleInspectorOpenChange(false)}
        />
      ) : null}

      {showTerminal ? (
        <TerminalDock
          environment={selectedEnvironment}
          height={terminalHeight}
          maximized={terminalMaximized}
          onHeightChange={handleTerminalHeightChange}
          onToggleMaximize={handleToggleTerminalMaximize}
          onClose={() => setTerminalOpen(false)}
        />
      ) : null}

      {settingsEnvironment ? (
        <EnvironmentSettings
          key={settingsEnvironment.id}
          environment={settingsEnvironment}
          initialTab={settingsTarget?.initialTab}
          initialMcpVerbose={settingsTarget?.mcpVerbose}
          language={preferences.general.language}
          timeZone={preferences.general.timeZone}
          sessions={sessions.filter(
            (session) =>
              session.environmentId === settingsEnvironment.id &&
              !session.archived,
          )}
          archivedSessions={sessions
            .filter(
              (session) =>
                session.environmentId === settingsEnvironment.id &&
                session.archived,
            )
            .sort(
              (left, right) =>
                right.updatedAt - left.updatedAt,
            )}
          onChange={handleEnvironmentChange}
          onWorkspaceRestore={handleEnvironmentWorkspaceRestore}
          onDelete={handleEnvironmentDeleted}
          onRestoreSession={handleRestoreSession}
          onClose={() => setSettingsTarget(null)}
        />
      ) : null}

      {newEnvironmentOpen ? (
        <NewEnvironmentDialog
          environments={environments}
          onCreated={handleEnvironmentCreated}
          onClose={() => setNewEnvironmentOpen(false)}
        />
      ) : null}
    </AppFrame>
  );
}
