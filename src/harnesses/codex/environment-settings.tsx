"use client";

import {
  AlertTriangle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  CodexEnvironmentSkill,
  CodexMcpApprovalMode,
  CodexMcpInventory,
  CodexMcpServer,
  CodexMcpServerInput,
  CodexMcpTransport,
  CodexSkillsInventory,
} from "@/harnesses/codex/environment-tools";
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
  argsText: string;
  enabledToolsText: string;
  disabledToolsText: string;
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
});

function mcpDraft(server: CodexMcpServer): McpDraft {
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
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexMcpInventory>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers`,
      );
      setInventory(response.data);
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
    setBusyName(name);
    setError("");
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
          body: JSON.stringify(create ? { name, ...body } : body),
        },
      );
      setInventory(response.data);
      setDraft(null);
      setEditingName("");
    } catch (saveError) {
      setError(errorMessage(saveError, "Could not save the Codex MCP server."));
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
          <Plus size={14} aria-hidden="true" /> Add server
        </button>
      </ExtensionToolbar>
      {error ? <ExtensionError message={error} /> : null}
      {draft ? (
        <McpEditor
          draft={draft}
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
      ) : null}
      {loading ? (
        <ExtensionSkeleton rows={2} />
      ) : inventory && inventory.servers.length > 0 ? (
        <div className="codex-extension-list" aria-label="Codex MCP servers">
          {inventory.servers.map((server) => (
            <article className="codex-mcp-row" key={server.name}>
              <span
                className={`codex-extension-icon is-${server.runtimeStatus}`}
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
                  <span className={`is-${server.runtimeStatus}`}>
                    {mcpStatusLabel(server)}
                  </span>
                  {server.toolCount > 0 ? <span>{server.toolCount} tools</span> : null}
                  {server.resourceCount > 0 ? (
                    <span>{server.resourceCount} resources</span>
                  ) : null}
                  {server.required ? <span>required</span> : null}
                  {server.defaultToolsApprovalMode ? (
                    <span>{server.defaultToolsApprovalMode} approval</span>
                  ) : null}
                </div>
              </div>
              <div className="codex-extension-actions">
                {server.managed ? (
                  <>
                    <button
                      type="button"
                      aria-label={`Edit ${server.name}`}
                      title={`Edit ${server.name}`}
                      disabled={Boolean(busyName) || Boolean(draft)}
                      onClick={() => {
                        setDraft(mcpDraft(server));
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
          ))}
        </div>
      ) : (
        <ExtensionEmpty
          icon={<Server size={21} />}
          title="No MCP servers configured"
          detail="Add a STDIO process or Streamable HTTP endpoint for every Codex Session in this Environment."
        />
      )}
      <p className="settings-footnote">
        Sandpi exposes Codex&apos;s native MCP configuration and runtime status.
        OAuth callback brokering for a remote app-server is intentionally not
        emulated by a generic Sandpi credential flow.
      </p>
    </div>
  );
}

function McpEditor({
  draft,
  editing,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: McpDraft;
  editing: boolean;
  busy: boolean;
  onChange: (draft: McpDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const update = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <div className="codex-mcp-editor">
      <header>
        <div>
          <span>{editing ? "Codex MCP server" : "New Codex MCP server"}</span>
          <strong>{editing ? draft.name : "Configure a native server"}</strong>
        </div>
        <button type="button" aria-label="Close MCP editor" onClick={onCancel}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>
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
          {busy ? "Saving…" : editing ? "Save server" : "Add server"}
        </button>
      </footer>
    </div>
  );
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

function mcpStatusLabel(server: CodexMcpServer) {
  if (server.runtimeStatus === "connected") return "Connected";
  if (server.runtimeStatus === "authentication-required") return "Sign-in required";
  if (server.runtimeStatus === "disabled") return "Disabled";
  return "Unavailable";
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
