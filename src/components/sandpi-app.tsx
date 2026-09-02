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

import { AgentTerminalWorkspace } from "@/components/agent-terminal-workspace";
import { AppFrame } from "@/components/app-frame";
import { EnvironmentForkDialog } from "@/components/environment-fork-dialog";
import {
  EnvironmentSettings,
  type EnvironmentSettingsOpenOptions,
  type EnvironmentSettingsTab,
} from "@/components/environment-settings";
import { EnvironmentSidebar } from "@/components/environment-sidebar";
import {
  Inspector,
  INSPECTOR_KEEP_ALIVE_MS,
  type InspectorTab,
} from "@/components/inspector";
import { NativePullToRefresh } from "@/components/native-pull-to-refresh";
import { NewEnvironmentDialog } from "@/components/new-environment-dialog";
import type { WorkspaceFileNavigationRequest } from "@/components/workspace-ide";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import {
  applyClientPreferences,
  CLIENT_PREFERENCES_CHANGED_EVENT,
  CLIENT_PREFERENCES_STORAGE_KEY,
  loadClientPreferences,
  saveClientPreferences,
} from "@/lib/client-preferences";
import { mergeCloudEnvironments } from "@/lib/cloud-state-sync";
import {
  loadLocalUiPreferences,
  updateLocalUiPreferences,
} from "@/lib/local-ui-preferences";
import { sandboxLoopbackUrl } from "@/lib/sandbox-loopback-url";
import type {
  Environment,
  SandpiBootstrap,
  SandpiCloudSnapshot,
} from "@/lib/types";
import { useCloudStateSync } from "@/lib/use-cloud-state-sync";
import { useLocalUiPreferences } from "@/lib/use-local-ui-preferences";
import { useNativeChromeSurfaces } from "@/lib/use-native-chrome-surfaces";
import { userVisibleWorkspacePath } from "@/lib/workspace-path-policy";
import { normalizeInspectorWidthRatio } from "@/lib/workspace-layout";

interface SandpiAppProps {
  initialData: SandpiBootstrap;
}

