"use client";

import { AlertTriangle, RefreshCw, Server, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  CodexEnvironmentSkill,
  CodexMcpInventory,
  CodexMcpServer,
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
        <div
          className="codex-extension-warning"
          key={`${skillError.path}:${skillError.message}`}
        >
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

export function CodexMcpSettings({
  environmentId,
}: CodexEnvironmentSettingsProps) {
  const [inventory, setInventory] = useState<CodexMcpInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyName, setBusyName] = useState("");
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
    },
    [environmentId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function setEnabled(server: CodexMcpServer, enabled: boolean) {
    if (busyName || !server.managed) return;
    setBusyName(server.name);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexMcpInventory>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(server.name)}/enabled`,
        {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        },
      );
      setInventory(response.data);
    } catch (updateError) {
      setError(
        errorMessage(updateError, "Could not update the Codex MCP server."),
      );
    } finally {
      setBusyName("");
    }
  }

  return (
    <div className="codex-extension-panel">
      <ExtensionToolbar
        detail="Discovered from Codex native user, project and admin configuration."
        actionLabel="Refresh MCP servers"
        busy={refreshing}
        onAction={() => void load(true)}
      />
      {error ? <ExtensionError message={error} /> : null}
      {loading ? (
        <ExtensionSkeleton rows={3} />
      ) : inventory && inventory.servers.length > 0 ? (
        <div className="codex-extension-list" aria-label="Codex MCP servers">
          {inventory.servers.map((server) => (
            <article className="codex-mcp-row" key={server.name}>
              <span className="codex-extension-icon" aria-hidden="true">
                <Server size={16} />
              </span>
              <div className="codex-extension-main">
                <div className="codex-extension-title">
                  <strong>{server.serverTitle ?? server.name}</strong>
                  <span>{server.transport}</span>
                  <span className={`codex-mcp-status is-${server.runtimeStatus}`}>
                    {mcpStatusLabel(server)}
                  </span>
                </div>
                {server.serverTitle && server.serverTitle !== server.name ? (
                  <p>{server.name}</p>
                ) : null}
                <code className="codex-mcp-endpoint" title={mcpEndpoint(server)}>
                  {mcpEndpoint(server)}
                </code>
                {server.toolCount > 0 || server.resourceCount > 0 ? (
                  <div className="codex-extension-tags">
                    <span>{server.toolCount} tools</span>
                    <span>{server.resourceCount} resources</span>
                  </div>
                ) : null}
              </div>
              {server.managed ? (
                <NativeToggle
                  label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                  checked={server.enabled}
                  disabled={Boolean(busyName)}
                  onChange={(enabled) => void setEnabled(server, enabled)}
                />
              ) : (
                <span className="codex-extension-read-only">Read only</span>
              )}
            </article>
          ))}
        </div>
      ) : (
        <ExtensionEmpty
          icon={<Server size={21} />}
          title="No Codex MCP servers found"
          detail="Add a server to Codex config.toml in the Environment or project Workspace, then refresh."
        />
      )}
      <p className="settings-footnote">
        Codex configuration is the source of truth. Sandpi only discovers
        servers and writes native enablement for user-level definitions.
      </p>
    </div>
  );
}

function ExtensionToolbar({
  detail,
  actionLabel,
  busy,
  onAction,
}: {
  detail: string;
  actionLabel: string;
  busy: boolean;
  onAction: () => void;
}) {
  return (
    <div className="codex-extension-toolbar">
      <p>{detail}</p>
      <button
        type="button"
        className="icon-button"
        aria-label={actionLabel}
        title={actionLabel}
        disabled={busy}
        onClick={onAction}
      >
        <RefreshCw size={15} className={busy ? "is-spinning" : undefined} />
      </button>
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
    <div className="codex-extension-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="codex-extension-skeleton" key={index}>
          <span />
          <span />
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

function mcpEndpoint(server: CodexMcpServer) {
  if (server.url) return server.url;
  return [server.command, ...server.args].filter(Boolean).join(" ");
}

function mcpStatusLabel(server: CodexMcpServer) {
  if (server.runtimeStatus === "connected") return "Connected";
  if (server.runtimeStatus === "authentication-required") {
    return "Sign-in required";
  }
  if (server.runtimeStatus === "disabled") return "Disabled";
  return "Unavailable";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
