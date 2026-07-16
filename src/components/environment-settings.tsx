"use client";

import {
  Archive,
  Check,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  Globe2,
  KeyRound,
  LockKeyhole,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Share2,
  Trash2,
  TriangleAlert,
  Webhook,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { OperationLanguage } from "@/lib/operation-ui";
import {
  formatUnixTimestamp,
  unixTimestampToIso,
  type UnixTimestamp,
} from "@/lib/time";
import type { CodingSession, Environment } from "@/lib/types";

type SettingsTab =
  | "general"
  | "archived-sessions"
  | "credentials"
  | "network"
  | "functions"
  | "sharing";

interface EnvironmentSettingsProps {
  environment: Environment;
  teamName: string;
  language: OperationLanguage;
  timeZone: string;
  archivedSessions: CodingSession[];
  onChange: (environment: Environment) => void;
  onDelete: (environmentId: string) => void;
  onRestoreSession: (sessionId: string) => void;
  onClose: () => void;
}

interface CodexDeviceAuthFlow {
  id: string;
  environmentId: string;
  status:
    | "provisioning"
    | "starting"
    | "awaiting_user"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  expiresAt: UnixTimestamp;
}

const ACTIVE_CODEX_AUTH_STATUSES = new Set<CodexDeviceAuthFlow["status"]>([
  "provisioning",
  "starting",
  "awaiting_user",
]);

const tabs: Array<{
  id: SettingsTab;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "archived-sessions", label: "Archived sessions", icon: Archive },
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

function formatArchivedSessionTime(
  timestamp: UnixTimestamp,
  language: OperationLanguage,
  timeZone: string,
) {
  return formatUnixTimestamp(timestamp, language, timeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function EnvironmentSettings({
  environment,
  teamName,
  language,
  timeZone,
  archivedSessions,
  onChange,
  onDelete,
  onRestoreSession,
  onClose,
}: EnvironmentSettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState(environment);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [codexAuthFlow, setCodexAuthFlow] =
    useState<CodexDeviceAuthFlow | null>(null);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthError, setCodexAuthError] = useState("");
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dangerZoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusFrame = window.requestAnimationFrame(() =>
      closeButtonRef.current?.focus(),
    );

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

  useEffect(() => {
    if (!deleteConfirming) return;
    const frame = window.requestAnimationFrame(() => {
      dangerZoneRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deleteConfirming]);

  useEffect(() => {
    const controller = new AbortController();
    void apiFetch<ApiEnvelope<CodexDeviceAuthFlow | null>>(
      `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/device-login`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!response.data) return;
        setCodexAuthFlow(response.data);
        setCodexAuthBusy(ACTIVE_CODEX_AUTH_STATUSES.has(response.data.status));
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setCodexAuthError(
            error instanceof Error
              ? error.message
              : "Could not recover the Codex login state.",
          );
        }
      });
    return () => controller.abort();
  }, [environment.id]);

  useEffect(() => {
    const flow = codexAuthFlow;
    if (!flow || !ACTIVE_CODEX_AUTH_STATUSES.has(flow.status)) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await apiFetch<ApiEnvelope<CodexDeviceAuthFlow>>(
          `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/device-login/${encodeURIComponent(flow.id)}`,
        );
        if (cancelled) return;
        setCodexAuthFlow(response.data);
        if (response.data.status === "completed") {
          const environments = await apiFetch<ApiEnvelope<Environment[]>>(
            "/api/v1/environments",
          );
          if (cancelled) return;
          const refreshed = environments.data.find(
            (candidate) => candidate.id === environment.id,
          );
          if (refreshed) {
            setDraft(refreshed);
            onChange(refreshed);
          }
          setCodexAuthBusy(false);
          return;
        }
        if (!ACTIVE_CODEX_AUTH_STATUSES.has(response.data.status)) {
          setCodexAuthBusy(false);
          setCodexAuthError(
            response.data.error ?? "Codex authentication did not complete.",
          );
          return;
        }
        timer = window.setTimeout(poll, 1_500);
      } catch (error) {
        if (cancelled) return;
        setCodexAuthBusy(false);
        setCodexAuthError(
          error instanceof Error
            ? error.message
            : "Could not refresh Codex authentication.",
        );
      }
    };

    timer = window.setTimeout(poll, 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [codexAuthFlow, environment.id, onChange]);

  async function startCodexDeviceLogin() {
    if (codexAuthBusy) return;
    setCodexAuthBusy(true);
    setCodexAuthError("");
    setCopiedDeviceCode(false);
    try {
      const response = await apiFetch<ApiEnvelope<CodexDeviceAuthFlow>>(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/device-login`,
        { method: "POST" },
      );
      setCodexAuthFlow(response.data);
    } catch (error) {
      setCodexAuthBusy(false);
      setCodexAuthError(
        error instanceof Error
          ? error.message
          : "Could not start Codex authentication.",
      );
    }
  }

  async function cancelCodexDeviceLogin() {
    const flow = codexAuthFlow;
    if (!flow || !ACTIVE_CODEX_AUTH_STATUSES.has(flow.status)) return;
    try {
      const response = await apiFetch<ApiEnvelope<CodexDeviceAuthFlow>>(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/device-login/${encodeURIComponent(flow.id)}`,
        { method: "DELETE" },
      );
      setCodexAuthFlow(response.data);
      setCodexAuthBusy(false);
    } catch (error) {
      setCodexAuthError(
        error instanceof Error
          ? error.message
          : "Could not cancel Codex authentication.",
      );
    }
  }

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

  async function saveAndClose() {
    if (saving) {
      return;
    }

    setSaving(true);
    setSaveError("");
    try {
      const response = await apiFetch<ApiEnvelope<Environment>>(
        `/api/v1/environments/${encodeURIComponent(environment.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: draft.name.trim(),
            description: draft.description,
            color: draft.color,
            networkPolicy: draft.networkPolicy,
          }),
        },
      );
      onChange(response.data);
      setDraft(response.data);
      setSaved(true);
      window.setTimeout(onClose, 250);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Environment changes could not be saved.",
      );
      setSaving(false);
    }
  }

  async function deleteEnvironment() {
    if (deleting || deleteName !== environment.name) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await apiFetch<ApiEnvelope<{ id: string }>>(
        `/api/v1/environments/${encodeURIComponent(environment.id)}`,
        { method: "DELETE" },
      );
      onDelete(environment.id);
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "The Environment could not be deleted.",
      );
      setDeleting(false);
    }
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
        if (event.target === event.currentTarget && !deleting) {
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
            disabled={deleting}
            onClick={onClose}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className="settings-body">
          <nav
            className="settings-nav"
            aria-label="Environment settings sections"
          >
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
                  {tab.id === "functions" ? (
                    <span className="nav-count">{draft.functions.length}</span>
                  ) : tab.id === "archived-sessions" ? (
                    <span className="nav-count">{archivedSessions.length}</span>
                  ) : null}
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
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
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
                          setDraft((current) => ({
                            ...current,
                            color: event.target.value,
                          }))
                        }
                      />
                      <input
                        name="environment-color"
                        autoComplete="off"
                        value={draft.color}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            color: event.target.value,
                          }))
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
                      setDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="settings-card definition-card">
                  <DefinitionRow label="Team" value={teamName} />
                  <DefinitionRow
                    label="Current revision"
                    value={`r${draft.revision}`}
                  />
                  <DefinitionRow
                    label="Template"
                    value={draft.templateId}
                    code
                  />
                  <DefinitionRow
                    label="Rootfs snapshot"
                    value={draft.rootfsSnapshotId}
                    code
                  />
                  <DefinitionRow
                    label="Workspace Volume"
                    value={draft.workspaceVolumeId}
                    code
                  />
                  <DefinitionRow label="Sandbox" value={draft.sandboxId} code />
                  <DefinitionRow
                    label="Harness Supervisor"
                    value={draft.supervisorSessionId || "Starts on demand"}
                    code={Boolean(draft.supervisorSessionId)}
                  />
                </div>
                <div
                  ref={dangerZoneRef}
                  className={`environment-danger-zone ${
                    deleteConfirming ? "is-confirming" : ""
                  }`}
                >
                  <div className="environment-danger-heading">
                    <span aria-hidden="true">
                      <TriangleAlert size={17} />
                    </span>
                    <div>
                      <strong>Delete Environment</strong>
                      <p>
                        Permanently delete every Session, the shared Sandbox,
                        Workspace Volume and stored coding-agent credential.
                      </p>
                    </div>
                  </div>
                  {deleteConfirming ? (
                    <div className="environment-delete-confirmation">
                      <label>
                        <span>
                          Type <strong>{environment.name}</strong> to confirm
                        </span>
                        <input
                          autoFocus
                          name="environment-delete-confirmation"
                          autoComplete="off"
                          spellCheck={false}
                          value={deleteName}
                          disabled={deleting}
                          onChange={(event) => setDeleteName(event.target.value)}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              deleteName === environment.name
                            ) {
                              event.preventDefault();
                              void deleteEnvironment();
                            }
                          }}
                        />
                      </label>
                      <p>
                        This cannot be undone. Archived Sessions are deleted too.
                      </p>
                      {deleteError ? (
                        <p className="settings-inline-error" role="alert">
                          {deleteError}
                        </p>
                      ) : null}
                      <div className="environment-delete-actions">
                        <button
                          type="button"
                          className="button-secondary"
                          disabled={deleting}
                          onClick={() => {
                            setDeleteConfirming(false);
                            setDeleteName("");
                            setDeleteError("");
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="environment-delete-button"
                          disabled={deleting || deleteName !== environment.name}
                          onClick={() => void deleteEnvironment()}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {deleting ? "Deleting…" : "Delete permanently"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="environment-delete-trigger"
                      onClick={() => setDeleteConfirming(true)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete Environment
                    </button>
                  )}
                </div>
              </SettingsSection>
            ) : null}

            {activeTab === "archived-sessions" ? (
              <SettingsSection
                eyebrow="Session history"
                title="Archived sessions"
                description="Archived Sessions are hidden from the Environment sidebar. Restore one to make its native coding-agent Session available again."
              >
                {archivedSessions.length > 0 ? (
                  <div
                    className="archived-sessions-list"
                    aria-label="Archived Sessions"
                  >
                    {archivedSessions.map((session) => (
                      <article
                        className="archived-session-row"
                        key={session.id}
                      >
                        <span
                          className="archived-session-icon"
                          aria-hidden="true"
                        >
                          <Archive size={16} />
                        </span>
                        <div className="archived-session-main">
                          <strong className="archived-session-title">
                            {session.title}
                          </strong>
                          <span className="archived-session-meta">
                            <span>{session.harnessLabel}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                              Archived / updated{" "}
                              <time dateTime={unixTimestampToIso(session.updatedAt)}>
                                {formatArchivedSessionTime(
                                  session.updatedAt,
                                  language,
                                  timeZone,
                                )}
                              </time>
                            </span>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="archived-session-restore"
                          aria-label={`Restore ${session.title}`}
                          onClick={() => onRestoreSession(session.id)}
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                          Restore
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="archived-sessions-empty">
                    <span aria-hidden="true">
                      <Archive size={22} />
                    </span>
                    <strong>No archived Sessions</strong>
                    <p>
                      Sessions archived from this Environment will appear here
                      and can be restored at any time while they still exist.
                    </p>
                  </div>
                )}
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
                    <strong>
                      {draft.codingAgent.label} is fixed for this Environment
                    </strong>
                    <p>
                      Create another Environment to use Claude Code, OpenCode or
                      Pi later. A running Session cannot switch harnesses.
                    </p>
                  </div>
                  <span>Immutable</span>
                </div>
                <div className="credential-callout">
                  <LockKeyhole size={17} />
                  <div>
                    <strong>
                      Credential revision {draft.credentialRevision}
                    </strong>
                    <p>
                      Referenced by the Environment; secret material stays outside
                      baseline snapshots and is injected only when a Session starts.
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
                        {draft.codingAgent.status === "connected"
                          ? `${draft.codingAgent.account ?? "ChatGPT"} · verified ${
                              draft.codingAgent.lastVerified
                                ? formatArchivedSessionTime(
                                    draft.codingAgent.lastVerified,
                                    language,
                                    timeZone,
                                  )
                                : "recently"
                            }`
                          : "Use the official ChatGPT device-code flow. One Environment credential is shared by all of its Sessions."}
                      </p>
                    </div>
                    <span
                      className={
                        draft.codingAgent.status === "connected"
                          ? "connected-badge"
                          : "status-badge"
                      }
                    >
                      {draft.codingAgent.status === "connected" ? (
                        <>
                          <Check size={12} /> Connected
                        </>
                      ) : (
                        "Not connected"
                      )}
                    </span>
                  </div>
                </div>

                {codexAuthFlow?.verificationUrl &&
                ACTIVE_CODEX_AUTH_STATUSES.has(codexAuthFlow.status) ? (
                  <div className="device-auth-card" role="status">
                    <div>
                      <span>ChatGPT device code</span>
                      <strong>{codexAuthFlow.userCode}</strong>
                      <p>
                        Open the official sign-in page, enter this one-time code,
                        then return here. Sandpi keeps polling even if this drawer closes.
                      </p>
                    </div>
                    <div className="device-auth-actions">
                      <a
                        className="secondary-action-button"
                        href={codexAuthFlow.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open ChatGPT <ExternalLink size={13} />
                      </a>
                      <button
                        type="button"
                        className="text-action-button"
                        onClick={() => {
                          if (!codexAuthFlow.userCode) return;
                          void copyTextToClipboard(codexAuthFlow.userCode)
                            .then(() => {
                              setCopiedDeviceCode(true);
                              window.setTimeout(
                                () => setCopiedDeviceCode(false),
                                1_500,
                              );
                            })
                            .catch(() => {
                              setCodexAuthError(
                                "The browser could not copy the device code.",
                              );
                            });
                        }}
                      >
                        <Copy size={13} />
                        {copiedDeviceCode ? "Copied" : "Copy code"}
                      </button>
                      <button
                        type="button"
                        className="text-action-button"
                        onClick={() => void cancelCodexDeviceLogin()}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                {codexAuthError ? (
                  <p className="settings-inline-error" role="alert">
                    {codexAuthError}
                  </p>
                ) : null}
                <div className="credential-actions">
                  <button
                    type="button"
                    className="secondary-action-button"
                    disabled={
                      codexAuthBusy ||
                      Boolean(
                        codexAuthFlow &&
                          ACTIVE_CODEX_AUTH_STATUSES.has(codexAuthFlow.status),
                      )
                    }
                    onClick={() => void startCodexDeviceLogin()}
                  >
                    <RefreshCw size={15} />
                    {codexAuthBusy
                      ? "Starting official sign-in…"
                      : draft.codingAgent.status === "connected"
                        ? `Re-authenticate ${draft.codingAgent.label}`
                        : `Connect ${draft.codingAgent.label}`}
                  </button>
                </div>
                <p className="settings-footnote">
                  The encrypted credential is Environment-scoped deployment
                  data. Native Session and Turn branches reuse this binding and
                  never copy credential material.
                </p>
              </SettingsSection>
            ) : null}

            {activeTab === "network" ? (
              <SettingsSection
                eyebrow="Environment runtime"
                title="Network policy"
                description="This policy is applied to the Environment's shared Sandbox and therefore covers every native coding-agent Session in it."
              >
                <div className="network-mode-grid">
                  {(
                    [
                      [
                        "restricted",
                        "Restricted",
                        "Allow listed destinations and block the rest.",
                      ],
                      [
                        "allow-all",
                        "Allow all",
                        "Permit outbound traffic without a domain allowlist.",
                      ],
                      [
                        "block-all",
                        "Block all",
                        "Disable all outbound network traffic.",
                      ],
                    ] as const
                  ).map(([mode, label, description]) => (
                    <button
                      type="button"
                      key={mode}
                      className={
                        draft.networkPolicy.mode === mode ? "is-selected" : ""
                      }
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          networkPolicy: { ...current.networkPolicy, mode },
                        }))
                      }
                    >
                      <span className="radio-mark">
                        {draft.networkPolicy.mode === mode ? (
                          <CircleDot size={15} />
                        ) : null}
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
                                allowedDomains:
                                  current.networkPolicy.allowedDomains.filter(
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
                description="Built-in sandbox jobs run Environment automation without consuming a user Session."
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
                        {fn.lastRun ? (
                          <small>
                            Last run{" "}
                            {formatArchivedSessionTime(
                              fn.lastRun,
                              language,
                              timeZone,
                            )}
                          </small>
                        ) : null}
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
                                  ? {
                                      ...item,
                                      status: checked ? "active" : "disabled",
                                    }
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
                  <span className="settings-card-label">
                    Git webhook endpoint
                  </span>
                  <div className="copy-value-row">
                    <code>https://api.sandpi.dev/v1/hooks/env-default/git</code>
                    <button type="button" aria-label="Copy webhook endpoint">
                      <Copy size={14} />
                    </button>
                  </div>
                  <p>
                    On push: validate event → start sandbox function → warm
                    caches → record result.
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
                    <p>
                      Members can create expiring links from the /workspace file
                      browser.
                    </p>
                  </div>
                  <Toggle
                    label="Allow file sharing"
                    checked
                    onChange={() => undefined}
                  />
                </div>
                <div className="field-grid two-columns">
                  <label>
                    Default permission
                    <select
                      name="default-share-permission"
                      defaultValue="viewer"
                    >
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
                  <p>
                    Environment file links will appear here with their path,
                    permission and expiry.
                  </p>
                </div>
              </SettingsSection>
            ) : null}
          </div>
        </div>

        <footer className="settings-footer">
          <span aria-live="polite">
            {saveError ? (
              <>{saveError}</>
            ) : saved ? (
              <>
                <Check size={14} /> Saved
              </>
            ) : (
              <>Changes apply to future Session forks.</>
            )}
          </span>
          <div>
            <button
              type="button"
              className="button-secondary"
              disabled={saving || deleting}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button-primary"
              disabled={
                saving || deleting || deleteConfirming || !draft.name.trim()
              }
              onClick={() => void saveAndClose()}
            >
              {saving ? "Saving…" : "Save changes"}
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
