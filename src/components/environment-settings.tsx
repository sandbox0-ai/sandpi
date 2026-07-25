"use client";

import {
  Archive,
  Box,
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

import { EnvironmentEgressCredentials } from "@/components/environment-egress-credentials";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { copyTextToClipboard } from "@/lib/clipboard";
import { MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS } from "@/lib/environment-lifecycle";
import { ENVIRONMENT_SANDBOX_MEMORY_OPTIONS_MIB } from "@/lib/environment-resources";
import {
  ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS,
  ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS,
} from "@/lib/environment-workspace-backup";
import {
  CodexMcpSettings,
  CodexSkillsSettings,
} from "@/harnesses/codex/environment-settings";
import type {
  CodexAccountPlanType,
  CodexAccountRateLimits,
  CodexAccountSummary,
  CodexRateLimitResetResult,
  CodexRateLimitWindow,
} from "@/harnesses/codex/environment-tools";
import { createId } from "@/lib/id";
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
  EnvironmentWorkspaceBackup,
  NetworkPolicy,
} from "@/lib/types";

export type EnvironmentSettingsTab =
  | "general"
  | "sandbox"
  | "archived-sessions"
  | "credentials"
  | "skills"
  | "mcp"
  | "egress-credentials"
  | "network";

interface EnvironmentSettingsProps {
  environment: Environment;
  initialTab?: EnvironmentSettingsTab;
  language: OperationLanguage;
  timeZone: string;
  archivedSessions: CodingSession[];
  onChange: (environment: Environment) => void;
  onWorkspaceRestore: (environment: Environment) => void;
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
  { id: "sandbox", label: "Sandbox", icon: Box },
  { id: "archived-sessions", label: "Archived sessions", icon: Archive },
  { id: "credentials", label: "Agent harness", icon: KeyRound },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP servers", icon: Cable },
  { id: "egress-credentials", label: "Credentials", icon: ShieldCheck },
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

function formatWorkspaceBackupSize(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) {
    return `${Math.round(sizeBytes / 1024)} KiB`;
  }
  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
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

export function EnvironmentSettings({
  environment,
  initialTab = "general",
  language,
  timeZone,
  archivedSessions,
  onChange,
  onWorkspaceRestore,
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
  const [workspaceBackups, setWorkspaceBackups] = useState<
    EnvironmentWorkspaceBackup[]
  >([]);
  const [workspaceBackupsLoading, setWorkspaceBackupsLoading] = useState(false);
  const [workspaceBackupBusy, setWorkspaceBackupBusy] = useState(false);
  const [workspaceBackupError, setWorkspaceBackupError] = useState("");
  const [workspaceRestoreBackup, setWorkspaceRestoreBackup] =
    useState<EnvironmentWorkspaceBackup | null>(null);
  const [workspaceRestoreName, setWorkspaceRestoreName] = useState("");
  const [workspaceRestoreBusy, setWorkspaceRestoreBusy] = useState(false);
  const [workspaceRestoreSuccess, setWorkspaceRestoreSuccess] = useState("");
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
  const [codexUsageResetConfirming, setCodexUsageResetConfirming] =
    useState(false);
  const [codexUsageResetBusy, setCodexUsageResetBusy] = useState(false);
  const [codexUsageResetMessage, setCodexUsageResetMessage] = useState("");
  const [codexUsageResetError, setCodexUsageResetError] = useState("");
  const [codexEnvironmentRefreshError, setCodexEnvironmentRefreshError] =
    useState("");
  const [codexAccountReload, setCodexAccountReload] = useState(0);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dangerZoneRef = useRef<HTMLDivElement>(null);
  const codexUsageResetIdempotencyKeyRef = useRef<string | null>(null);
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
    setWorkspaceBackups([]);
    setWorkspaceBackupError("");
    setWorkspaceRestoreBackup(null);
    setWorkspaceRestoreName("");
    setWorkspaceRestoreSuccess("");
  }, [environment.id, initialTab]);

