"use client";

import {
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  GitBranch,
  Globe2,
  KeyRound,
  LockKeyhole,
  Network,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Share2,
  TerminalSquare,
  Webhook,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { Environment, Sandbox0ConnectionSummary } from "@/lib/types";

type SettingsTab =
  | "general"
  | "initialization"
  | "credentials"
  | "network"
  | "functions"
  | "sharing";

interface EnvironmentSettingsProps {
  environment: Environment;
  sandbox0Connection?: Sandbox0ConnectionSummary;
  onChange: (environment: Environment) => void;
  onClose: () => void;
}

const tabs: Array<{
  id: SettingsTab;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "initialization", label: "Initialization", icon: TerminalSquare },
  { id: "credentials", label: "Coding agent", icon: KeyRound },
  { id: "network", label: "Network", icon: Network },
  { id: "functions", label: "Functions", icon: Webhook },
  { id: "sharing", label: "Sharing", icon: Share2 },
];

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function EnvironmentSettings({
  environment,
  sandbox0Connection,
  onChange,
  onClose,
}: EnvironmentSettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState(environment);
  const [saved, setSaved] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function saveAndClose() {
    onChange(draft);
    setSaved(true);
    window.setTimeout(onClose, 250);
  }

  function addDomain() {
    const domain = newDomain.trim().toLowerCase();
    if (!domain || draft.networkPolicy.allowedDomains.includes(domain)) {
      return;
    }
    setDraft((current) => ({
      ...current,
      networkPolicy: {
        ...current.networkPolicy,
        allowedDomains: [...current.networkPolicy.allowedDomains, domain],
      },
    }));
    setNewDomain("");
  }

  return (
    <div
      className="modal-layer settings-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={drawerRef}
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-settings-title"
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div className="settings-heading">
            <span
              className="settings-environment-avatar"
              style={{ backgroundColor: draft.color }}
              aria-hidden="true"
            >
              {draft.name.slice(0, 1)}
            </span>
            <div>
              <span className="dialog-kicker">Environment</span>
              <h1 id="environment-settings-title">{draft.name} settings</h1>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button"
            aria-label="Close Environment settings"
            onClick={onClose}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Environment settings sections">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  type="button"
                  key={tab.id}
                  className={activeTab === tab.id ? "is-active" : ""}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={16} />
                  {tab.label}
                  {tab.id === "functions" ? <span className="nav-count">3</span> : null}
                </button>
              );
            })}
          </nav>

          <div className="settings-content">
            {activeTab === "general" ? (
              <SettingsSection
                eyebrow="Environment identity"
                title="General"
                description="Sessions are grouped by Environment, and each one starts from a pinned Environment revision."
              >
                <div className="field-grid two-columns">
                  <label>
                    Name
                    <input
                      name="environment-name"
                      autoComplete="off"
                      value={draft.name}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, name: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Color
                    <span className="color-input-row">
                      <input
                        type="color"
                        name="environment-color-picker"
                        value={draft.color}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, color: event.target.value }))
                        }
                      />
                      <input
                        name="environment-color"
                        autoComplete="off"
                        value={draft.color}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, color: event.target.value }))
                        }
                      />
                    </span>
                  </label>
                </div>
                <label className="full-field">
                  Description
                  <input
                    name="environment-description"
                    autoComplete="off"
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, description: event.target.value }))
                    }
                  />
                </label>
                <div className="settings-card definition-card">
                  <DefinitionRow label="Current revision" value={`r${draft.revision}`} />
                  <DefinitionRow label="Template" value={draft.templateId} code />
                  <DefinitionRow label="Rootfs snapshot" value={draft.rootfsSnapshotId} code />
                  <DefinitionRow label="Workspace seed" value={draft.workspaceVolumeId} code />
                  <DefinitionRow
                    label="Sandbox0 connection"
                    value={sandbox0Connection?.name ?? draft.sandbox0ConnectionId}
                  />
                  <DefinitionRow
                    label="Sandbox0 API Host"
                    value={sandbox0Connection?.apiHost ?? "Connection unavailable"}
                    code
                  />
                </div>
                <div className="setting-row immutable-row">
                  <div>
                    <strong>Control-plane binding</strong>
                    <p>
                      This Environment and every derived Session stay on the Sandbox0 connection
                      selected at creation. Rotate the key in Preferences without moving resources.
                    </p>
                  </div>
                  <span className="fixed-value">Fixed</span>
                </div>
                <div className="setting-row immutable-row">
                  <div>
                    <strong>Session hard TTL</strong>
                    <p>All Sandpi session Sandboxes are permanently removed after this limit.</p>
                  </div>
                  <span className="fixed-value">30 days · fixed</span>
                </div>
              </SettingsSection>
            ) : null}

            {activeTab === "initialization" ? (
              <SettingsSection
                eyebrow="Reproducible baseline"
                title="Initialization"
                description="Publishing a revision captures the rootfs, workspace seed and current Environment credential state."
              >
                <label className="full-field">
                  Git repository
                  <span className="input-with-icon">
                    <GitBranch size={15} />
                    <input
                      name="repository"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.repository}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, repository: event.target.value }))
                      }
                    />
                  </span>
                </label>
                <div className="field-grid two-columns">
                  <label>
                    Branch
                    <input
                      name="branch"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.branch}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, branch: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Mount point
                    <input name="mount-point" readOnly value="/workspace" />
                  </label>
                </div>
                <label className="full-field">
                  Initialization script
                  <textarea
                    name="initialization-script"
                    autoComplete="off"
                    spellCheck={false}
                    className="code-textarea"
                    rows={7}
                    value={draft.initScript}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, initScript: event.target.value }))
                    }
                  />
                </label>
                <div className="revision-flow" aria-label="Environment revision flow">
                  <span>Seed sandbox</span>
                  <ChevronRight size={15} />
                  <span>Run initialization</span>
                  <ChevronRight size={15} />
                  <span>Publish r{draft.revision + 1}</span>
                </div>
                <button type="button" className="secondary-action-button">
                  <Play size={15} /> Run and publish new revision
                </button>
              </SettingsSection>
            ) : null}

            {activeTab === "credentials" ? (
              <SettingsSection
                eyebrow="Bound to this Environment"
                title="Coding agent & account"
                description="The coding agent is selected when an Environment is created. Every Session inherits that agent and its pinned official authentication state."
              >
                <div className="immutable-agent-callout">
                  <LockKeyhole size={17} />
                  <div>
                    <strong>{draft.codingAgent.label} is fixed for this Environment</strong>
                    <p>
                      Create another Environment to use Claude Code, OpenCode or Pi later. A
                      running Session cannot switch harnesses.
                    </p>
                  </div>
                  <span>Immutable</span>
                </div>
                <div className="credential-callout">
                  <LockKeyhole size={17} />
                  <div>
                    <strong>Credential revision {draft.credentialRevision}</strong>
                    <p>
                      Stored with the Environment baseline and materialized only into isolated
                      session Sandboxes.
                    </p>
                  </div>
                </div>
                <div className="credential-list">
                  <div className="credential-row">
                    <span
                      className={`harness-logo harness-${draft.codingAgent.harness}`}
                      aria-hidden="true"
                    >
                      {draft.codingAgent.label.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{draft.codingAgent.label}</strong>
                      <p>
                        {draft.codingAgent.account} · verified {draft.codingAgent.lastVerified}
                      </p>
                    </div>
                    <span className="connected-badge">
                      <Check size={12} /> Connected
                    </span>
                  </div>
                </div>
                <div className="credential-actions">
                  <button type="button" className="secondary-action-button">
                    <RefreshCw size={15} /> Re-authenticate {draft.codingAgent.label}
                  </button>
                  <button type="button" className="text-action-button">
                    Open official auth details <ExternalLink size={13} />
                  </button>
                </div>
                <p className="settings-footnote">
                  Refresh-token concurrency and account revocation must be validated against the
                  native Codex auth flow before enabling real multi-session credential materialization.
                </p>
              </SettingsSection>
            ) : null}

            {activeTab === "network" ? (
              <SettingsSection
                eyebrow="Inherited by every fork"
                title="Network policy"
                description="The Environment policy is applied to each new Session Sandbox before the coding agent starts."
              >
                <div className="network-mode-grid">
                  {([
                    ["restricted", "Restricted", "Allow listed destinations and block the rest."],
                    ["allow-all", "Allow all", "Permit outbound traffic without a domain allowlist."],
                    ["block-all", "Block all", "Disable all outbound network traffic."],
                  ] as const).map(([mode, label, description]) => (
                    <button
                      type="button"
                      key={mode}
                      className={draft.networkPolicy.mode === mode ? "is-selected" : ""}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          networkPolicy: { ...current.networkPolicy, mode },
                        }))
                      }
                    >
                      <span className="radio-mark">
                        {draft.networkPolicy.mode === mode ? <CircleDot size={15} /> : null}
                      </span>
                      <strong>{label}</strong>
                      <p>{description}</p>
                    </button>
                  ))}
                </div>
                <div className="settings-card domain-card">
                  <header>
                    <div>
                      <strong>Allowed domains</strong>
                      <p>HTTPS traffic to these destinations is allowed.</p>
                    </div>
                    <Globe2 size={18} />
                  </header>
                  <div className="domain-list">
                    {draft.networkPolicy.allowedDomains.map((domain) => (
                      <span key={domain}>
                        {domain}
                        <button
                          type="button"
                          aria-label={`Remove ${domain}`}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              networkPolicy: {
                                ...current.networkPolicy,
                                allowedDomains: current.networkPolicy.allowedDomains.filter(
                                  (item) => item !== domain,
                                ),
                              },
                            }))
                          }
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="add-domain-row">
                    <input
                      name="allowed-domain"
                      autoComplete="off"
                      spellCheck={false}
                      value={newDomain}
                      onChange={(event) => setNewDomain(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addDomain();
                        }
                      }}
                      placeholder="example.com…"
                    />
                    <button type="button" onClick={addDomain}>
                      <Plus size={14} /> Add
                    </button>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Log denied requests</strong>
                    <p>Surface denied egress as Sandbox0 audit events.</p>
                  </div>
                  <Toggle
                    label="Log denied requests"
                    checked={draft.networkPolicy.logDeniedRequests}
                    onChange={(checked) =>
                      setDraft((current) => ({
                        ...current,
                        networkPolicy: {
                          ...current.networkPolicy,
                          logDeniedRequests: checked,
                        },
                      }))
                    }
                  />
                </div>
              </SettingsSection>
            ) : null}

            {activeTab === "functions" ? (
              <SettingsSection
                eyebrow="Environment automation"
                title="Functions"
                description="Built-in sandbox jobs update the Environment baseline without consuming a user Session."
              >
                <div className="function-list">
                  {draft.functions.map((fn) => (
                    <div className="function-row" key={fn.id}>
                      <span className="function-icon">
                        {fn.kind === "webhook" ? (
                          <Webhook size={17} />
                        ) : fn.kind === "cron" ? (
                          <Clock3 size={17} />
                        ) : (
                          <Play size={17} />
                        )}
                      </span>
                      <div>
                        <strong>{fn.name}</strong>
                        <p>{fn.description}</p>
                        {fn.lastRun ? <small>Last run {fn.lastRun}</small> : null}
                      </div>
                      {fn.status === "coming-soon" ? (
                        <span className="coming-soon-badge">Coming soon</span>
                      ) : (
                        <Toggle
                          label={`${fn.name} enabled`}
                          checked={fn.status === "active"}
                          onChange={(checked) =>
                            setDraft((current) => ({
                              ...current,
                              functions: current.functions.map((item) =>
                                item.id === fn.id
                                  ? { ...item, status: checked ? "active" : "disabled" }
                                  : item,
                              ),
                            }))
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
                <div className="settings-card webhook-card">
                  <span className="settings-card-label">Git webhook endpoint</span>
                  <div className="copy-value-row">
                    <code>https://api.sandpi.dev/v1/hooks/env-default/git</code>
                    <button type="button" aria-label="Copy webhook endpoint">
                      <Copy size={14} />
                    </button>
                  </div>
                  <p>
                    On push: resume initializer → fetch → install → publish rootfs and workspace
                    revision → pause.
                  </p>
                </div>
              </SettingsSection>
            ) : null}

            {activeTab === "sharing" ? (
              <SettingsSection
                eyebrow="Volume access grants"
                title="Sharing"
                description="File links are scoped grants enforced by Sandpi’s control plane, not public Sandbox endpoints."
              >
                <div className="setting-row">
                  <div>
                    <strong>Allow file sharing</strong>
                    <p>Members can create expiring links from the /workspace file browser.</p>
                  </div>
                  <Toggle label="Allow file sharing" checked onChange={() => undefined} />
                </div>
                <div className="field-grid two-columns">
                  <label>
                    Default permission
                    <select name="default-share-permission" defaultValue="viewer">
                      <option value="viewer">Can view</option>
                      <option value="download">Can view & download</option>
                    </select>
                  </label>
                  <label>
                    Default expiration
                    <select name="default-share-expiry" defaultValue="7-days">
                      <option value="24-hours">24 hours</option>
                      <option value="7-days">7 days</option>
                      <option value="30-days">30 days</option>
                    </select>
                  </label>
                </div>
                <div className="empty-grants-card">
                  <Share2 size={22} />
                  <strong>No active Environment links</strong>
                  <p>Session file links will appear here with their path, permission and expiry.</p>
                </div>
              </SettingsSection>
            ) : null}
          </div>
        </div>

        <footer className="settings-footer">
          <span aria-live="polite">
            {saved ? (
              <>
                <Check size={14} /> Saved
              </>
            ) : (
              <>Changes apply to future Session forks.</>
            )}
          </span>
          <div>
            <button type="button" className="button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="button-primary" onClick={saveAndClose}>
              Save changes
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function SettingsSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section">
      <header>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

function DefinitionRow({
  label,
  value,
  code = false,
}: {
  label: string;
  value: string;
  code?: boolean;
}) {
  return (
    <div>
      <span>{label}</span>
      {code ? <code>{value}</code> : <strong>{value}</strong>}
    </div>
  );
}
