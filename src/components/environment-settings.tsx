"use client";

import {
  Archive,
  Cable,
  Check,
  Copy,
  ExternalLink,
  Globe2,
  KeyRound,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
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
import {
  CodexMcpSettings,
  CodexSkillsSettings,
} from "@/harnesses/codex/environment-settings";
import type {
  CodexAccountPlanType,
  CodexAccountRateLimits,
  CodexAccountSummary,
  CodexRateLimitWindow,
} from "@/harnesses/codex/environment-tools";
import { EnvironmentAuditPanel } from "@/components/environment-audit-panel";
import { mergeEnvironmentAuditEventPages } from "@/lib/environment-audit";
import {
  NETWORK_DOMAIN_INPUT_ERROR,
  normalizeNetworkDomain,
} from "@/lib/network-policy";
import type { OperationLanguage } from "@/lib/operation-ui";
import {
  formatUnixTimestamp,
  unixTimestampToIso,
  type UnixTimestamp,
} from "@/lib/time";
import type {
  CodingSession,
  Environment,
  EnvironmentAuditFeed,
  NetworkPolicy,
} from "@/lib/types";

export type EnvironmentSettingsTab =
  | "general"
  | "archived-sessions"
  | "audit"
  | "credentials"
  | "skills"
  | "mcp"
  | "network";

interface EnvironmentSettingsProps {
  environment: Environment;
  initialTab?: EnvironmentSettingsTab;
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
  id: EnvironmentSettingsTab;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "archived-sessions", label: "Archived sessions", icon: Archive },
  { id: "audit", label: "Audit", icon: ShieldCheck },
  { id: "credentials", label: "Coding agent", icon: KeyRound },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP servers", icon: Cable },
  { id: "network", label: "Network", icon: Network },
];

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

function formatCodexPlan(planType: CodexAccountPlanType | undefined) {
  switch (planType) {
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "prolite":
      return "Pro Lite";
    case "team":
      return "Team";
    case "self_serve_business_usage_based":
      return "Business usage-based";
    case "business":
      return "Business";
    case "enterprise_cbp_usage_based":
      return "Enterprise usage-based";
    case "enterprise":
      return "Enterprise";
    case "edu":
      return "Edu";
    case "unknown":
      return "Unknown plan";
    default:
      return "Plan unavailable";
  }
}