  useEffect(() => {
    if (activeTab !== "sandbox") return;
    const controller = new AbortController();
    setWorkspaceBackupsLoading(true);
    setWorkspaceBackupError("");
    void apiFetch<ApiEnvelope<EnvironmentWorkspaceBackup[]>>(
      `/api/v1/environments/${encodeURIComponent(environment.id)}/workspace-backups`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!controller.signal.aborted) setWorkspaceBackups(response.data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setWorkspaceBackupError(
            error instanceof Error
              ? error.message
              : "Workspace backups could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorkspaceBackupsLoading(false);
      });
    return () => controller.abort();
  }, [activeTab, environment.id]);

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
    setCodexUsageResetConfirming(false);
    setCodexUsageResetBusy(false);
    setCodexUsageResetMessage("");
    setCodexUsageResetError("");
    codexUsageResetIdempotencyKeyRef.current = null;
  }, [environment.id]);

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

  async function resetCodexUsageLimits() {
    if (codexUsageResetBusy || !codexUsageResetConfirming) return;
    const idempotencyKey =
      codexUsageResetIdempotencyKeyRef.current ??
      createId("codex-usage-reset", 24);
    codexUsageResetIdempotencyKeyRef.current = idempotencyKey;
    setCodexUsageResetBusy(true);
    setCodexUsageResetError("");
    setCodexUsageResetMessage("");
    try {
      const response = await apiFetch<
        ApiEnvelope<CodexRateLimitResetResult>
      >(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/rate-limits/reset`,
        {
          method: "PUT",
          body: JSON.stringify({ idempotencyKey }),
        },
      );
      const messages: Record<CodexRateLimitResetResult["outcome"], string> = {
        reset: "Codex usage limits were reset.",
        nothingToReset: "No current usage window was eligible for reset.",
        noCredit: "No Codex reset credit is available.",
        alreadyRedeemed: "This usage reset was already applied.",
      };
      setCodexUsageResetMessage(messages[response.data.outcome]);
      setCodexUsageResetConfirming(false);
      codexUsageResetIdempotencyKeyRef.current = null;
      setCodexAccountReload((current) => current + 1);
    } catch (error) {
      setCodexUsageResetError(
        error instanceof Error
          ? error.message
          : "Codex usage limits could not be reset.",
      );
    } finally {
      setCodexUsageResetBusy(false);
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
            idlePauseTimeoutSeconds: draft.idlePauseTimeoutSeconds,
            sandboxMemoryMiB: draft.sandboxMemoryMiB,
            workspaceBackup: {
              intervalSeconds: draft.workspaceBackup.intervalSeconds,
              retentionCount: draft.workspaceBackup.retentionCount,
            },
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

  async function createWorkspaceBackup() {
    if (workspaceBackupBusy || workspaceRestoreBusy) return;
    setWorkspaceBackupBusy(true);
    setWorkspaceBackupError("");
    try {
      const response = await apiFetch<
        ApiEnvelope<{
          backup: EnvironmentWorkspaceBackup;
          environment: Environment;
        }>
      >(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/workspace-backups`,
        { method: "POST" },
      );
      setWorkspaceBackups((current) => [
        response.data.backup,
        ...current.filter(
          (backup) => backup.id !== response.data.backup.id,
        ),
      ]);
      setDraft((current) => ({
        ...current,
        workspaceBackup: response.data.environment.workspaceBackup,
      }));
      onChange(response.data.environment);
    } catch (error) {
      setWorkspaceBackupError(
        error instanceof Error
          ? error.message
          : "The Workspace backup could not be created.",
      );
    } finally {
      setWorkspaceBackupBusy(false);
    }
  }

  async function restoreWorkspaceBackup() {
    if (
      !workspaceRestoreBackup ||
      workspaceRestoreBusy ||
      workspaceRestoreName !== environment.name
    ) {
      return;
    }
    setWorkspaceRestoreBusy(true);
    setWorkspaceBackupError("");
    setWorkspaceRestoreSuccess("");
    try {
      const response = await apiFetch<
        ApiEnvelope<{
          backup: EnvironmentWorkspaceBackup;
          environment: Environment;
          unavailableSessionCount: number;
        }>
      >(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/workspace-backups/${encodeURIComponent(workspaceRestoreBackup.id)}/restore`,
        {
          method: "PUT",
          body: JSON.stringify({ confirmation: workspaceRestoreName }),
        },
      );
      setDraft((current) => ({
        ...response.data.environment,
        name: current.name,
        description: current.description,
        color: current.color,
        idlePauseTimeoutSeconds: current.idlePauseTimeoutSeconds,
        sandboxMemoryMiB: current.sandboxMemoryMiB,
        workspaceBackup: {
          ...response.data.environment.workspaceBackup,
          intervalSeconds: current.workspaceBackup.intervalSeconds,
          retentionCount: current.workspaceBackup.retentionCount,
        },
        networkPolicy: current.networkPolicy,
      }));
      onWorkspaceRestore(response.data.environment);
      setWorkspaceRestoreBackup(null);
      setWorkspaceRestoreName("");
      setWorkspaceRestoreSuccess(
        response.data.unavailableSessionCount > 0
          ? `Workspace restored. ${response.data.unavailableSessionCount} newer ${response.data.unavailableSessionCount === 1 ? "Session is" : "Sessions are"} unavailable because their native harness state was created after this backup.`
          : "Workspace restored. The shared Sandbox is ready with the selected backup.",
      );
    } catch (error) {
      setWorkspaceBackupError(
        error instanceof Error
          ? error.message
          : "The Workspace backup could not be restored.",
      );
    } finally {
      setWorkspaceRestoreBusy(false);
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
  const codexUsageResetCreditCount =
    codexRateLimits?.resetCredits?.availableCount;

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
                  <DefinitionRow
                    label="Current revision"
                    value={`r${draft.revision}`}
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

            {activeTab === "sandbox" ? (
              <SettingsSection
                eyebrow="Environment runtime"
                title="Sandbox"
                description="Configure lifecycle and resources for the shared Sandbox used by every Session in this Environment."
              >
                <label className="full-field">
                  Auto-pause after idle (minutes)
                  <input
                    type="number"
                    name="environment-idle-pause-timeout"
                    aria-label="Environment auto-pause timeout in minutes"
                    min={0}
                    max={MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS / 60}
                    step={1}
                    value={draft.idlePauseTimeoutSeconds / 60}
                    onChange={(event) => {
                      const minutes = event.currentTarget.valueAsNumber;
                      if (!Number.isFinite(minutes)) return;
                      setDraft((current) => ({
                        ...current,
                        idlePauseTimeoutSeconds:
                          Math.min(
                            MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS / 60,
                            Math.max(0, Math.round(minutes)),
                          ) * 60,
                      }));
                    }}
                  />
                  <small>
                    Sandpi pauses the shared Sandbox after this much idle time.
                    Set 0 to keep it running with no time limit.
                  </small>
                </label>
                <label className="full-field">
                  Sandbox memory
                  <select
                    name="environment-sandbox-memory"
                    aria-label="Environment Sandbox memory"
                    value={draft.sandboxMemoryMiB}
                    onChange={(event) => {
                      const memoryMiB = Number(event.currentTarget.value);
                      if (
                        !ENVIRONMENT_SANDBOX_MEMORY_OPTIONS_MIB.some(
                          (optionMiB) => optionMiB === memoryMiB,
                        )
                      ) {
                        return;
                      }
                      setDraft((current) => ({
                        ...current,
                        sandboxMemoryMiB: memoryMiB,
                      }));
                    }}
                  >
                    {ENVIRONMENT_SANDBOX_MEMORY_OPTIONS_MIB.map((memoryMiB) => (
                      <option key={memoryMiB} value={memoryMiB}>
                        {memoryMiB < 1024
                          ? `${memoryMiB} MiB`
                          : `${memoryMiB / 1024} GiB`}
                      </option>
                    ))}
                  </select>
                  <small>
                    Applies immediately to the shared Sandbox. Sandbox0 derives
                    CPU capacity from the configured memory ratio.
                  </small>
                </label>
                <div className="settings-card workspace-backup-card">
                  <div className="workspace-backup-heading">
                    <div>
                      <strong>Workspace backups</strong>
                      <p>
                        Create native snapshots of the shared Workspace Volume.
                        Retention removes only snapshots created by Sandpi.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="secondary-action-button"
                      disabled={
                        workspaceBackupBusy ||
                        workspaceRestoreBusy ||
                        draft.status !== "ready" ||
                        !draft.workspaceVolumeId
                      }
                      onClick={() => void createWorkspaceBackup()}
                    >
                      <RefreshCw
                        size={13}
                        className={workspaceBackupBusy ? "is-spinning" : undefined}
                        aria-hidden="true"
                      />
                      {workspaceBackupBusy ? "Backing up…" : "Back up now"}
                    </button>
                  </div>
                  <div className="workspace-backup-fields">
                    <label className="full-field">
                      Automatic backup frequency
                      <select
                        name="environment-workspace-backup-interval"
                        aria-label="Workspace backup frequency"
                        value={draft.workspaceBackup.intervalSeconds}
                        onChange={(event) => {
                          const intervalSeconds = Number(
                            event.currentTarget.value,
                          );
                          if (
                            !ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS.some(
                              (option) => option.seconds === intervalSeconds,
                            )
                          ) {
                            return;
                          }
                          setDraft((current) => ({
                            ...current,
                            workspaceBackup: {
                              ...current.workspaceBackup,
                              intervalSeconds,
                            },
                          }));
                        }}
                      >
                        {ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS.map(
                          (option) => (
                            <option key={option.seconds} value={option.seconds}>
                              {option.label}
                            </option>
                          ),
                        )}
                      </select>
                      <small>
                        Off disables scheduled backups; manual backups remain
                        available.
                      </small>
                    </label>
                    <label className="full-field">
                      Retention
                      <select
                        name="environment-workspace-backup-retention"
                        aria-label="Workspace backup retention"
                        value={draft.workspaceBackup.retentionCount}
                        onChange={(event) => {
                          const retentionCount = Number(
                            event.currentTarget.value,
                          );
                          if (
                            !ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS.some(
                              (option) => option === retentionCount,
                            )
                          ) {
                            return;
                          }
                          setDraft((current) => ({
                            ...current,
                            workspaceBackup: {
                              ...current.workspaceBackup,
                              retentionCount,
                            },
                          }));
                        }}
                      >
                        {ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS.map(
                          (retentionCount) => (
                            <option key={retentionCount} value={retentionCount}>
                              Keep {retentionCount}{" "}
                              {retentionCount === 1 ? "backup" : "backups"}
                            </option>
                          ),
                        )}
                      </select>
                      <small>
                        Applies to both automatic and manual Sandpi backups.
                      </small>
                    </label>
                  </div>
                  <div className="workspace-backup-status" aria-live="polite">
                    <span>
                      <small>Last backup</small>
                      <strong>
                        {draft.workspaceBackup.lastBackupAt
                          ? formatArchivedSessionTime(
                              draft.workspaceBackup.lastBackupAt,
                              language,
                              timeZone,
                            )
                          : "No backup yet"}
                      </strong>
                    </span>
                    <span>
                      <small>Next backup</small>
                      <strong>
                        {draft.workspaceBackup.intervalSeconds === 0
                          ? "Scheduled backups off"
                          : draft.workspaceBackup.nextBackupAt
                            ? formatArchivedSessionTime(
                                draft.workspaceBackup.nextBackupAt,
                                language,
                                timeZone,
                              )
                            : "Scheduling…"}
                      </strong>
                    </span>
                  </div>
                  {workspaceBackupError ? (
                    <p className="settings-inline-error" role="alert">
                      {workspaceBackupError}
                    </p>
                  ) : draft.workspaceBackup.lastError ? (
                    <p className="settings-inline-error" role="alert">
                      {draft.workspaceBackup.lastError}
                    </p>
                  ) : null}
                  {workspaceBackupsLoading ? (
                    <p className="workspace-backup-empty">Loading backups…</p>
                  ) : workspaceBackups.length > 0 ? (
                    <div
                      className="workspace-backup-list"
                      aria-label="Workspace backups"
                    >
                      {workspaceBackups.slice(0, 7).map((backup) => (
                        <div key={backup.id} className="workspace-backup-row">
                          <span>
                            <strong>
                              {backup.kind === "automatic"
                                ? "Automatic backup"
                                : "Manual backup"}
                            </strong>
                            <time dateTime={unixTimestampToIso(backup.createdAt)}>
                              {formatArchivedSessionTime(
                                backup.createdAt,
                                language,
                                timeZone,
                              )}
                            </time>
                          </span>
                          <div className="workspace-backup-row-actions">
                            <code>
                              {formatWorkspaceBackupSize(backup.sizeBytes)}
                            </code>
                            <button
                              type="button"
                              className="workspace-backup-restore-button"
                              aria-label={`Restore backup from ${formatArchivedSessionTime(
                                backup.createdAt,
                                language,
                                timeZone,
                              )}`}
                              disabled={
                                workspaceBackupBusy || workspaceRestoreBusy
                              }
                              onClick={() => {
                                setWorkspaceRestoreBackup(backup);
                                setWorkspaceRestoreName("");
                                setWorkspaceBackupError("");
                                setWorkspaceRestoreSuccess("");
                              }}
                            >
                              <RotateCcw size={12} aria-hidden="true" />
                              Restore
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="workspace-backup-empty">
                      No Sandpi Workspace backups yet.
                    </p>
                  )}
                  {workspaceRestoreBackup ? (
                    <div
                      className="workspace-backup-restore-confirm"
                      role="group"
                      aria-label="Confirm Workspace restore"
                    >
                      <div>
                        <TriangleAlert size={16} aria-hidden="true" />
                        <span>
                          <strong>Restore the entire shared Workspace?</strong>
                          <small>
                            Sandpi pauses the Sandbox and rolls every Workspace
                            file plus Agent Harness state back to this backup.
                            Sessions created after it will become unavailable.
                            This cannot be undone unless you have a newer backup.
                          </small>
                        </span>
                      </div>
                      <label className="full-field">
                        Type <code>{environment.name}</code> to confirm
                        <input
                          name="environment-workspace-restore-confirmation"
                          aria-label="Environment name confirmation for Workspace restore"
                          autoComplete="off"
                          value={workspaceRestoreName}
                          disabled={workspaceRestoreBusy}
                          onChange={(event) =>
                            setWorkspaceRestoreName(event.currentTarget.value)
                          }
                        />
                      </label>
                      <div className="workspace-backup-restore-actions">
                        <button
                          type="button"
                          className="secondary-action-button"
                          disabled={workspaceRestoreBusy}
                          onClick={() => {
                            setWorkspaceRestoreBackup(null);
                            setWorkspaceRestoreName("");
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="workspace-backup-restore-submit"
                          disabled={
                            workspaceRestoreBusy ||
                            workspaceRestoreName !== environment.name
                          }
                          onClick={() => void restoreWorkspaceBackup()}
                        >
                          <RotateCcw
                            size={13}
                            className={
                              workspaceRestoreBusy ? "is-spinning" : undefined
                            }
                            aria-hidden="true"
                          />
                          {workspaceRestoreBusy
                            ? "Restoring Workspace…"
                            : "Restore Workspace"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {workspaceRestoreSuccess ? (
                    <p className="settings-inline-success" role="status">
                      {workspaceRestoreSuccess}
                    </p>
                  ) : null}
                </div>
                <div className="settings-card definition-card">
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
                title="Agent harness & account"
                description="The agent harness is selected when an Environment is created. Every Session inherits that harness and its pinned official authentication state."
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
                        <div className="codex-usage-actions">
                          {codexUsageResetCreditCount !== undefined ? (
                            <button
                              type="button"
                              className="text-action-button"
                              aria-label={`Reset Codex usage (${codexUsageResetCreditCount} reset ${
                                codexUsageResetCreditCount === 1
                                  ? "credit"
                                  : "credits"
                              } available)`}
                              title={
                                codexUsageResetCreditCount > 0
                                  ? "Use one Codex reset credit"
                                  : "No Codex reset credits are available"
                              }
                              disabled={
                                codexUsageLoading ||
                                codexUsageResetBusy ||
                                codexUsageResetCreditCount === 0
                              }
                              onClick={() => {
                                codexUsageResetIdempotencyKeyRef.current =
                                  createId("codex-usage-reset", 24);
                                setCodexUsageResetError("");
                                setCodexUsageResetMessage("");
                                setCodexUsageResetConfirming(true);
                              }}
                            >
                              <RotateCcw size={12} aria-hidden="true" />
                              Reset · {codexUsageResetCreditCount}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Refresh Codex usage"
                            title="Refresh Codex usage"
                            disabled={
                              codexUsageLoading || codexUsageResetBusy
                            }
                            onClick={() =>
                              setCodexAccountReload((current) => current + 1)
                            }
                          >
                            <RefreshCw
                              className={
                                codexUsageLoading ? "is-spinning" : ""
                              }
                              size={14}
                              aria-hidden="true"
                            />
                          </button>
                        </div>
                      </header>

                      {codexUsageResetConfirming ? (
                        <div
                          className="codex-usage-reset-confirmation"
                          role="group"
                          aria-labelledby="codex-usage-reset-title"
                        >
                          <div>
                            <strong id="codex-usage-reset-title">
                              Reset Codex usage limits?
                            </strong>
                            <p>
                              This consumes one native Codex reset credit and
                              resets every currently eligible usage window.
                            </p>
                          </div>
                          <div>
                            <button
                              type="button"
                              className="text-action-button"
                              disabled={codexUsageResetBusy}
                              onClick={() => {
                                setCodexUsageResetConfirming(false);
                                setCodexUsageResetError("");
                                codexUsageResetIdempotencyKeyRef.current = null;
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="secondary-action-button"
                              disabled={codexUsageResetBusy}
                              onClick={() => void resetCodexUsageLimits()}
                            >
                              {codexUsageResetBusy ? (
                                <span
                                  className="activity-spinner"
                                  aria-hidden="true"
                                />
                              ) : (
                                <RotateCcw size={12} aria-hidden="true" />
                              )}
                              Use reset credit
                            </button>
                          </div>
                          {codexUsageResetError ? (
                            <p
                              className="codex-usage-reset-error"
                              role="alert"
                            >
                              {codexUsageResetError}
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {codexUsageResetMessage ? (
                        <p className="codex-usage-reset-notice" role="status">
                          {codexUsageResetMessage}
                        </p>
                      ) : null}

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
                          . Reported directly by the connected Codex account.
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
                description={`MCP definitions and runtime status come directly from ${draft.codingAgent.label}. Sandpi only mirrors the native inventory and user-layer enablement.`}
              >
                {draft.codingAgent.harness === "codex" ? (
                  <CodexMcpSettings environmentId={draft.id} />
                ) : (
                  <HarnessSettingsUnavailable agent={draft.codingAgent.label} />
                )}
              </SettingsSection>
            ) : null}

            {activeTab === "egress-credentials" ? (
              <SettingsSection
                eyebrow="Environment runtime"
                title="Credentials"
                description="Attach write-only credentials to exact outbound destinations for every Session in this Environment's shared Sandbox."
              >
                <EnvironmentEgressCredentials
                  environmentId={draft.id}
                  environmentStatus={draft.status}
                />
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
            ) : activeTab === "egress-credentials" ? (
              <>Credential changes are applied immediately.</>
            ) : activeTab === "skills" || activeTab === "mcp" ? (
              <>{draft.codingAgent.label} changes are saved immediately.</>
            ) : activeTab === "network" ? (
              <>Network changes apply to every Session in this Environment.</>
            ) : (
              <>Changes apply to this Environment and its shared Sandbox.</>
            )}
          </span>
          <div>
            {activeTab === "skills" ||
            activeTab === "mcp" ||
            activeTab === "egress-credentials" ? (
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
