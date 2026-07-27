"use client";

import {
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  Server,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  CodexEnvironmentSkill,
  CodexMcpInventory,
  CodexMcpOAuthLogin,
  CodexMcpServer,
  CodexSkillsInventory,
} from "@/harnesses/codex/environment-tools";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";

interface CodexEnvironmentSettingsProps {
  environmentId: string;
  verbose?: boolean;
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
  verbose = false,
}: CodexEnvironmentSettingsProps) {
  const [inventory, setInventory] = useState<CodexMcpInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyName, setBusyName] = useState("");
  const [login, setLogin] = useState<CodexMcpOAuthLogin | null>(null);
  const [error, setError] = useState("");

  const fetchInventory = useCallback(
    () =>
      apiFetch<ApiEnvelope<CodexMcpInventory>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers${verbose ? "?detail=full" : ""}`,
      ),
    [environmentId, verbose],
  );

  const load = useCallback(
    async (force = false) => {
      if (force) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError("");
      try {
        const response = await fetchInventory();
        setInventory(response.data);
      } catch (loadError) {
        setError(errorMessage(loadError, "Could not load Codex MCP servers."));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [fetchInventory],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let timer: number | undefined;

    const poll = async () => {
      if (Date.now() >= login.expiresAt * 1_000) {
        setLogin(null);
        setError(
          `Sign-in for ${login.name} expired. Start a new connection attempt.`,
        );
        return;
      }
      try {
        const response = await fetchInventory();
        if (stopped) return;
        setInventory(response.data);
        const server = response.data.servers.find(
          (candidate) => candidate.name === login.name,
        );
        if (server?.runtimeStatus === "connected") {
          setLogin(null);
          setError("");
          return;
        }
        if (!server || !server.enabled) {
          setLogin(null);
          setError(
            `${login.name} is no longer enabled in the Codex MCP configuration.`,
          );
          return;
        }
      } catch {
        // The native login remains authoritative. A transient status read can
        // retry until the bounded OAuth attempt expires.
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 1_000);
    };

    timer = window.setTimeout(() => void poll(), 750);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [fetchInventory, login]);

  async function setEnabled(server: CodexMcpServer, enabled: boolean) {
    if (busyName || login || !server.managed) return;
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

  async function startOAuthLogin(server: CodexMcpServer) {
    if (
      busyName ||
      login ||
      server.runtimeStatus !== "authentication-required"
    ) {
      return;
    }
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      popup.document.title = `Connect ${server.name}`;
      popup.document.body.textContent = "Preparing secure sign-in…";
    }
    setBusyName(server.name);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexMcpOAuthLogin>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/mcp-servers/${encodeURIComponent(server.name)}/oauth/login`,
        { method: "POST" },
      );
      setLogin(response.data);
      if (popup && !popup.closed) {
        popup.location.replace(response.data.authorizationUrl);
      }
    } catch (loginError) {
      popup?.close();
      setError(
        errorMessage(loginError, "Could not start Codex MCP sign-in."),
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
                    {login?.name === server.name
                      ? "Waiting for sign-in"
                      : mcpStatusLabel(server)}
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
                {verbose ? (
                  <div className="codex-mcp-verbose">
                    <McpCapabilityList
                      label="Auth"
                      values={[server.authStatus ?? "unknown"]}
                    />
                    <McpCapabilityList
                      label="Tools"
                      values={server.tools}
                    />
                    <McpCapabilityList
                      label="Resources"
                      values={server.resources.map(
                        (resource) => {
                          const label = resource.title ?? resource.name;
                          return `${label} (${resource.uri})`;
                        },
                      )}
                    />
                    <McpCapabilityList
                      label="Resource templates"
                      values={server.resourceTemplates.map(
                        (resource) => {
                          const label = resource.title ?? resource.name;
                          return `${label} (${resource.uriTemplate})`;
                        },
                      )}
                    />
                  </div>
                ) : null}
                {login?.name === server.name ? (
                  <a
                    className="codex-mcp-auth-link"
                    href={login.authorizationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Continue sign-in
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : null}
              </div>
              <div className="codex-mcp-actions">
                {server.runtimeStatus === "authentication-required" ? (
                  <button
                    type="button"
                    className="secondary-action-button"
                    aria-label={`Connect ${server.name}`}
                    disabled={Boolean(busyName || login)}
                    onClick={() => void startOAuthLogin(server)}
                  >
                    {login?.name === server.name ? "Waiting…" : "Connect"}
                  </button>
                ) : null}
                {server.managed ? (
                  <NativeToggle
                    label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                    checked={server.enabled}
                    disabled={Boolean(busyName || login)}
                    onChange={(enabled) => void setEnabled(server, enabled)}
                  />
                ) : (
                  <span className="codex-extension-read-only">Read only</span>
                )}
              </div>
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
        servers, starts native OAuth, and writes native enablement for user-level
        definitions.
      </p>
    </div>
  );
}

function McpCapabilityList({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  if (!values.length) return null;
  return (
    <section>
      <strong>{label}</strong>
      <div>
        {values.map((value) => (
          <code key={value}>{value}</code>
        ))}
      </div>
    </section>
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