function formatCodexRateLimitWindow(
  window: CodexRateLimitWindow,
  fallback: "Primary" | "Secondary",
) {
  const minutes = window.windowDurationMins;
  if (!minutes) return `${fallback} window`;
  if (minutes === 10_080) return "Weekly window";
  if (minutes === 1_440) return "Daily window";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function mergeCredentialProjection(
  draft: Environment,
  refreshed: Environment,
): Environment {
  return {
    ...draft,
    credentialRevision: refreshed.credentialRevision,
    codingAgent: refreshed.codingAgent,
  };
}

function hasUnsavedEnvironmentChanges(
  draft: Environment,
  environment: Environment,
) {
  const draftDomains = draft.networkPolicy.domainExceptions;
  const savedDomains = environment.networkPolicy.domainExceptions;
  return (
    draft.name.trim() !== environment.name ||
    draft.description !== environment.description ||
    draft.color !== environment.color ||
    draft.networkPolicy.mode !== environment.networkPolicy.mode ||
    draftDomains.length !== savedDomains.length ||
    draftDomains.some((domain, index) => domain !== savedDomains[index])
  );
}

export function EnvironmentSettings({
  environment,
  initialTab = "general",
  teamName,
  language,
  timeZone,
  archivedSessions,
  onChange,
  onDelete,
  onRestoreSession,
  onClose,
}: EnvironmentSettingsProps) {
  const [activeTab, setActiveTab] =
    useState<EnvironmentSettingsTab>(initialTab);
  const [draft, setDraft] = useState(environment);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteName, setDeleteName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [domainError, setDomainError] = useState("");
  const [pendingNetworkMode, setPendingNetworkMode] =
    useState<NetworkPolicy["mode"] | null>(null);
  const [codexAuthFlow, setCodexAuthFlow] =
    useState<CodexDeviceAuthFlow | null>(null);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [codexAuthError, setCodexAuthError] = useState("");
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false);
  const [codexAccount, setCodexAccount] =
    useState<CodexAccountSummary | null>(null);
  const [codexRateLimits, setCodexRateLimits] =
    useState<CodexAccountRateLimits | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexUsageError, setCodexUsageError] = useState("");
  const [codexEnvironmentRefreshError, setCodexEnvironmentRefreshError] =
    useState("");
  const [codexAccountReload, setCodexAccountReload] = useState(0);
  const [environmentAudit, setEnvironmentAudit] =
    useState<EnvironmentAuditFeed | null>(null);
  const [environmentAuditLoading, setEnvironmentAuditLoading] = useState(false);
  const [environmentAuditError, setEnvironmentAuditError] = useState("");
  const [environmentAuditReload, setEnvironmentAuditReload] = useState(0);
  const [environmentAuditLoadingNewer, setEnvironmentAuditLoadingNewer] =
    useState(false);
  const [environmentAuditNewerError, setEnvironmentAuditNewerError] =
    useState("");
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dangerZoneRef = useRef<HTMLDivElement>(null);
  const hasUnsavedChanges = hasUnsavedEnvironmentChanges(draft, environment);
  const codexAuthFlowId = codexAuthFlow?.id;
  const codexAuthFlowStatus = codexAuthFlow?.status;
  const blocksByDefault = draft.networkPolicy.mode === "block-all";
  const domainAction = blocksByDefault ? "allow" : "block";
  const domainActionPast = blocksByDefault ? "allowed" : "blocked";
  const domainListTitle = blocksByDefault
    ? "Allowed domains"
    : "Blocked domains";
  const domainDescription = blocksByDefault
    ? "These domains override the default block. Every other outbound destination remains blocked."
    : "These domains override the default allow. Every other outbound destination remains reachable.";
  const domainEmptyState = blocksByDefault
    ? "No exceptions. All outbound destinations are blocked."
    : "No exceptions. All outbound destinations are allowed.";

  useEffect(() => {
    setActiveTab(initialTab);
  }, [environment.id, initialTab]);

  useEffect(() => {
    if (activeTab !== "audit") return;

    const controller = new AbortController();
    setEnvironmentAudit(null);
    setEnvironmentAuditError("");
    setEnvironmentAuditNewerError("");
    setEnvironmentAuditLoadingNewer(false);
    setEnvironmentAuditLoading(true);
    void apiFetch<ApiEnvelope<EnvironmentAuditFeed>>(
      `/api/v1/environments/${encodeURIComponent(environment.id)}/audit`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!controller.signal.aborted) {
          setEnvironmentAudit(response.data);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setEnvironmentAuditError(
            error instanceof Error
              ? error.message
              : "Environment audit could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setEnvironmentAuditLoading(false);
        }
      });

    return () => controller.abort();
  }, [activeTab, environment.id, environmentAuditReload]);

  async function loadNewerEnvironmentAudit() {
    const cursor = environmentAudit?.nextCursor;
    if (!cursor || environmentAuditLoadingNewer) return;

    setEnvironmentAuditLoadingNewer(true);
    setEnvironmentAuditNewerError("");
    try {
      const response = await apiFetch<ApiEnvelope<EnvironmentAuditFeed>>(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/audit?cursor=${encodeURIComponent(cursor)}`,
      );
      setEnvironmentAudit((current) =>
        current
          ? {
              ...current,
              ...response.data,
              events: mergeEnvironmentAuditEventPages([
                current.events,
                response.data.events,
              ]),
              nextCursor: response.data.nextCursor,
              watermark: response.data.watermark ?? current.watermark,
            }
          : response.data,
      );
    } catch (error) {
      setEnvironmentAuditNewerError(
        error instanceof Error
          ? error.message
          : "Newer Environment audit records could not be loaded.",
      );
    } finally {
      setEnvironmentAuditLoadingNewer(false);
    }
  }

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
    if (activeTab !== "credentials") return;
    const controller = new AbortController();
    setCodexEnvironmentRefreshError("");
    void apiFetch<ApiEnvelope<Environment[]>>("/api/v1/environments", {
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        const refreshed = response.data.find(
          (candidate) => candidate.id === environment.id,
        );
        if (!refreshed) return;
        setDraft((current) => mergeCredentialProjection(current, refreshed));
        onChange(refreshed);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setCodexEnvironmentRefreshError(
            error instanceof Error
              ? error.message
              : "The Codex account status could not be refreshed.",
          );
        }
      });
    return () => controller.abort();
  }, [activeTab, environment.id, onChange]);

  useEffect(() => {
    if (activeTab !== "credentials") return;
    const controller = new AbortController();
    setCodexUsageLoading(true);
    setCodexUsageError("");
    setCodexRateLimits(null);
    void (async () => {
      try {
        const accountResponse = await apiFetch<
          ApiEnvelope<CodexAccountSummary | null>
        >(
          `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/account`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setCodexAccount(accountResponse.data);
        if (!accountResponse.data) {
          setCodexRateLimits(null);
          return;
        }
        const rateLimitsResponse = await apiFetch<
          ApiEnvelope<CodexAccountRateLimits>
        >(
          `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/rate-limits`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setCodexRateLimits(rateLimitsResponse.data);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setCodexUsageError(
            error instanceof Error
              ? error.message
              : "Live Codex account usage could not be loaded.",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setCodexUsageLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [activeTab, codexAccountReload, environment.id]);

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
    if (
      !codexAuthFlowId ||
      !codexAuthFlowStatus ||
      !ACTIVE_CODEX_AUTH_STATUSES.has(codexAuthFlowStatus)
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await apiFetch<ApiEnvelope<CodexDeviceAuthFlow>>(
          `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/device-login/${encodeURIComponent(codexAuthFlowId)}`,
        );
        if (cancelled) return;
        if (response.data.status === "completed") {
          try {
            const environments = await apiFetch<ApiEnvelope<Environment[]>>(
              "/api/v1/environments",
            );
            if (cancelled) return;
            const refreshed = environments.data.find(
              (candidate) => candidate.id === environment.id,
            );
            if (refreshed) {
              setDraft((current) =>
                mergeCredentialProjection(current, refreshed),
              );
              onChange(refreshed);
            }
          } catch (error) {
            if (cancelled) return;
            setCodexEnvironmentRefreshError(
              error instanceof Error
                ? error.message
                : "The completed Codex account could not be refreshed.",
            );
          }
          if (cancelled) return;
          setCodexAuthFlow(response.data);
          setCodexAuthBusy(false);
          setCodexAccountReload((current) => current + 1);
          return;
        }
        if (!ACTIVE_CODEX_AUTH_STATUSES.has(response.data.status)) {
          setCodexAuthFlow(response.data);
          setCodexAuthBusy(false);
          setCodexAuthError(
            response.data.error ?? "Codex authentication did not complete.",
          );
          return;
        }
        setCodexAuthFlow(response.data);
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
  }, [
    codexAuthFlowId,
    codexAuthFlowStatus,
    environment.id,
    onChange,
  ]);

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
    const domain = normalizeNetworkDomain(newDomain);
    if (!domain) {
      setDomainError(NETWORK_DOMAIN_INPUT_ERROR);
      return;
    }
    if (draft.networkPolicy.domainExceptions.includes(domain)) {
      setDomainError(`${domain} is already ${domainActionPast}.`);
      return;
    }
    setDraft((current) => ({
      ...current,
      networkPolicy: {
        ...current.networkPolicy,
        domainExceptions: [
          ...current.networkPolicy.domainExceptions,
          domain,
        ],
      },
    }));
    setNewDomain("");
    setDomainError("");
    setPendingNetworkMode(null);
  }

  function requestNetworkMode(mode: NetworkPolicy["mode"]) {
    setDomainError("");
    if (mode === draft.networkPolicy.mode) {
      setPendingNetworkMode(null);
      return;
    }
    if (draft.networkPolicy.domainExceptions.length > 0) {
      setPendingNetworkMode(mode);
      return;
    }
    setDraft((current) => ({
      ...current,
      networkPolicy: { ...current.networkPolicy, mode },
    }));
    setNewDomain("");
    setPendingNetworkMode(null);
  }

  function confirmNetworkModeChange() {
    if (!pendingNetworkMode) return;
    setDraft((current) => ({
      ...current,
      networkPolicy: {
        mode: pendingNetworkMode,
        domainExceptions: [],
      },
    }));
    setNewDomain("");
    setDomainError("");
    setPendingNetworkMode(null);
  }

  const displayedCodexAccount =
    codexAccount?.email ?? draft.codingAgent.account ?? "ChatGPT account";
  const displayedCodexPlan =
    codexAccount?.planType ??
    codexRateLimits?.limits.find((limit) => limit.planType)?.planType;
  const displayedCodexLastVerified =
    codexAccount?.lastVerified ?? draft.codingAgent.lastVerified;

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
                  onClick={() => {
                    setActiveTab(tab.id);
                    if (tab.id !== "network") {
                      setPendingNetworkMode(null);
                    }
                  }}
                >
                  <Icon size={16} />
                  {tab.label}
                  {tab.id === "archived-sessions" ? (
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

            {activeTab === "audit" ? (
              <SettingsSection
                eyebrow="Sandbox0 signed evidence"
                title="Environment audit"
                description="Signed Sandbox0 records for this Environment's shared Sandbox. They cover activity across every Session and stay separate from harness-native Session Activity."
              >
                {environmentAuditLoading ? (
                  <div
                    className="archived-sessions-empty"
                    role="status"
                    aria-busy="true"
                    aria-live="polite"
                  >
                    <span aria-hidden="true">
                      <RefreshCw className="is-spinning" size={20} />
                    </span>
                    <strong>Loading Environment audit…</strong>
                    <p>Fetching signed records from Sandbox0.</p>
                  </div>
                ) : environmentAuditError ? (
                  <div className="archived-sessions-empty" role="alert">
                    <span aria-hidden="true">
                      <TriangleAlert size={20} />
                    </span>
                    <strong>Environment audit is unavailable</strong>
                    <p>{environmentAuditError}</p>
                    <button
                      type="button"
                      className="secondary-action-button"
                      onClick={() =>
                        setEnvironmentAuditReload((current) => current + 1)
                      }
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                      Retry
                    </button>
                  </div>
                ) : environmentAudit ? (
                  <EnvironmentAuditPanel
                    audit={environmentAudit}
                    environmentId={environment.id}
                    language={language}
                    loadNewerError={environmentAuditNewerError}
                    loadingNewer={environmentAuditLoadingNewer}
                    onLoadNewer={() => void loadNewerEnvironmentAudit()}
                    timeZone={timeZone}
                  />
                ) : null}
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
                          ? `${displayedCodexAccount} · verified ${
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

                {draft.codingAgent.status === "connected" || codexAccount ? (
                  <div className="codex-account-surface">
                    <dl className="codex-account-identity">
                      <div>
                        <dt>Account</dt>
                        <dd>{displayedCodexAccount}</dd>
                      </div>
                      <div>
                        <dt>ChatGPT plan</dt>
                        <dd>{formatCodexPlan(displayedCodexPlan)}</dd>
                      </div>
                      <div>
                        <dt>Last verified</dt>
                        <dd>
                          {displayedCodexLastVerified
                            ? formatArchivedSessionTime(
                                displayedCodexLastVerified,
                                language,
                                timeZone,
                              )
                            : "Recently"}
                        </dd>
                      </div>
                    </dl>

                    <section
                      className="codex-usage-card"
                      aria-labelledby="codex-usage-title"
                    >
                      <header>
                        <div>
                          <span>Live from ChatGPT</span>
                          <strong id="codex-usage-title">
                            Codex usage limits
                          </strong>
                        </div>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Refresh Codex usage"
                          title="Refresh Codex usage"
                          disabled={codexUsageLoading}
                          onClick={() =>
                            setCodexAccountReload((current) => current + 1)
                          }
                        >
                          <RefreshCw
                            className={codexUsageLoading ? "is-spinning" : ""}
                            size={14}
                            aria-hidden="true"
                          />
                        </button>
                      </header>

                      {codexUsageLoading && !codexRateLimits ? (
                        <p className="codex-usage-state" role="status">
                          Reading the latest account limits…
                        </p>
                      ) : null}

                      {codexUsageError ? (
                        <div className="codex-usage-error" role="alert">
                          <span>{codexUsageError}</span>
                          <button
                            type="button"
                            className="text-action-button"
                            onClick={() =>
                              setCodexAccountReload((current) => current + 1)
                            }
                          >
                            Retry
                          </button>
                        </div>
                      ) : null}

                      {codexRateLimits?.limits.map((limit, limitIndex) => (
                        <div
                          className="codex-rate-limit"
                          key={limit.id ?? `codex-limit-${limitIndex}`}
                        >
                          <div className="codex-rate-limit-heading">
                            <strong>
                              {limit.name ?? limit.id ?? "Codex"}
                            </strong>
                            {limit.reached ? <span>Limit reached</span> : null}
                          </div>
                          {(
                            [
                              ["Primary", limit.primary],
                              ["Secondary", limit.secondary],
                            ] as const
                          ).map(([fallback, window]) => {
                            if (!window) return null;
                            const remaining = 100 - window.usedPercent;
                            const label = formatCodexRateLimitWindow(
                              window,
                              fallback,
                            );
                            return (
                              <div
                                className="codex-rate-window"
                                key={fallback}
                              >
                                <div>
                                  <span>{label}</span>
                                  <strong>{remaining}% remaining</strong>
                                </div>
                                <span
                                  className="codex-rate-track"
                                  role="progressbar"
                                  aria-label={`${limit.name ?? limit.id ?? "Codex"} ${label}`}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-valuenow={window.usedPercent}
                                  aria-valuetext={`${window.usedPercent}% used, ${remaining}% remaining`}
                                >
                                  <i
                                    style={{
                                      width: `${window.usedPercent}%`,
                                    }}
                                  />
                                </span>
                                <small>
                                  {window.resetsAt
                                    ? `Resets ${formatArchivedSessionTime(
                                        window.resetsAt,
                                        language,
                                        timeZone,
                                      )}`
                                    : `${window.usedPercent}% used`}
                                </small>
                              </div>
                            );
                          })}
                          {limit.individualLimit ? (
                            <div className="codex-spend-limit">
                              <span>Workspace usage</span>
                              <strong>
                                {limit.individualLimit.used} /{" "}
                                {limit.individualLimit.limit}
                              </strong>
                              <small>
                                {limit.individualLimit.remainingPercent}%
                                remaining · resets{" "}
                                {formatArchivedSessionTime(
                                  limit.individualLimit.resetsAt,
                                  language,
                                  timeZone,
                                )}
                              </small>
                            </div>
                          ) : null}
                          {limit.credits ? (
                            <div className="codex-credit-balance">
                              <span>Credits</span>
                              <strong>
                                {limit.credits.unlimited
                                  ? "Unlimited"
                                  : limit.credits.balance ?? "Available"}
                              </strong>
                            </div>
                          ) : null}
                        </div>
                      ))}

                      {codexRateLimits &&
                      codexRateLimits.limits.length === 0 &&
                      !codexUsageError ? (
                        <p className="codex-usage-state">
                          Codex did not report a metered window for this account.
                        </p>
                      ) : null}

                      {codexRateLimits ? (
                        <footer>
                          Updated{" "}
                          {formatArchivedSessionTime(
                            codexRateLimits.fetchedAt,
                            language,
                            timeZone,
                          )}
                          . Separate from the Sandpi Team plan.
                        </footer>
                      ) : null}
                    </section>
                  </div>
                ) : null}

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
                {codexEnvironmentRefreshError ? (
                  <p className="settings-inline-error" role="alert">
                    {codexEnvironmentRefreshError}
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

            {activeTab === "skills" ? (
              <SettingsSection
                eyebrow={`${draft.codingAgent.label} native capabilities`}
                title="Skills"
                description={`Skills are discovered and enabled by ${draft.codingAgent.label}. Their locations, metadata and activation rules are not normalized across coding agents.`}
              >
                {draft.codingAgent.harness === "codex" ? (
                  <CodexSkillsSettings environmentId={draft.id} />
                ) : (
                  <HarnessSettingsUnavailable agent={draft.codingAgent.label} />
                )}
              </SettingsSection>
            ) : null}

            {activeTab === "mcp" ? (
              <SettingsSection
                eyebrow={`${draft.codingAgent.label} native capabilities`}
                title="MCP servers"
                description={`MCP definitions and runtime status come directly from ${draft.codingAgent.label}. Sandpi keeps this configuration scoped to the Environment.`}
              >
                {draft.codingAgent.harness === "codex" ? (
                  <CodexMcpSettings environmentId={draft.id} />
                ) : (
                  <HarnessSettingsUnavailable agent={draft.codingAgent.label} />
                )}
              </SettingsSection>
            ) : null}

            {activeTab === "network" ? (
              <SettingsSection
                eyebrow="Environment runtime"
                title="Network policy"
                description="Choose the default outbound action, then add only the domain exceptions. The policy covers every Session in this Environment's shared Sandbox."
              >
                <fieldset className="network-mode-fieldset">
                  <legend>Default outbound access</legend>
                  <p>
                    Domain exceptions receive the opposite action. Unmatched
                    traffic always follows this default.
                  </p>
                  <div className="network-mode-grid">
                    {(
                      [
                        [
                          "block-all",
                          "Block by default",
                          "Only explicitly allowed domains can be reached.",
                          LockKeyhole,
                        ],
                        [
                          "allow-all",
                          "Allow by default",
                          "Every domain is reachable unless explicitly blocked.",
                          Globe2,
                        ],
                      ] as const
                    ).map(([mode, label, description, Icon]) => (
                      <label
                        key={mode}
                        className={`network-mode-option ${
                          draft.networkPolicy.mode === mode
                            ? "is-selected"
                            : pendingNetworkMode === mode
                              ? "is-pending"
                              : ""
                        }`}
                      >
                        <input
                          className="sr-only"
                          type="radio"
                          name="network-mode"
                          value={mode}
                          checked={draft.networkPolicy.mode === mode}
                          onChange={() => requestNetworkMode(mode)}
                        />
                        <span className="network-mode-icon" aria-hidden="true">
                          <Icon size={17} />
                        </span>
                        <span className="radio-mark" aria-hidden="true" />
                        <strong>{label}</strong>
                        <p>{description}</p>
                        <code translate="no">{mode}</code>
                      </label>
                    ))}
                  </div>
                </fieldset>

                {pendingNetworkMode ? (
                  <div className="network-mode-confirmation" role="alert">
                    <TriangleAlert size={18} aria-hidden="true" />
                    <div>
                      <strong>
                        Clear {draft.networkPolicy.domainExceptions.length}{" "}
                        {domainActionPast}{" "}
                        {draft.networkPolicy.domainExceptions.length === 1
                          ? "domain"
                          : "domains"}
                        ?
                      </strong>
                      <p>
                        Switching to{" "}
                        {pendingNetworkMode === "block-all"
                          ? "Block by default"
                          : "Allow by default"}{" "}
                        cannot safely reinterpret the current exceptions.
                      </p>
                      <div className="network-mode-confirmation-actions">
                        <button
                          type="button"
                          onClick={() => setPendingNetworkMode(null)}
                        >
                          Keep current mode
                        </button>
                        <button
                          type="button"
                          className="is-primary"
                          onClick={confirmNetworkModeChange}
                        >
                          Switch & clear domains
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="settings-card domain-card">
                  <header>
                    <div>
                      <strong>{domainListTitle}</strong>
                      <p id="network-domain-description">
                        {domainDescription}
                      </p>
                    </div>
                    <span
                      className={`domain-action-badge ${
                        blocksByDefault ? "is-allow" : "is-block"
                      }`}
                    >
                      {blocksByDefault ? (
                        <Globe2 size={14} aria-hidden="true" />
                      ) : (
                        <LockKeyhole size={14} aria-hidden="true" />
                      )}
                      {blocksByDefault ? "Allow exceptions" : "Block exceptions"}
                    </span>
                  </header>
                  {draft.networkPolicy.domainExceptions.length > 0 ? (
                    <div className="domain-list">
                      {draft.networkPolicy.domainExceptions.map((domain) => (
                        <span key={domain}>
                          <code title={domain} translate="no">
                            {domain}
                          </code>
                          <button
                            type="button"
                            aria-label={`Remove ${domain}`}
                            onClick={() => {
                              setDraft((current) => ({
                                ...current,
                                networkPolicy: {
                                  ...current.networkPolicy,
                                  domainExceptions:
                                    current.networkPolicy.domainExceptions.filter(
                                      (item) => item !== domain,
                                    ),
                                },
                              }));
                              setDomainError("");
                              setPendingNetworkMode(null);
                            }}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="domain-empty-state">{domainEmptyState}</p>
                  )}
                  <div className="add-domain-row">
                    <label
                      className="sr-only"
                      htmlFor="network-domain-exception"
                    >
                      Domain to {domainAction}
                    </label>
                    <input
                      id="network-domain-exception"
                      name="network-domain-exception"
                      autoComplete="off"
                      spellCheck={false}
                      value={newDomain}
                      aria-invalid={domainError ? "true" : undefined}
                      aria-describedby={
                        domainError
                          ? "network-domain-error"
                          : "network-domain-description"
                      }
                      onChange={(event) => {
                        setNewDomain(event.target.value);
                        setDomainError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addDomain();
                        }
                      }}
                      placeholder="example.com or *.example.com…"
                    />
                    <button type="button" onClick={addDomain}>
                      <Plus size={14} aria-hidden="true" />{" "}
                      {blocksByDefault ? "Allow domain" : "Block domain"}
                    </button>
                  </div>
                  {domainError ? (
                    <p
                      id="network-domain-error"
                      className="domain-input-error"
                      role="alert"
                    >
                      {domainError}
                    </p>
                  ) : null}
                </div>
                <p className="network-audit-note">
                  <ShieldCheck size={14} aria-hidden="true" />
                  Network decisions appear in Environment Audit. Audit
                  collection is an Environment capability, not a policy toggle.
                </p>
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
            ) : pendingNetworkMode ? (
              <>Confirm or cancel the pending Network mode change.</>
            ) : activeTab === "audit" ? (
              hasUnsavedChanges ? (
                <>Pending Environment changes will be saved when you finish.</>
              ) : (
                <>Environment audit records are read-only.</>
              )
            ) : activeTab === "skills" || activeTab === "mcp" ? (
              <>{draft.codingAgent.label} changes are saved immediately.</>
            ) : activeTab === "network" ? (
              <>Network changes apply to every Session in this Environment.</>
            ) : (
              <>Changes apply to future Session forks.</>
            )}
          </span>
          <div>
            {activeTab === "audit" ? (
              <button
                type="button"
                className="button-primary"
                disabled={
                  saving ||
                  deleting ||
                  deleteConfirming ||
                  pendingNetworkMode !== null ||
                  (hasUnsavedChanges && !draft.name.trim())
                }
                onClick={() => {
                  if (hasUnsavedChanges) {
                    void saveAndClose();
                  } else {
                    onClose();
                  }
                }}
              >
                {saving ? "Saving…" : "Done"}
              </button>
            ) : activeTab === "skills" || activeTab === "mcp" ? (
              <button type="button" className="button-primary" onClick={onClose}>
                Done
              </button>
            ) : (
              <>
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
                    saving ||
                    deleting ||
                    deleteConfirming ||
                    pendingNetworkMode !== null ||
                    !draft.name.trim()
                  }
                  onClick={() => void saveAndClose()}
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </>
            )}
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

function HarnessSettingsUnavailable({ agent }: { agent: string }) {
  return (
    <div className="archived-sessions-empty">
      <span aria-hidden="true">
        <TriangleAlert size={20} />
      </span>
      <strong>{agent} settings are not available yet</strong>
      <p>
        This harness will provide its own native Skills and MCP implementation.
      </p>
    </div>
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