function replaceWorkspaceUrl(environmentId: string) {
  const url = new URL(window.location.href);
  const previousEnvironmentId = url.searchParams.get("environment");
  const previousPath = url.searchParams.get("path");
  url.search = "";
  url.searchParams.set("environment", environmentId);
  if (previousEnvironmentId === environmentId && previousPath) {
    url.searchParams.set("path", previousPath);
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
  const [preferences, setPreferences] = useState(initialData.preferences);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(() => {
    const requested = initialData.selectedEnvironmentId;
    return initialData.environments.some(({ id }) => id === requested)
      ? requested
      : (initialData.environments[0]?.id ?? "");
  });
  const [settingsTarget, setSettingsTarget] = useState<{
    environmentId: string;
    initialTab: EnvironmentSettingsTab;
    mcpVerbose?: boolean;
  } | null>(null);
  const [newEnvironmentOpen, setNewEnvironmentOpen] = useState(false);
  const [forkSourceEnvironmentId, setForkSourceEnvironmentId] =
    useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorCoversViewport, setInspectorCoversViewport] = useState(false);
  const fullWidthInspectorOpen = inspectorOpen && inspectorCoversViewport;
  useNativeChromeSurfaces(
    sidebarOpen ? "sidebar" : fullWidthInspectorOpen ? "panel" : "canvas",
    sidebarOpen ? "sidebar" : fullWidthInspectorOpen ? "panel" : "terminal",
  );

  const [workspaceNavigationRequest, setWorkspaceNavigationRequest] =
    useState<WorkspaceFileNavigationRequest>();
  const [sandboxPreviewRequest, setSandboxPreviewRequest] = useState<{
    environmentId: string;
    url: string;
  }>();
  const [mountedInspectorEnvironmentId, setMountedInspectorEnvironmentId] =
    useState("");
  const localUiPreferences = useLocalUiPreferences();
  const inspectorTab = localUiPreferences.workspace.inspectorTab;
  const sidebarCollapsed = localUiPreferences.workspace.sidebarCollapsed;
  const storedInspectorOpen = localUiPreferences.workspace.inspectorOpen;
  const storedInspectorWidthRatio =
    localUiPreferences.workspace.inspectorWidthRatio;
  const [inspectorWidthRatio, setInspectorWidthRatio] = useState(
    storedInspectorWidthRatio,
  );

  const workspaceNavigationRequestIdRef = useRef(0);
  const environmentOrderRequestIdRef = useRef(0);
  const restoredWorkspaceNavigationRef = useRef(false);
  const restoredEnvironmentSettingsRef = useRef(false);
  const environmentsRef = useRef(environments);
  const selectedEnvironmentIdRef = useRef(selectedEnvironmentId);
  const cloudStateVersionRef = useRef(0);
  environmentsRef.current = environments;
  selectedEnvironmentIdRef.current = selectedEnvironmentId;

  useEffect(() => {
    cloudStateVersionRef.current += 1;
  }, [environments, preferences]);

  const applyCloudSnapshot = useCallback((snapshot: SandpiCloudSnapshot) => {
    const nextEnvironments = mergeCloudEnvironments(
      environmentsRef.current,
      snapshot.environments,
    );
    const currentSelection = selectedEnvironmentIdRef.current;
    const nextSelection = nextEnvironments.some(
      ({ id }) => id === currentSelection,
    )
      ? currentSelection
      : (nextEnvironments[0]?.id ?? "");

    environmentsRef.current = nextEnvironments;
    selectedEnvironmentIdRef.current = nextSelection;
    setEnvironments(nextEnvironments);
    setSelectedEnvironmentId(nextSelection);
    setPreferences(snapshot.preferences);
    saveClientPreferences(snapshot.preferences);
    setSettingsTarget((current) =>
      current &&
      nextEnvironments.some(({ id }) => id === current.environmentId)
        ? current
        : null,
    );

    if (nextSelection) replaceWorkspaceUrl(nextSelection);
    else replaceEmptyWorkspaceUrl();
  }, []);

  const getCloudStateVersion = useCallback(
    () => cloudStateVersionRef.current,
    [],
  );
  const cloudSync = useCloudStateSync({
    applySnapshot: applyCloudSnapshot,
    getLocalStateVersion: getCloudStateVersion,
  });

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

  useEffect(() => setInspectorOpen(storedInspectorOpen), [storedInspectorOpen]);
  useEffect(
    () => setInspectorWidthRatio(storedInspectorWidthRatio),
    [storedInspectorWidthRatio],
  );

  useEffect(() => {
    const narrowViewport = window.matchMedia("(max-width: 960px)");
    const fullWidthInspector = window.matchMedia("(max-width: 680px)");
    const synchronizeInspector = (
      event: MediaQueryListEvent | MediaQueryList,
    ) => {
      setInspectorOpen(
        event.matches
          ? false
          : loadLocalUiPreferences().workspace.inspectorOpen,
      );
    };
    const synchronizeCoverage = (
      event: MediaQueryListEvent | MediaQueryList,
    ) => setInspectorCoversViewport(event.matches);

    synchronizeInspector(narrowViewport);
    synchronizeCoverage(fullWidthInspector);
    narrowViewport.addEventListener("change", synchronizeInspector);
    fullWidthInspector.addEventListener("change", synchronizeCoverage);
    return () => {
      narrowViewport.removeEventListener("change", synchronizeInspector);
      fullWidthInspector.removeEventListener("change", synchronizeCoverage);
    };
  }, []);

  const canManageEnvironment = useCallback(
    (environment: Environment) => environment.ownerId === initialData.viewer.id,
    [initialData.viewer.id],
  );
  const selectedEnvironment = useMemo(
    () =>
      environments.find(({ id }) => id === selectedEnvironmentId) ??
      environments[0],
    [environments, selectedEnvironmentId],
  );
  const settingsEnvironment = useMemo(
    () =>
      environments.find(({ id }) => id === settingsTarget?.environmentId) ??
      null,
    [environments, settingsTarget?.environmentId],
  );

  useEffect(() => {
    if (!selectedEnvironment) {
      setMountedInspectorEnvironmentId("");
      return;
    }
    if (inspectorOpen) {
      setMountedInspectorEnvironmentId(selectedEnvironment.id);
      return;
    }
    const environmentId = selectedEnvironment.id;
    const timeout = window.setTimeout(() => {
      setMountedInspectorEnvironmentId((current) =>
        current === environmentId ? "" : current,
      );
    }, INSPECTOR_KEEP_ALIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [inspectorOpen, selectedEnvironment]);

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

  const openSandboxPreview = useCallback(
    (requestedUrl: string) => {
      const url = sandboxLoopbackUrl(requestedUrl);
      if (!url || !selectedEnvironment) return;
      setSandboxPreviewRequest({ environmentId: selectedEnvironment.id, url });
      updateLocalUiPreferences((current) => ({
        ...current,
        workspace: {
          ...current.workspace,
          inspectorOpen: true,
          inspectorTab: "preview",
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

  useEffect(() => {
    setWorkspaceNavigationRequest((current) =>
      current?.environmentId === selectedEnvironment?.id ? current : undefined,
    );
  }, [selectedEnvironment?.id]);

  useEffect(() => {
    if (restoredWorkspaceNavigationRef.current || !selectedEnvironment) return;
    restoredWorkspaceNavigationRef.current = true;
    const path = new URLSearchParams(window.location.search).get("path");
    if (path) openWorkspacePath(path);
  }, [openWorkspacePath, selectedEnvironment]);

  useEffect(() => {
    if (!environments.some(({ status }) => status === "updating")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiFetch<ApiEnvelope<Environment[]>>("/api/v1/environments", {
        signal: controller.signal,
      })
        .then(({ data }) => setEnvironments(data))
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

  const openEnvironmentSettings = useCallback(
    (
      environmentId: string,
      initialTab: EnvironmentSettingsTab = "general",
      options: EnvironmentSettingsOpenOptions = {},
    ) => {
      const environment = environments.find(({ id }) => id === environmentId);
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

  useEffect(() => {
    if (restoredEnvironmentSettingsRef.current) return;
    const search = new URLSearchParams(window.location.search);
    if (search.get("settings") !== "sandbox") return;
    const environmentId = search.get("environment");
    if (!environmentId) return;
    const environment = environments.find(({ id }) => id === environmentId);
    if (!environment) return;
    restoredEnvironmentSettingsRef.current = true;
    openEnvironmentSettings(environmentId, "sandbox");
  }, [environments, openEnvironmentSettings]);

  const handleSelectEnvironment = useCallback(
    (environmentId: string) => {
      if (!environments.some(({ id }) => id === environmentId)) return;
      setSelectedEnvironmentId(environmentId);
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

  const handleEnvironmentChange = useCallback((next: Environment) => {
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === next.id ? next : environment,
      ),
    );
  }, []);

  const handleReorderEnvironments = useCallback((reordered: Environment[]) => {
    const previous = environmentsRef.current;
    const requestId = ++environmentOrderRequestIdRef.current;
    environmentsRef.current = reordered;
    setEnvironments(reordered);
    void apiFetch<ApiEnvelope<Environment[]>>("/api/v1/environments/order", {
      method: "PUT",
      body: JSON.stringify({
        environmentIds: reordered.map(({ id }) => id),
      }),
    })
      .then(({ data }) => {
        if (requestId !== environmentOrderRequestIdRef.current) return;
        environmentsRef.current = data;
        setEnvironments(data);
      })
      .catch((error) => {
        if (requestId !== environmentOrderRequestIdRef.current) return;
        environmentsRef.current = previous;
        setEnvironments(previous);
        console.error("Unable to reorder Environments", error);
      });
  }, []);

  const handleEnvironmentDeleted = useCallback(
    (environmentId: string) => {
      const remaining = environments.filter(({ id }) => id !== environmentId);
      const nextEnvironment = remaining[0];
      setEnvironments(remaining);
      setSettingsTarget(null);
      if (selectedEnvironmentId === environmentId) {
        setSelectedEnvironmentId(nextEnvironment?.id ?? "");
        if (nextEnvironment) replaceWorkspaceUrl(nextEnvironment.id);
        else replaceEmptyWorkspaceUrl();
      }
    },
    [environments, selectedEnvironmentId],
  );

  const handleEnvironmentCreated = useCallback((environment: Environment) => {
    setEnvironments((current) => [...current, environment]);
    setSelectedEnvironmentId(environment.id);
    replaceWorkspaceUrl(environment.id);
    setNewEnvironmentOpen(false);
    setForkSourceEnvironmentId(undefined);
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
      const normalized = normalizeInspectorWidthRatio(ratio);
      setInspectorWidthRatio(normalized);
      if (!persist) return;
      updateLocalUiPreferences((current) => ({
        ...current,
        workspace: {
          ...current.workspace,
          inspectorWidthRatio: normalized,
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

  const showInspector = inspectorOpen;
  const workspaceStyle = {
    "--conversation-pane-size": `${1 - inspectorWidthRatio}fr`,
    "--inspector-pane-size": `${inspectorWidthRatio}fr`,
  } as CSSProperties;
  const sidebar = (
    <EnvironmentSidebar
      language={preferences.general.language}
      timeZone={preferences.general.timeZone}
      viewer={initialData.viewer}
      environments={environments}
      selectedEnvironmentId={selectedEnvironment?.id ?? ""}
      onSelectEnvironment={handleSelectEnvironment}
      onNewEnvironment={() => setNewEnvironmentOpen(true)}
      onEnvironmentSettings={(environmentId) => {
        handleSelectEnvironment(environmentId);
        openEnvironmentSettings(environmentId);
      }}
      onReorderEnvironments={handleReorderEnvironments}
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
        className={`app-shell terminal-v2-shell environment-empty-shell ${
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
          <header
            data-native-titlebar-leading-content
            data-tauri-drag-region="deep"
          >
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
            <h1>CREATE AN ENVIRONMENT</h1>
            <p>
              One persistent Sandbox, one native coding-agent TUI, available
              from every device.
            </p>
            <button
              type="button"
              className="button-primary"
              onClick={() => setNewEnvironmentOpen(true)}
            >
              <Plus size={15} aria-hidden="true" />
              [NEW ENVIRONMENT]
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
      className={`app-shell terminal-v2-shell ${showInspector ? "inspector-is-open" : ""} ${
        sidebarOpen ? "sidebar-is-open" : ""
      } ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}
      style={workspaceStyle}
    >
      <NativePullToRefresh
        language={preferences.general.language}
        onRefresh={() => cloudSync.refresh("pull", { force: true })}
      />
      <a className="skip-link" href="#agent-terminal">
        Skip to Agent terminal
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

      <div id="agent-terminal" style={{ display: "contents" }}>
        <AgentTerminalWorkspace
          environment={selectedEnvironment}
          onToggleSidebar={handleToggleNavigation}
          onOpenFiles={() => {
            handleInspectorTabChange("files");
            handleInspectorOpenChange(true);
          }}
          onOpenSnapshots={() =>
            openEnvironmentSettings(selectedEnvironment.id, "sandbox")
          }
          onOpenFork={() => setForkSourceEnvironmentId(selectedEnvironment.id)}
          onOpenSettings={() => openEnvironmentSettings(selectedEnvironment.id)}
          onPause={async () => {
            const response = await apiFetch<ApiEnvelope<Environment>>(
              `/api/v1/environments/${encodeURIComponent(selectedEnvironment.id)}/sandbox/pause`,
              { method: "PUT" },
            );
            handleEnvironmentChange(response.data);
          }}
          onResume={async () => {
            const response = await apiFetch<ApiEnvelope<Environment>>(
              `/api/v1/environments/${encodeURIComponent(selectedEnvironment.id)}/sandbox/restart`,
              { method: "PUT" },
            );
            handleEnvironmentChange(response.data);
          }}
          onOpenSandboxPreview={openSandboxPreview}
        />
      </div>

      {showInspector ||
      mountedInspectorEnvironmentId === selectedEnvironment.id ? (
        <Inspector
          language={preferences.general.language}
          timeZone={preferences.general.timeZone}
          environment={selectedEnvironment}
          hidden={!showInspector}
          workspaceNavigationRequest={workspaceNavigationRequest}
          onWorkspaceNavigationHandled={handleWorkspaceNavigationHandled}
          previewUrl={
            sandboxPreviewRequest?.environmentId === selectedEnvironment.id
              ? sandboxPreviewRequest.url
              : undefined
          }
          activeTab={inspectorTab === "activity" ? "files" : inspectorTab}
          onTabChange={handleInspectorTabChange}
          widthRatio={inspectorWidthRatio}
          onWidthRatioChange={handleInspectorWidthRatioChange}
          onOpenEnvironmentSettings={() =>
            openEnvironmentSettings(selectedEnvironment.id)
          }
          onClose={() => handleInspectorOpenChange(false)}
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
          sessions={[]}
          archivedSessions={[]}
          onChange={handleEnvironmentChange}
          onWorkspaceRestore={handleEnvironmentChange}
          onDelete={handleEnvironmentDeleted}
          onRestoreSession={() => undefined}
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

      {forkSourceEnvironmentId ? (
        <EnvironmentForkDialog
          source={
            environments.find(({ id }) => id === forkSourceEnvironmentId) ??
            selectedEnvironment
          }
          onCreated={handleEnvironmentCreated}
          onClose={() => setForkSourceEnvironmentId(undefined)}
        />
      ) : null}
    </AppFrame>
  );
}
