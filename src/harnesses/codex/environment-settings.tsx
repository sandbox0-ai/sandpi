"use client";

import {
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Link2,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type {
  CodexEnvironmentSkill,
  CodexMcpApprovalMode,
  CodexMcpCredentialInput,
  CodexMcpCredentialMutation,
  CodexMcpInventory,
  CodexMcpOAuthFlow,
  CodexMcpOAuthLoginInput,
  CodexMcpRemoteAuthMethod,
  CodexMcpServer,
  CodexMcpServerInput,
  CodexMcpTransport,
  CodexSkillsInventory,
} from "@/harnesses/codex/environment-tools";
import {
  CODEX_MCP_PRESET_CATEGORIES,
  CODEX_MCP_PRESETS,
  codexMcpInputFromPreset,
  type CodexMcpPreset,
} from "@/harnesses/codex/mcp-catalog";
import {
  codexMcpConnectionState,
  isTerminalCodexMcpOAuthFlow,
  mergeCodexMcpOAuthFlow,
  reduceCodexMcpConnectionStates,
  safeCodexMcpOAuthAuthorizationUrl,
  type CodexMcpConnectionState,
} from "@/harnesses/codex/mcp-status";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";

interface CodexEnvironmentSettingsProps {
  environmentId: string;
}

function NativeToggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function CodexSkillsSettings({
  environmentId,
}: CodexEnvironmentSettingsProps) {
  const [inventory, setInventory] = useState<CodexSkillsInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyPath, setBusyPath] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(
    async (force = false) => {
      if (force) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError("");
      try {
        const response = await apiFetch<ApiEnvelope<CodexSkillsInventory>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/skills${force ? "?force=1" : ""}`,
        );
        setInventory(response.data);
      } catch (loadError) {
        setError(errorMessage(loadError, "Could not load Codex skills."));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [environmentId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function setEnabled(skill: CodexEnvironmentSkill, enabled: boolean) {
    if (busyPath) return;
    setBusyPath(skill.path);
    setError("");
    try {
      const response = await apiFetch<
        ApiEnvelope<{ path: string; enabled: boolean }>
      >(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/skills/config`,
        {
          method: "PUT",
          body: JSON.stringify({ path: skill.path, enabled }),
        },
      );
      setInventory((current) =>
        current
          ? {
              ...current,
              skills: current.skills.map((candidate) =>
                candidate.path === response.data.path
                  ? { ...candidate, enabled: response.data.enabled }
                  : candidate,
              ),
            }
          : current,
      );
    } catch (updateError) {
      setError(errorMessage(updateError, "Could not update the Codex skill."));
    } finally {
      setBusyPath("");
    }
  }

  return (
    <div className="codex-extension-panel">
      <ExtensionToolbar
        detail="Discovered by Codex from /workspace and its native user, admin and system locations."
        actionLabel="Refresh skills"
        busy={refreshing}
        onAction={() => void load(true)}
      />
      {error ? <ExtensionError message={error} /> : null}
      {loading ? (
        <ExtensionSkeleton rows={3} />
      ) : inventory && inventory.skills.length > 0 ? (
        <div className="codex-extension-list" aria-label="Codex skills">
          {inventory.skills.map((skill) => (
            <article className="codex-skill-row" key={skill.path}>
              <span className="codex-extension-icon" aria-hidden="true">
                <Sparkles size={16} />
              </span>
              <div className="codex-extension-main">
                <div className="codex-extension-title">
                  <strong>{skill.displayName ?? skill.name}</strong>
                  <span>{skill.scope}</span>
                </div>
                <p>{skill.shortDescription ?? skill.description}</p>
                <code title={skill.path}>{skill.path}</code>
                {skill.dependencies.length > 0 ? (
                  <div className="codex-extension-tags">
                    {skill.dependencies.map((dependency) => (
                      <span key={`${dependency.type}:${dependency.value}`}>
                        {dependency.type}: {dependency.value}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <NativeToggle
                label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                checked={skill.enabled}
                disabled={Boolean(busyPath)}
                onChange={(enabled) => void setEnabled(skill, enabled)}
              />
            </article>
          ))}
        </div>
      ) : (
        <ExtensionEmpty
          icon={<Sparkles size={21} />}
          title="No Codex skills found"
          detail="Ask Codex to create one under .agents/skills, or add a skill to the Environment Workspace."
        />
      )}
      {inventory?.errors.map((skillError) => (
        <div className="codex-extension-warning" key={`${skillError.path}:${skillError.message}`}>
          <AlertTriangle size={14} aria-hidden="true" />
          <div>
            <strong>Skill could not be loaded</strong>
            <p>{skillError.message}</p>
            <code>{skillError.path}</code>
          </div>
        </div>
      ))}
      <p className="settings-footnote">
        Enablement is written through Codex <code>skills/config/write</code>.
        Sandpi does not copy skill definitions into its database.
      </p>
    </div>
  );
}

interface McpDraft extends CodexMcpServerInput {
  name: string;
  presetId?: string;
  argsText: string;
  enabledToolsText: string;
  disabledToolsText: string;
  authMethod: CodexMcpRemoteAuthMethod;
  initialAuthMethod: CodexMcpRemoteAuthMethod;
  credentialMutation: CodexMcpCredentialMutation;
  hasStoredCredential: boolean;
  secret: string;
  headerName: string;
  valueTemplate: string;
  scopesText: string;
  networkApprovedFor: string;
}

const emptyMcpDraft = (): McpDraft => ({
  name: "",
  transport: "streamable-http",
  command: "",
  args: [],
  argsText: "",
  url: "",
  enabled: true,
  required: false,
  defaultToolsApprovalMode: "prompt",
  enabledTools: [],
  disabledTools: [],
  enabledToolsText: "",
  disabledToolsText: "",
  authMethod: "none",
  initialAuthMethod: "none",
  credentialMutation: "keep",
  hasStoredCredential: false,
  secret: "",
  headerName: "",
  valueTemplate: "",
  scopesText: "",
  networkApprovedFor: "",
});

function mcpDraft(
  server: CodexMcpServer,
  preset?: CodexMcpPreset,
): McpDraft {
  const authMethod = server.authMode ?? mcpAuthMethod(server, preset);
  const hasStoredCredential =
    server.credentialState === "key-configured" ||
    server.authStatus === "bearerToken";
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: server.args,
    argsText: server.args.join("\n"),
    url: server.url ?? "",
    enabled: server.enabled,
    required: server.required,
    startupTimeoutSec: server.startupTimeoutSec,
    toolTimeoutSec: server.toolTimeoutSec,
    defaultToolsApprovalMode: server.defaultToolsApprovalMode,
    enabledTools: server.enabledTools,
    disabledTools: server.disabledTools,
    enabledToolsText: server.enabledTools.join(", "),
    disabledToolsText: server.disabledTools.join(", "),
    presetId: server.presetId ?? preset?.id,
    authMethod,
    initialAuthMethod: authMethod,
    credentialMutation: hasStoredCredential ? "keep" : "replace",
    hasStoredCredential,
    secret: "",
    headerName: preset?.auth.headerName ?? "",
    valueTemplate: preset?.auth.valueTemplate ?? "",
    scopesText:
      server.scopes?.join(", ") ?? preset?.auth.scopes?.join(", ") ?? "",
    networkApprovedFor: server.url ?? "",
  };
}

function mcpPresetDraft(preset: CodexMcpPreset): McpDraft {
  const input = codexMcpInputFromPreset(preset);
  const authMethod =
    preset.auth.requirement === "optional"
      ? "none"
      : (preset.auth.methods[0] ?? "none");
  return {
    ...input,
    name: preset.name,
    presetId: preset.id,
    argsText: input.args.join("\n"),
    enabledToolsText: input.enabledTools.join(", "),
    disabledToolsText: input.disabledTools.join(", "),
    authMethod,
    initialAuthMethod: authMethod,
    credentialMutation:
      authMethod === "bearer" || authMethod === "header" ? "replace" : "keep",
    hasStoredCredential: false,
    secret: "",
    headerName: preset.auth.headerName ?? "",
    valueTemplate: preset.auth.valueTemplate ?? "",
    scopesText: preset.auth.scopes?.join(", ") ?? "",
    networkApprovedFor: "",
  };
}

export function CodexMcpSettings({
  environmentId,
}: CodexEnvironmentSettingsProps) {
  const [inventory, setInventory] = useState<CodexMcpInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyName, setBusyName] = useState("");
  const [removeConfirmName, setRemoveConfirmName] = useState("");
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [editingName, setEditingName] = useState("");
  const [connectionStates, dispatchConnection] = useReducer(
    reduceCodexMcpConnectionStates,
    {},
  );
  const [oauthFlow, setOauthFlow] = useState<CodexMcpOAuthFlow | null>(null);
  const [oauthPopupBlocked, setOauthPopupBlocked] = useState(false);
  const [oauthFlowBusy, setOauthFlowBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedPreset = draft?.presetId
    ? CODEX_MCP_PRESETS.find((preset) => preset.id === draft.presetId)
    : undefined;

  const load = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexMcpInventory>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers`,
      );
      setInventory(response.data);
      dispatchConnection({
        type: "inventory",
        servers: response.data.servers,
      });
      const activeOAuthFlow = response.data.activeOAuthFlow;
      if (
        activeOAuthFlow &&
        !isTerminalCodexMcpOAuthFlow(activeOAuthFlow)
      ) {
        setOauthFlow((current) =>
          mergeCodexMcpOAuthFlow(current, activeOAuthFlow),
        );
        dispatchConnection({
          type: "checking",
          serverName: activeOAuthFlow.serverName,
        });
        setOauthPopupBlocked(false);
      } else {
        setOauthFlow((current) =>
          current && isTerminalCodexMcpOAuthFlow(current) ? current : null,
        );
        setOauthPopupBlocked(false);
      }
    } catch (loadError) {
      setError(errorMessage(loadError, "Could not load Codex MCP servers."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [environmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const testServer = useCallback(
    async (serverName: string) => {
      dispatchConnection({ type: "checking", serverName });
      setError("");
      try {
        await apiFetch<ApiEnvelope<unknown>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(serverName)}/test`,
          { method: "POST" },
        );
        await load();
      } catch (testError) {
        const message = errorMessage(
          testError,
          "Could not connect to the MCP server.",
        );
        dispatchConnection({ type: "failed", serverName, error: message });
        setError(message);
      }
    },
    [environmentId, load],
  );

  useEffect(() => {
    if (
      !oauthFlow ||
      isTerminalCodexMcpOAuthFlow(oauthFlow)
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await apiFetch<ApiEnvelope<CodexMcpOAuthFlow>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-oauth-flows/${encodeURIComponent(oauthFlow.id)}`,
        );
        if (cancelled) return;
        setOauthFlow((current) =>
          mergeCodexMcpOAuthFlow(current, response.data),
        );
        if (response.data.status === "completed") {
          dispatchConnection({
            type: "oauth-completed",
            serverName: response.data.serverName,
          });
          await testServer(response.data.serverName);
        } else if (
          response.data.status === "failed" ||
          response.data.status === "expired" ||
          response.data.status === "cancelled"
        ) {
          const message =
            response.data.error ??
            `OAuth authorization ${response.data.status}.`;
          dispatchConnection({
            type: "failed",
            serverName: response.data.serverName,
            error: message,
          });
          setError(message);
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(
            errorMessage(pollError, "Could not refresh OAuth authorization."),
          );
          setOauthFlow((current) =>
            current?.id === oauthFlow.id ? { ...current } : current,
          );
        }
      }
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [environmentId, oauthFlow, testServer]);

  async function saveServer() {
    if (!draft || busyName) return;
    const name = draft.name.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      setError("Use letters, numbers, hyphens or underscores for the server name.");
      return;
    }
    if (draft.transport === "stdio" && !draft.command?.trim()) {
      setError("A STDIO server requires a command.");
      return;
    }
    if (draft.transport === "streamable-http" && !draft.url?.trim()) {
      setError("A Streamable HTTP server requires a URL.");
      return;
    }
    if (
      draft.transport === "streamable-http" &&
      selectedPreset?.auth.requirement === "required" &&
      draft.authMethod === "none"
    ) {
      setError(`${selectedPreset.title} requires authentication.`);
      return;
    }
    if (
      draft.transport === "streamable-http" &&
      (draft.authMethod === "bearer" || draft.authMethod === "header") &&
      draft.credentialMutation === "replace" &&
      !draft.secret
    ) {
      setError("Enter a new API key or token. Stored credentials are never shown.");
      return;
    }
    if (
      draft.transport === "streamable-http" &&
      draft.authMethod === "header" &&
      draft.credentialMutation === "replace" &&
      !draft.headerName.trim()
    ) {
      setError("A custom API-key credential requires a header name.");
      return;
    }
    if (
      draft.transport === "streamable-http" &&
      draft.networkApprovedFor !== draft.url?.trim()
    ) {
      setError("Review and authorize the remote MCP credential destination.");
      return;
    }
    setBusyName(name);
    setError("");
    let definitionSaved = false;
    try {
      const body: CodexMcpServerInput = {
        transport: draft.transport,
        command: draft.command?.trim() || undefined,
        args: nonEmptyLines(draft.argsText),
        url: draft.url?.trim() || undefined,
        enabled: draft.enabled,
        required: draft.required,
        startupTimeoutSec: optionalPositiveInteger(draft.startupTimeoutSec),
        toolTimeoutSec: optionalPositiveInteger(draft.toolTimeoutSec),
        defaultToolsApprovalMode: draft.defaultToolsApprovalMode,
        scopes: commaSeparatedValues(draft.scopesText),
        enabledTools: commaSeparatedValues(draft.enabledToolsText),
        disabledTools: commaSeparatedValues(draft.disabledToolsText),
      };
      const create = !editingName;
      const response = await apiFetch<ApiEnvelope<CodexMcpInventory>>(
        create
          ? `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers`
          : `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(editingName)}`,
        {
          method: create ? "POST" : "PUT",
          body: JSON.stringify(
            create
              ? {
                  name,
                  presetId: draft.presetId,
                  authMode: draft.authMethod,
                  networkApproved: true,
                  ...body,
                }
              : {
                  presetId: draft.presetId,
                  authMode: draft.authMethod,
                  networkApproved: true,
                  ...body,
                },
          ),
        },
      );
      definitionSaved = true;
      setInventory(response.data);
      dispatchConnection({
        type: "inventory",
        servers: response.data.servers,
      });
      if (
        draft.transport === "streamable-http" &&
        draft.initialAuthMethod === "oauth" &&
        draft.authMethod !== "oauth"
      ) {
        await apiFetch<ApiEnvelope<unknown>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(name)}/oauth/logout`,
          { method: "POST" },
        );
      }
      if (
        draft.transport === "streamable-http" &&
        (draft.authMethod === "bearer" || draft.authMethod === "header") &&
        draft.credentialMutation === "replace"
      ) {
        const credential: CodexMcpCredentialInput = {
          method: draft.authMethod,
          secret: draft.secret,
          headerName:
            draft.authMethod === "header"
              ? draft.headerName.trim() || undefined
              : undefined,
          valueTemplate:
            draft.authMethod === "header"
              ? draft.valueTemplate || undefined
              : undefined,
          presetId: draft.presetId,
        };
        await apiFetch<ApiEnvelope<unknown>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(name)}/credential`,
          {
            method: "PUT",
            body: JSON.stringify(credential),
          },
        );
      } else if (
        draft.transport === "streamable-http" &&
        draft.credentialMutation === "remove"
      ) {
        await apiFetch<ApiEnvelope<unknown>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(name)}/credential`,
          { method: "DELETE" },
        );
      }
      await load();
      setDraft(null);
      setEditingName("");
    } catch (saveError) {
      if (definitionSaved) {
        setEditingName(name);
      }
      setError(
        errorMessage(
          saveError,
          definitionSaved
            ? "The server definition was saved, but its credential could not be updated. Retry to reconcile it."
            : "Could not save the Codex MCP server.",
        ),
      );
    } finally {
      setBusyName("");
    }
  }

  async function setEnabled(server: CodexMcpServer, enabled: boolean) {
    if (busyName || !server.managed) return;
    setBusyName(server.name);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexMcpInventory>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(server.name)}/enabled`,
        { method: "PUT", body: JSON.stringify({ enabled }) },
      );
      setInventory(response.data);
    } catch (updateError) {
      setError(errorMessage(updateError, "Could not update the MCP server."));
    } finally {
      setBusyName("");
    }
  }

  async function startOAuth(server: CodexMcpServer, preset?: CodexMcpPreset) {
    if (busyName || !server.managed) return;
    const popup = openOAuthPopup(server.name);
    setOauthPopupBlocked(!popup);
    setBusyName(server.name);
    setError("");
    dispatchConnection({ type: "checking", serverName: server.name });
    try {
      const login: CodexMcpOAuthLoginInput = {
        presetId: server.presetId ?? preset?.id,
        scopes:
          server.scopes ??
          (preset?.auth.scopes ? [...preset.auth.scopes] : undefined),
      };
      const response = await apiFetch<ApiEnvelope<CodexMcpOAuthFlow>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(server.name)}/oauth/login`,
        {
          method: "POST",
          body: JSON.stringify(login),
        },
      );
      const authorizationUrl = safeCodexMcpOAuthAuthorizationUrl(
        response.data.authorizationUrl,
      );
      if (!authorizationUrl) {
        setOauthFlow(mergeCodexMcpOAuthFlow(null, response.data));
        throw new Error(
          "Codex returned an invalid non-HTTPS OAuth authorization URL.",
        );
      }
      setOauthFlow(
        mergeCodexMcpOAuthFlow(null, {
          ...response.data,
          authorizationUrl,
        }),
      );
      if (popup) {
        popup.location.replace(authorizationUrl);
      }
    } catch (loginError) {
      popup?.close();
      const message = errorMessage(
        loginError,
        "Could not start MCP OAuth authorization.",
      );
      dispatchConnection({
        type: "failed",
        serverName: server.name,
        error: message,
      });
      setError(message);
    } finally {
      setBusyName("");
    }
  }

  async function dismissOAuthFlow() {
    if (!oauthFlow || oauthFlowBusy) return;
    if (isTerminalCodexMcpOAuthFlow(oauthFlow)) {
      setOauthFlow(null);
      setOauthPopupBlocked(false);
      return;
    }
    const flowId = oauthFlow.id;
    setOauthFlowBusy(true);
    setError("");
    try {
      await apiFetch<ApiEnvelope<unknown>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-oauth-flows/${encodeURIComponent(flowId)}`,
        { method: "DELETE" },
      );
      setOauthFlow((current) => (current?.id === flowId ? null : current));
      setOauthPopupBlocked(false);
    } catch (cancelError) {
      setError(
        errorMessage(
          cancelError,
          "Could not stop the MCP OAuth authorization flow.",
        ),
      );
    } finally {
      setOauthFlowBusy(false);
    }
  }

  async function logoutOAuth(server: CodexMcpServer) {
    if (busyName || !server.managed) return;
    setBusyName(server.name);
    setError("");
    dispatchConnection({ type: "checking", serverName: server.name });
    try {
      await apiFetch<ApiEnvelope<unknown>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(server.name)}/oauth/logout`,
        { method: "POST" },
      );
      await load();
    } catch (logoutError) {
      const message = errorMessage(
        logoutError,
        "Could not disconnect the MCP account.",
      );
      dispatchConnection({
        type: "failed",
        serverName: server.name,
        error: message,
      });
      setError(message);
    } finally {
      setBusyName("");
    }
  }

  async function removeServer(server: CodexMcpServer) {
    if (busyName || !server.managed) return;
    setBusyName(server.name);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexMcpInventory>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(server.name)}`,
        { method: "DELETE" },
      );
      setInventory(response.data);
      dispatchConnection({
        type: "inventory",
        servers: response.data.servers,
      });
      setRemoveConfirmName("");
      if (editingName === server.name) {
        setDraft(null);
        setEditingName("");
      }
    } catch (removeError) {
      setError(errorMessage(removeError, "Could not remove the MCP server."));
    } finally {
      setBusyName("");
    }
  }

  return (
    <div className="codex-extension-panel">
      <ExtensionToolbar
        detail="Definitions live in this Environment's native Codex config.toml and are hot-reloaded into loaded Threads."
        actionLabel="Refresh MCP servers"
        busy={refreshing}
        onAction={() => void load()}
      >
        <button
          type="button"
          className="secondary-action-button"
          disabled={Boolean(draft) || Boolean(busyName)}
          onClick={() => {
            setDraft(emptyMcpDraft());
            setEditingName("");
            setRemoveConfirmName("");
          }}
        >
          <Plus size={14} aria-hidden="true" /> Custom server
        </button>
      </ExtensionToolbar>
      {error ? <ExtensionError message={error} /> : null}
      {oauthFlow ? (
        <McpOAuthNotice
          flow={oauthFlow}
          popupBlocked={oauthPopupBlocked}
          busy={oauthFlowBusy}
          onDismiss={() => void dismissOAuthFlow()}
        />
      ) : null}
      {draft ? (
        <McpEditor
          draft={draft}
          preset={selectedPreset}
          editing={Boolean(editingName)}
          busy={Boolean(busyName)}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setEditingName("");
            setError("");
          }}
          onSave={() => void saveServer()}
        />
      ) : (
        <McpCatalog
          configuredNames={
            new Set(inventory?.servers.map((server) => server.name) ?? [])
          }
          disabled={loading || Boolean(busyName)}
          onSelect={(preset) => {
            setDraft(mcpPresetDraft(preset));
            setEditingName("");
            setRemoveConfirmName("");
            setError("");
          }}
        />
      )}
      {loading ? (
        <ExtensionSkeleton rows={2} />
      ) : inventory && inventory.servers.length > 0 ? (
        <div className="codex-extension-list" aria-label="Codex MCP servers">
          {inventory.servers.map((server) => {
            const preset = mcpPresetForServer(server);
            const snapshot = codexMcpConnectionState(server, preset?.auth);
            const override = connectionStates[server.name];
            const connection =
              override?.readiness === "checking" ||
              override?.readiness === "stale" ||
              Boolean(override?.error)
                ? override
                : snapshot;
            const configuredAuthMethod =
              server.authMode ?? mcpAuthMethod(server, preset);
            const supportsOAuth =
              configuredAuthMethod === "oauth";
            const supportsKey =
              configuredAuthMethod === "bearer" ||
              configuredAuthMethod === "header" ||
              (configuredAuthMethod === "none" &&
                preset?.auth.requirement === "optional" &&
                (preset.auth.methods.includes("bearer") ||
                  preset.auth.methods.includes("header")));
            return (
              <article className="codex-mcp-row" key={server.name}>
                <span
                  className={`codex-extension-icon is-${
                    server.transport === "stdio"
                      ? server.runtimeStatus
                      : connection.readiness
                  }`}
                  aria-hidden="true"
                >
                  <Server size={16} />
                </span>
                <div className="codex-extension-main">
                  <div className="codex-extension-title">
                    <strong>{server.serverTitle ?? server.name}</strong>
                    <span>{server.transport}</span>
                    {!server.managed ? <span>project/admin</span> : null}
                  </div>
                  <p className="codex-mcp-endpoint">
                    {server.transport === "stdio"
                      ? [server.command, ...server.args].filter(Boolean).join(" ")
                      : server.url}
                  </p>
                  <div className="codex-extension-tags">
                    <span
                      className={`is-${
                        server.transport === "stdio"
                          ? server.runtimeStatus
                          : connection.readiness
                      }`}
                    >
                      {server.transport === "stdio"
                        ? mcpLocalStatusLabel(server)
                        : mcpReadinessLabel(connection)}
                    </span>
                    {server.transport === "streamable-http" ? (
                      <span
                        className={`is-${connection.credentialState}`}
                        title={
                          connection.anonymousAvailable
                            ? "The server initialized anonymously; connecting an account is optional for current access."
                            : undefined
                        }
                      >
                        {mcpCredentialLabel(connection)}
                      </span>
                    ) : null}
                    {server.toolCount > 0 ? (
                      <span>{server.toolCount} tools</span>
                    ) : null}
                    {server.resourceCount > 0 ? (
                      <span>{server.resourceCount} resources</span>
                    ) : null}
                    {server.required ? <span>required</span> : null}
                    {server.defaultToolsApprovalMode ? (
                      <span>{server.defaultToolsApprovalMode} approval</span>
                    ) : null}
                  </div>
                  {server.transport === "streamable-http" &&
                  connection.error ? (
                    <p className="codex-mcp-inline-error">{connection.error}</p>
                  ) : null}
                </div>
                <div className="codex-extension-actions">
                  {server.managed ? (
                    <>
                      {server.transport === "streamable-http" ? (
                        <>
                          <button
                            type="button"
                            className="codex-mcp-text-action"
                            disabled={Boolean(busyName) || Boolean(draft)}
                            onClick={() => void testServer(server.name)}
                          >
                            Test
                          </button>
                          {supportsOAuth ? (
                            connection.credentialState ===
                            "oauth-authorized" ? (
                              <button
                                type="button"
                                aria-label={`Disconnect ${server.name} OAuth`}
                                title={`Disconnect ${server.name} OAuth`}
                                disabled={Boolean(busyName) || Boolean(draft)}
                                onClick={() => void logoutOAuth(server)}
                              >
                                <LogOut size={13} aria-hidden="true" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="codex-mcp-text-action"
                                disabled={Boolean(busyName) || Boolean(draft)}
                                onClick={() => void startOAuth(server, preset)}
                              >
                                Connect
                              </button>
                            )
                          ) : null}
                          {supportsKey ? (
                            <button
                              type="button"
                              aria-label={`${connection.credentialState === "key-configured" ? "Manage" : "Add"} ${server.name} credential`}
                              title={`${connection.credentialState === "key-configured" ? "Manage" : "Add"} credential`}
                              disabled={Boolean(busyName) || Boolean(draft)}
                              onClick={() => {
                                const next = mcpDraft(server, preset);
                                setDraft({
                                  ...next,
                                  authMethod:
                                    next.authMethod === "none"
                                      ? (preset?.auth.methods.find(
                                          (method) =>
                                            method === "bearer" ||
                                            method === "header",
                                        ) ?? "header")
                                      : next.authMethod,
                                  credentialMutation:
                                    connection.credentialState ===
                                    "key-configured"
                                      ? "keep"
                                      : "replace",
                                });
                                setEditingName(server.name);
                                setRemoveConfirmName("");
                              }}
                            >
                              <KeyRound size={13} aria-hidden="true" />
                            </button>
                          ) : null}
                        </>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Edit ${server.name}`}
                        title={`Edit ${server.name}`}
                        disabled={Boolean(busyName) || Boolean(draft)}
                        onClick={() => {
                          setDraft(mcpDraft(server, preset));
                          setEditingName(server.name);
                          setRemoveConfirmName("");
                        }}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                      {removeConfirmName === server.name ? (
                        <div className="codex-mcp-remove-confirm">
                          <button
                            type="button"
                            className="is-destructive"
                            disabled={Boolean(busyName)}
                            onClick={() => void removeServer(server)}
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            aria-label="Cancel removal"
                            onClick={() => setRemoveConfirmName("")}
                          >
                            <X size={13} aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-label={`Remove ${server.name}`}
                          title={`Remove ${server.name}`}
                          disabled={Boolean(busyName) || Boolean(draft)}
                          onClick={() => setRemoveConfirmName(server.name)}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                      <NativeToggle
                        label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                        checked={server.enabled}
                        disabled={Boolean(busyName) || Boolean(draft)}
                        onChange={(enabled) => void setEnabled(server, enabled)}
                      />
                    </>
                  ) : (
                    <span className="codex-readonly-badge">Read only</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <ExtensionEmpty
          icon={<Server size={21} />}
          title="No MCP servers configured"
          detail="Add a STDIO process or Streamable HTTP endpoint for every Codex Session in this Environment."
        />
      )}
      <p className="settings-footnote">
        Server definitions remain in Codex&apos;s native config. Remote API keys
        are write-only and injected at the sandbox egress boundary; OAuth uses
        Codex&apos;s native authorization and token refresh flow.
      </p>
    </div>
  );
}

function McpCatalog({
  configuredNames,
  disabled,
  onSelect,
}: {
  configuredNames: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (preset: CodexMcpPreset) => void;
}) {
  return (
    <div className="codex-mcp-catalog" aria-label="MCP server catalog">
      <header>
        <div>
          <strong>Quick add</strong>
          <p>
            Choose a preset to review its native Codex definition before saving.
          </p>
        </div>
        <span>{CODEX_MCP_PRESETS.length} presets</span>
      </header>
      {CODEX_MCP_PRESET_CATEGORIES.map((category) => {
        const presets = CODEX_MCP_PRESETS.filter(
          (preset) => preset.category === category.id,
        );
        return (
          <section
            className="codex-mcp-catalog-group"
            aria-labelledby={`codex-mcp-category-${category.id}`}
            key={category.id}
          >
            <div className="codex-mcp-catalog-heading">
              <div>
                <strong id={`codex-mcp-category-${category.id}`}>
                  {category.label}
                </strong>
                <p>{category.description}</p>
              </div>
              <span>{presets.length}</span>
            </div>
            <div className="codex-mcp-preset-grid">
              {presets.map((preset) => {
                const configured = configuredNames.has(preset.name);
                return (
                  <article className="codex-mcp-preset-card" key={preset.id}>
                    <header>
                      <span aria-hidden="true">
                        <Server size={15} />
                      </span>
                      <div>
                        <strong>{preset.title}</strong>
                        <span>
                          {preset.transport === "stdio"
                            ? "Local STDIO"
                            : "Streamable HTTP"}
                        </span>
                      </div>
                    </header>
                    <p>{preset.description}</p>
                    <code title={mcpPresetEndpoint(preset)}>
                      {mcpPresetEndpoint(preset)}
                    </code>
                    <footer>
                      <span>{preset.connectionLabel}</span>
                      <div>
                        <a
                          href={preset.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${preset.title} setup guide`}
                          title={`Open ${preset.title} setup guide`}
                        >
                          <ExternalLink size={12} aria-hidden="true" />
                        </a>
                        <button
                          type="button"
                          disabled={disabled || configured}
                          aria-label={
                            configured
                              ? `${preset.title} is configured`
                              : `Configure ${preset.title}`
                          }
                          onClick={() => onSelect(preset)}
                        >
                          {configured ? "Configured" : "Configure"}
                        </button>
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function McpEditor({
  draft,
  preset,
  editing,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: McpDraft;
  preset?: CodexMcpPreset;
  editing: boolean;
  busy: boolean;
  onChange: (draft: McpDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const update = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) =>
    onChange({ ...draft, [key]: value });

  useEffect(() => {
    editorRef.current?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div className="codex-mcp-editor" ref={editorRef}>
      <header>
        <div>
          <span>{editing ? "Codex MCP server" : "New Codex MCP server"}</span>
          <strong>
            {editing
              ? draft.name
              : preset?.title ?? "Configure a native server"}
          </strong>
        </div>
        <button type="button" aria-label="Close MCP editor" onClick={onCancel}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>
      {preset ? (
        <div className="codex-mcp-preset-note">
          <p>{preset.setupHint}</p>
          <a href={preset.docsUrl} target="_blank" rel="noreferrer">
            Setup guide <ExternalLink size={11} aria-hidden="true" />
          </a>
        </div>
      ) : null}
      <div className="field-grid two-columns">
        <label>
          Name
          <input
            autoComplete="off"
            spellCheck={false}
            disabled={editing}
            value={draft.name}
            placeholder="context7"
            onChange={(event) => update("name", event.target.value)}
          />
        </label>
        <label>
          Transport
          <select
            disabled={editing}
            value={draft.transport}
            onChange={(event) =>
              update("transport", event.target.value as CodexMcpTransport)
            }
          >
            <option value="streamable-http">Streamable HTTP</option>
            <option value="stdio">STDIO</option>
          </select>
        </label>
      </div>
      {draft.transport === "streamable-http" ? (
        <>
          <label className="full-field">
            Server URL
            <input
              autoComplete="off"
              spellCheck={false}
              value={draft.url}
              placeholder="https://example.com/mcp"
              onChange={(event) => update("url", event.target.value)}
            />
          </label>
          <McpRemoteAuthEditor
            draft={draft}
            preset={preset}
            onChange={onChange}
          />
        </>
      ) : (
        <>
          <label className="full-field">
            Command
            <input
              autoComplete="off"
              spellCheck={false}
              value={draft.command}
              placeholder="npx"
              onChange={(event) => update("command", event.target.value)}
            />
          </label>
          <label className="full-field">
            Arguments <small>One argument per line</small>
            <textarea
              value={draft.argsText}
              placeholder={"-y\n@upstash/context7-mcp"}
              onChange={(event) => update("argsText", event.target.value)}
            />
          </label>
        </>
      )}
      <div className="codex-mcp-switches">
        <div>
          <span>
            <strong>Enabled</strong>
            <small>Load this server for Codex Threads.</small>
          </span>
          <NativeToggle
            label="MCP server enabled"
            checked={draft.enabled}
            onChange={(value) => update("enabled", value)}
          />
        </div>
        <div>
          <span>
            <strong>Required</strong>
            <small>Fail Thread startup when initialization fails.</small>
          </span>
          <NativeToggle
            label="MCP server required"
            checked={draft.required}
            onChange={(value) => update("required", value)}
          />
        </div>
      </div>
      <details className="codex-mcp-advanced">
        <summary>Tool policy and timeouts</summary>
        <div className="field-grid two-columns">
          <label>
            Default approval
            <select
              value={draft.defaultToolsApprovalMode ?? ""}
              onChange={(event) =>
                update(
                  "defaultToolsApprovalMode",
                  (event.target.value || undefined) as
                    | CodexMcpApprovalMode
                    | undefined,
                )
              }
            >
              <option value="">Codex default</option>
              <option value="auto">Auto</option>
              <option value="prompt">Prompt</option>
              <option value="writes">Prompt for writes</option>
              <option value="approve">Approve</option>
            </select>
          </label>
          <label>
            Startup timeout (seconds)
            <input
              type="number"
              min={1}
              max={300}
              value={draft.startupTimeoutSec ?? ""}
              onChange={(event) =>
                update(
                  "startupTimeoutSec",
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
            />
          </label>
          <label>
            Tool timeout (seconds)
            <input
              type="number"
              min={1}
              max={3600}
              value={draft.toolTimeoutSec ?? ""}
              onChange={(event) =>
                update(
                  "toolTimeoutSec",
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
            />
          </label>
          <label>
            Enabled tools
            <input
              autoComplete="off"
              spellCheck={false}
              value={draft.enabledToolsText}
              placeholder="read, search"
              onChange={(event) => update("enabledToolsText", event.target.value)}
            />
          </label>
        </div>
        <label className="full-field">
          Disabled tools
          <input
            autoComplete="off"
            spellCheck={false}
            value={draft.disabledToolsText}
            placeholder="delete, publish"
            onChange={(event) => update("disabledToolsText", event.target.value)}
          />
        </label>
      </details>
      <footer>
        <button type="button" className="button-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-primary" disabled={busy} onClick={onSave}>
          {busy
            ? "Saving…"
            : editing
              ? "Save server"
              : draft.authMethod === "oauth"
                ? "Add, then connect"
                : "Add server"}
        </button>
      </footer>
    </div>
  );
}

function McpRemoteAuthEditor({
  draft,
  preset,
  onChange,
}: {
  draft: McpDraft;
  preset?: CodexMcpPreset;
  onChange: (draft: McpDraft) => void;
}) {
  const allowedMethods: readonly CodexMcpRemoteAuthMethod[] = preset
    ? [
        ...(preset.auth.requirement === "optional" ||
        preset.auth.requirement === "none"
          ? (["none"] as const)
          : []),
        ...preset.auth.methods,
      ]
    : ["none", "oauth", "bearer", "header"];
  const usesStaticCredential =
    draft.authMethod === "bearer" || draft.authMethod === "header";
  const showSecret =
    usesStaticCredential && draft.credentialMutation === "replace";
  const networkDestination =
    preset?.network.endpointDomains.join(", ") ??
    mcpUrlHostname(draft.url ?? "") ??
    "the configured host";
  const networkApproved =
    Boolean(draft.url?.trim()) &&
    draft.networkApprovedFor === draft.url?.trim();

  function setAuthMethod(authMethod: CodexMcpRemoteAuthMethod) {
    const usesNextStatic = authMethod === "bearer" || authMethod === "header";
    onChange({
      ...draft,
      authMethod,
      credentialMutation: usesNextStatic
        ? draft.hasStoredCredential
          ? "keep"
          : "replace"
        : draft.hasStoredCredential
          ? "remove"
          : "keep",
      secret: "",
      headerName:
        authMethod === "header"
          ? draft.headerName || preset?.auth.headerName || ""
          : (preset?.auth.headerName ?? draft.headerName),
      valueTemplate:
        preset?.auth.valueTemplate ??
        (authMethod === "bearer" ? "Bearer {{ .token }}" : "{{ .token }}"),
    });
  }

  return (
    <section className="codex-mcp-auth-editor" aria-label="Remote authentication">
      <header>
        <div>
          <strong>Authentication</strong>
          <p>
            Secrets are write-only. Sandpi never reads an existing value back
            into this form.
          </p>
        </div>
        {preset ? (
          <span>{authRequirementLabel(preset.auth.requirement)}</span>
        ) : null}
      </header>
      <label className="full-field">
        Method
        <select
          value={draft.authMethod}
          onChange={(event) =>
            setAuthMethod(event.target.value as CodexMcpRemoteAuthMethod)
          }
        >
          {allowedMethods.map((method) => (
            <option value={method} key={method}>
              {mcpAuthMethodLabel(method)}
            </option>
          ))}
        </select>
      </label>
      {draft.authMethod === "none" ? (
        <p className="codex-mcp-auth-note">
          Connect without credentials. Public or rate-limited server access may
          still be available.
        </p>
      ) : null}
      {draft.authMethod === "oauth" ? (
        <>
          <div className="codex-mcp-auth-note is-oauth">
            <Link2 size={14} aria-hidden="true" />
            <span>
              Save this definition, then choose <strong>Connect</strong>. Codex
              performs OAuth and Sandpi checks server readiness after the
              callback completes.
            </span>
          </div>
          <label className="full-field">
            OAuth scopes <small>Optional, comma separated</small>
            <input
              autoComplete="off"
              spellCheck={false}
              value={draft.scopesText}
              placeholder="read, write"
              onChange={(event) =>
                onChange({ ...draft, scopesText: event.target.value })
              }
            />
          </label>
        </>
      ) : null}
      {usesStaticCredential ? (
        <>
          {draft.hasStoredCredential ? (
            <label className="full-field">
              Stored credential
              <select
                value={draft.credentialMutation}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    credentialMutation: event.target
                      .value as CodexMcpCredentialMutation,
                    secret: "",
                  })
                }
              >
                <option value="keep">Keep existing value</option>
                <option value="replace">Replace with a new value</option>
                <option value="remove">Remove stored value</option>
              </select>
            </label>
          ) : null}
          {showSecret ? (
            <label className="full-field">
              {draft.authMethod === "bearer" ? "Token" : "API key"}
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={draft.secret}
                placeholder="Enter a new value"
                onChange={(event) =>
                  onChange({ ...draft, secret: event.target.value })
                }
              />
              <small>
                The value is sent once to the credential endpoint and is never
                returned by the API.
              </small>
            </label>
          ) : null}
          {draft.authMethod === "header" ? (
            <div className="field-grid two-columns">
              <label>
                Header name
                <input
                  autoComplete="off"
                  spellCheck={false}
                  disabled={Boolean(preset?.auth.headerName)}
                  value={draft.headerName}
                  placeholder="X-API-Key"
                  onChange={(event) =>
                    onChange({ ...draft, headerName: event.target.value })
                  }
                />
              </label>
              <label>
                Value template
                <input
                  autoComplete="off"
                  spellCheck={false}
                  disabled={Boolean(preset?.auth.valueTemplate)}
                  value={draft.valueTemplate}
                  placeholder="{{ .token }}"
                  onChange={(event) =>
                    onChange({ ...draft, valueTemplate: event.target.value })
                  }
                />
              </label>
            </div>
          ) : null}
          {draft.credentialMutation === "remove" ? (
            <p className="codex-mcp-auth-note is-warning">
              Saving removes the egress credential binding. The server
              definition remains configured.
            </p>
          ) : null}
        </>
      ) : null}
      <label className="codex-mcp-network-consent">
        <input
          type="checkbox"
          checked={networkApproved}
          onChange={(event) =>
            onChange({
              ...draft,
              networkApprovedFor: event.target.checked
                ? (draft.url?.trim() ?? "")
                : "",
            })
          }
        />
        <span>
          <strong>Authorize credentials for this MCP destination</strong>
          <small>
            Bind credentials only to <code>{networkDestination}</code>.
            Block-all Environments must still allow this domain in Network
            policy. Changing the server URL requires another review.
          </small>
        </span>
      </label>
    </section>
  );
}

function McpOAuthNotice({
  flow,
  popupBlocked,
  busy,
  onDismiss,
}: {
  flow: CodexMcpOAuthFlow;
  popupBlocked: boolean;
  busy: boolean;
  onDismiss: () => void;
}) {
  const terminal = isTerminalCodexMcpOAuthFlow(flow);
  const authorizationUrl = safeCodexMcpOAuthAuthorizationUrl(
    flow.authorizationUrl,
  );
  return (
    <div
      className={`codex-mcp-oauth-notice is-${flow.status}`}
      role={flow.status === "failed" ? "alert" : "status"}
    >
      <Link2 size={15} aria-hidden="true" />
      <div>
        <strong>
          {flow.status === "completed"
            ? "Authorization completed; checking server"
            : flow.status === "failed"
              ? "Authorization failed"
              : flow.status === "expired"
                ? "Authorization expired"
                : flow.status === "cancelled"
                  ? "Authorization stopped"
                  : `Waiting for ${flow.serverName} authorization`}
        </strong>
        <p>
          {flow.error ??
            (popupBlocked
              ? "The authorization popup was blocked. Open the link below to continue."
              : terminal
                ? "The account state will be confirmed from a fresh MCP connection."
                : "Finish in the provider window. You can keep this settings page open.")}
        </p>
        {authorizationUrl && !terminal ? (
          <a href={authorizationUrl} target="_blank" rel="noreferrer">
            Open authorization link{" "}
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={terminal ? "Dismiss OAuth status" : "Stop waiting for OAuth"}
        title={terminal ? "Dismiss" : busy ? "Stopping…" : "Stop waiting"}
        disabled={busy}
        onClick={onDismiss}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function mcpPresetEndpoint(preset: CodexMcpPreset) {
  if (preset.transport === "stdio") {
    return [preset.command, ...(preset.args ?? [])].filter(Boolean).join(" ");
  }
  return preset.url;
}

function ExtensionToolbar({
  detail,
  actionLabel,
  busy,
  onAction,
  children,
}: {
  detail: string;
  actionLabel: string;
  busy: boolean;
  onAction: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="codex-extension-toolbar">
      <p>{detail}</p>
      <div>
        {children}
        <button
          type="button"
          className="icon-button"
          aria-label={actionLabel}
          title={actionLabel}
          disabled={busy}
          onClick={onAction}
        >
          <RefreshCw size={15} className={busy ? "is-spinning" : ""} />
        </button>
      </div>
    </div>
  );
}

function ExtensionError({ message }: { message: string }) {
  return (
    <div className="codex-extension-error" role="alert">
      <AlertTriangle size={15} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function ExtensionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="codex-extension-list is-loading" aria-label="Loading Codex extensions">
      {Array.from({ length: rows }, (_, index) => (
        <div className="codex-extension-skeleton" key={index}>
          <span />
          <div>
            <span />
            <span />
          </div>
        </div>
      ))}
    </div>
  );
}

function ExtensionEmpty({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="codex-extension-empty">
      <span aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function mcpPresetForServer(server: CodexMcpServer) {
  return CODEX_MCP_PRESETS.find(
    (preset) =>
      preset.id === server.presetId ||
      (preset.name === server.name &&
        preset.transport === server.transport &&
        (preset.transport === "stdio"
          ? preset.command === server.command
          : preset.url === server.url)),
  );
}

function mcpAuthMethod(
  server: CodexMcpServer,
  preset?: CodexMcpPreset,
): CodexMcpRemoteAuthMethod {
  if (server.transport === "stdio") return "none";
  if (
    server.credentialState === "key-configured" ||
    server.credentialState === "key-missing" ||
    server.authStatus === "bearerToken"
  ) {
    return (
      preset?.auth.methods.find(
        (method) => method === "bearer" || method === "header",
      ) ?? "bearer"
    );
  }
  if (
    server.credentialState === "oauth-authorized" ||
    server.credentialState === "oauth-required" ||
    server.credentialState === "reauth-required" ||
    server.authStatus === "oAuth" ||
    server.authStatus === "notLoggedIn"
  ) {
    if (!preset || preset.auth.methods.includes("oauth")) return "oauth";
    return preset.auth.methods[0] ?? "none";
  }
  return preset?.auth.requirement === "required"
    ? (preset.auth.methods[0] ?? "none")
    : "none";
}

function mcpReadinessLabel(state: CodexMcpConnectionState) {
  if (state.readiness === "ready") return "Ready";
  if (state.readiness === "checking") return "Checking…";
  if (state.readiness === "failed") return "Connection failed";
  if (state.readiness === "disabled") return "Disabled";
  if (state.readiness === "stale") return "Status stale";
  return "Not checked";
}

function mcpLocalStatusLabel(server: CodexMcpServer) {
  if (server.runtimeStatus === "connected") return "Connected";
  if (server.runtimeStatus === "authentication-required") {
    return "Sign-in required";
  }
  if (server.runtimeStatus === "disabled") return "Disabled";
  return "Unavailable";
}

function mcpCredentialLabel(state: CodexMcpConnectionState) {
  if (state.anonymousAvailable) {
    if (state.credentialState === "key-missing") return "API key optional";
    return "Sign-in optional";
  }
  if (state.credentialState === "public") return "Public";
  if (state.credentialState === "key-missing") return "API key required";
  if (state.credentialState === "key-configured") return "API key configured";
  if (state.credentialState === "oauth-required") return "Sign-in required";
  if (state.credentialState === "oauth-authorized") return "OAuth connected";
  if (state.credentialState === "reauth-required") return "Reconnect required";
  return "Auth unknown";
}

function mcpAuthMethodLabel(method: CodexMcpRemoteAuthMethod) {
  if (method === "oauth") return "OAuth";
  if (method === "bearer") return "Bearer token";
  if (method === "header") return "API key header";
  return "No authentication";
}

function authRequirementLabel(
  requirement: CodexMcpPreset["auth"]["requirement"],
) {
  if (requirement === "required") return "Required";
  if (requirement === "optional") return "Optional";
  return "No auth";
}

function mcpUrlHostname(value: string) {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}

function openOAuthPopup(serverName: string) {
  try {
    const popup = window.open(
      "about:blank",
      `sandpi-mcp-oauth-${serverName}`,
      "popup,width=620,height=760",
    );
    if (popup) {
      popup.opener = null;
      popup.document.title = "Waiting for MCP authorization";
      popup.document.body.textContent =
        "Sandpi is preparing the authorization request…";
    }
    return popup;
  } catch {
    return null;
  }
}

function nonEmptyLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function commaSeparatedValues(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function optionalPositiveInteger(value: number | undefined) {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
