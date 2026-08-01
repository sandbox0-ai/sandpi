"use client";

import {
  ChevronDown,
  ChevronUp,
  Copy,
  Github,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { OperationLanguage } from "@/lib/operation-ui";
import { formatUnixTimestamp } from "@/lib/time";
import {
  DEFAULT_GITHUB_WEBHOOK_EVENT_TYPES,
  GITHUB_WEBHOOK_EVENT_TYPES,
} from "@/lib/github-webhooks";
import type {
  CodingSession,
  EnvironmentWebhook,
  EnvironmentWebhookCondition,
  EnvironmentWebhookDelivery,
  EnvironmentWebhookRun,
  EnvironmentWebhookSetup,
  GitHubWebhookConnectionInventory,
} from "@/lib/types";
import shared from "./environment-schedules.module.css";
import styles from "./environment-webhooks.module.css";

interface EnvironmentWebhooksProps {
  environmentId: string;
  sessions: CodingSession[];
  language: OperationLanguage;
  timeZone: string;
}

interface WebhookDraft {
  id?: string;
  sourceKind: "custom" | "github";
  githubConnectionId: string;
  githubRepositoryIds: string[];
  name: string;
  secret: string;
  prompt: string;
  eventTypes: string;
  conditions: string;
  triggerMode: "every" | "stateChange";
  statePath: string;
  groupKeyPath: string;
  cooldownMode: "none" | "throttle" | "debounce" | "batch";
  cooldownSeconds: number;
  cooldownBehavior: "suppress" | "latest" | "merge";
  targetKind: "newSession" | "sourceThread" | "session";
  targetSessionId: string;
  overlapPolicy: "queue" | "skip";
  maxConcurrentRuns: number;
  maxPendingRuns: number;
  enabled: boolean;
  title?: string;
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
}

interface WebhookHistory {
  runs: EnvironmentWebhookRun[];
  deliveries: EnvironmentWebhookDelivery[];
}

const REFRESH_INTERVAL_MS = 10_000;

export function EnvironmentWebhooks({
  environmentId,
  sessions,
  language,
  timeZone,
}: EnvironmentWebhooksProps) {
  const [webhooks, setWebhooks] = useState<EnvironmentWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<WebhookDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [setup, setSetup] = useState<EnvironmentWebhookSetup>();
  const [copied, setCopied] = useState<string>();
  const [busyWebhookId, setBusyWebhookId] = useState<string>();
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string>();
  const [historyWebhookId, setHistoryWebhookId] = useState<string>();
  const [history, setHistory] = useState<Record<string, WebhookHistory>>({});
  const [historyLoadingId, setHistoryLoadingId] = useState<string>();
  const [githubInventory, setGitHubInventory] =
    useState<GitHubWebhookConnectionInventory>();
  const [githubLoading, setGitHubLoading] = useState(false);
  const [githubError, setGitHubError] = useState("");
  const [githubInstalling, setGitHubInstalling] = useState(false);
  const [busyGitHubConnectionId, setBusyGitHubConnectionId] =
    useState<string>();
  const githubInstallPopup = useRef<Window | null>(null);
  const availableSessions = useMemo(
    () =>
      sessions
        .filter((session) => !session.archived)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [sessions],
  );

  const loadWebhooks = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const response = await apiFetch<ApiEnvelope<EnvironmentWebhook[]>>(
          webhookCollectionPath(environmentId),
        );
        setWebhooks(response.data);
        setLoadError("");
      } catch (error) {
        setLoadError(errorMessage(error, "Webhooks could not be loaded."));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [environmentId],
  );

  const loadHistory = useCallback(
    async (webhookId: string, quiet = false) => {
      if (!quiet) setHistoryLoadingId(webhookId);
      try {
        const base = webhookPath(environmentId, webhookId);
        const [runs, deliveries] = await Promise.all([
          apiFetch<ApiEnvelope<EnvironmentWebhookRun[]>>(
            `${base}/runs?limit=20`,
          ),
          apiFetch<ApiEnvelope<EnvironmentWebhookDelivery[]>>(
            `${base}/deliveries?limit=20`,
          ),
        ]);
        setHistory((current) => ({
          ...current,
          [webhookId]: { runs: runs.data, deliveries: deliveries.data },
        }));
        setLoadError("");
      } catch (error) {
        setLoadError(errorMessage(error, "Webhook history could not be loaded."));
      } finally {
        if (!quiet) setHistoryLoadingId(undefined);
      }
    },
    [environmentId],
  );

  const loadGitHubConnections = useCallback(async () => {
    setGitHubLoading(true);
    try {
      const response = await apiFetch<
        ApiEnvelope<GitHubWebhookConnectionInventory>
      >(githubWebhookSourcePath(environmentId));
      setGitHubInventory(response.data);
      setGitHubError("");
    } catch (error) {
      setGitHubError(
        errorMessage(error, "GitHub connections could not be loaded."),
      );
    } finally {
      setGitHubLoading(false);
    }
  }, [environmentId]);

  useEffect(() => {
    setWebhooks([]);
    setDraft(null);
    setSetup(undefined);
    setHistory({});
    setHistoryWebhookId(undefined);
    void loadWebhooks();
    void loadGitHubConnections();
    const timer = window.setInterval(() => void loadWebhooks(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [environmentId, loadGitHubConnections, loadWebhooks]);

  useEffect(() => {
    if (!githubInstalling) return;
    const complete = () => {
      setGitHubInstalling(false);
      githubInstallPopup.current = null;
      void loadGitHubConnections();
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.data?.type === "sandpi:github-webhook-connected"
      ) {
        complete();
      }
    };
    window.addEventListener("message", onMessage);
    const timer = window.setInterval(() => {
      if (githubInstallPopup.current?.closed) complete();
    }, 500);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
    };
  }, [githubInstalling, loadGitHubConnections]);

  useEffect(() => {
    if (!historyWebhookId) return;
    const timer = window.setInterval(
      () => void loadHistory(historyWebhookId, true),
      REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [historyWebhookId, loadHistory]);

  async function copy(label: string, value: string) {
    try {
      await copyTextToClipboard(value);
      setCopied(label);
      window.setTimeout(() => setCopied(undefined), 1_500);
    } catch (error) {
      setLoadError(errorMessage(error, "The value could not be copied."));
    }
  }

  async function saveDraft() {
    if (!draft || saving) return;
    const creating = !draft.id;
    setFormError("");
    const payload = webhookDraftPayload(draft);
    if ("error" in payload) {
      setFormError(payload.error);
      return;
    }
    setSaving(true);
    try {
      const path = draft.id
        ? webhookPath(environmentId, draft.id)
        : webhookCollectionPath(environmentId);
      const response = await apiFetch<ApiEnvelope<EnvironmentWebhookSetup>>(
        path,
        {
          method: draft.id ? "PUT" : "POST",
          body: JSON.stringify(payload.value),
        },
      );
      setSetup(
        creating || response.data.setupSecret ? response.data : undefined,
      );
      setDraft(null);
      await loadWebhooks(true);
    } catch (error) {
      setFormError(errorMessage(error, "The Webhook could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  async function connectGitHub() {
    if (githubInstalling) return;
    const popup = window.open(
      "about:blank",
      "sandpi-github-webhook-install",
      "popup,width=760,height=820",
    );
    if (!popup) {
      setGitHubError("Allow pop-ups for Sandpi, then try connecting GitHub again.");
      return;
    }
    githubInstallPopup.current = popup;
    setGitHubInstalling(true);
    setGitHubError("");
    try {
      const response = await apiFetch<
        ApiEnvelope<{ authorizationUrl: string; expiresAt: number }>
      >(`${githubWebhookSourcePath(environmentId)}/install`, { method: "POST" });
      popup.location.replace(response.data.authorizationUrl);
    } catch (error) {
      popup.close();
      githubInstallPopup.current = null;
      setGitHubInstalling(false);
      setGitHubError(errorMessage(error, "GitHub could not be connected."));
    }
  }

  async function disconnectGitHub(connectionId: string) {
    if (busyGitHubConnectionId) return;
    if (
      !window.confirm(
        "Disconnect this GitHub account? Webhooks using it will be disabled.",
      )
    ) {
      return;
    }
    setBusyGitHubConnectionId(connectionId);
    setGitHubError("");
    try {
      await apiFetch<ApiEnvelope<{ id: string }>>(
        `${githubWebhookSourcePath(environmentId)}/connections/${encodeURIComponent(connectionId)}`,
        { method: "DELETE" },
      );
      setDraft((current) =>
        current?.githubConnectionId === connectionId
          ? { ...current, githubConnectionId: "", githubRepositoryIds: [] }
          : current,
      );
      await Promise.all([loadGitHubConnections(), loadWebhooks(true)]);
    } catch (error) {
      setGitHubError(errorMessage(error, "GitHub could not be disconnected."));
    } finally {
      setBusyGitHubConnectionId(undefined);
    }
  }

  async function toggleWebhook(webhook: EnvironmentWebhook) {
    if (busyWebhookId) return;
    setBusyWebhookId(webhook.id);
    try {
      await apiFetch<ApiEnvelope<EnvironmentWebhookSetup>>(
        webhookPath(environmentId, webhook.id),
        {
          method: "PUT",
          body: JSON.stringify({
            ...editableWebhookPayload(webhook),
            enabled: !webhook.enabled,
          }),
        },
      );
      await loadWebhooks(true);
    } catch (error) {
      setLoadError(errorMessage(error, "The Webhook could not be updated."));
    } finally {
      setBusyWebhookId(undefined);
    }
  }

  async function deleteWebhook(webhookId: string) {
    if (busyWebhookId) return;
    setBusyWebhookId(webhookId);
    try {
      await apiFetch<ApiEnvelope<{ id: string }>>(
        webhookPath(environmentId, webhookId),
        { method: "DELETE" },
      );
      setConfirmingDeleteId(undefined);
      setHistoryWebhookId((current) =>
        current === webhookId ? undefined : current,
      );
      setSetup((current) =>
        current?.webhook.id === webhookId ? undefined : current,
      );
      await loadWebhooks(true);
    } catch (error) {
      setLoadError(errorMessage(error, "The Webhook could not be deleted."));
    } finally {
      setBusyWebhookId(undefined);
    }
  }

  return (
    <div className="codex-extension-panel">
      <div className="codex-extension-toolbar">
        <p>
          Connect GitHub directly or use an authenticated URL. Sandpi verifies,
          persists, filters, and cools down every delivery.
        </p>
        <div>
          <button
            type="button"
            className="secondary-action-button"
            onClick={() => {
              setDraft(emptyDraft(availableSessions[0]?.id));
              setSetup(undefined);
              setFormError("");
            }}
          >
            <Plus size={13} aria-hidden="true" />
            New Webhook
          </button>
        </div>
      </div>

      {loadError ? (
        <p className="settings-inline-error" role="alert">{loadError}</p>
      ) : null}

      {setup ? (
        <WebhookSetup
          setup={setup}
          copied={copied}
          onCopy={(label, value) => void copy(label, value)}
          onClose={() => setSetup(undefined)}
        />
      ) : null}

      {draft ? (
        <WebhookEditor
          draft={draft}
          sessions={availableSessions}
          githubInventory={githubInventory}
          githubLoading={githubLoading}
          githubInstalling={githubInstalling}
          githubError={githubError}
          busyGitHubConnectionId={busyGitHubConnectionId}
          saving={saving}
          error={formError}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
            setFormError("");
          }}
          onSave={() => void saveDraft()}
          onConnectGitHub={() => void connectGitHub()}
          onRefreshGitHub={() => void loadGitHubConnections()}
          onDisconnectGitHub={(connectionId) =>
            void disconnectGitHub(connectionId)
          }
        />
      ) : null}

      {loading ? (
        <div className="codex-extension-empty" aria-label="Loading Webhooks">
          <span><Webhook size={18} aria-hidden="true" /></span>
          <strong>Loading Webhooks…</strong>
        </div>
      ) : webhooks.length === 0 ? (
        <div className="codex-extension-empty">
          <span><Webhook size={18} aria-hidden="true" /></span>
          <strong>No Webhooks yet</strong>
          <p>Trigger a Codex task from any authenticated event source.</p>
        </div>
      ) : (
        <div className={shared.list}>
          {webhooks.map((webhook) => {
            const historyOpen = historyWebhookId === webhook.id;
            return (
              <article className={shared.card} key={webhook.id}>
                <div className={shared.cardHeader}>
                  <div className={shared.cardTitle}>
                    <span
                      className={`${shared.statusDot} ${
                        webhook.enabled ? shared.enabled : ""
                      }`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{webhook.name}</strong>
                      <span>{webhookSourceSummary(webhook)}</span>
                    </div>
                  </div>
                  <span className={`${shared.badge} ${webhook.enabled ? shared.badgeEnabled : ""}`}>
                    {webhook.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>

                <p className={shared.prompt}>{webhook.prompt}</p>
                <dl className={shared.facts}>
                  <div>
                    <dt>Trigger</dt>
                    <dd>{triggerSummary(webhook)}</dd>
                  </div>
                  <div>
                    <dt>Cooldown</dt>
                    <dd>{cooldownSummary(webhook)}</dd>
                  </div>
                  <div>
                    <dt>Last delivery</dt>
                    <dd>{webhook.lastDeliveryStatus ?? "—"}</dd>
                  </div>
                </dl>

                {webhook.lastError ? (
                  <p className={shared.runError}>{webhook.lastError}</p>
                ) : null}

                <div className={shared.actions}>
                  <button
                    type="button"
                    className="text-action-button"
                    onClick={() => {
                      if (historyOpen) setHistoryWebhookId(undefined);
                      else {
                        setHistoryWebhookId(webhook.id);
                        void loadHistory(webhook.id);
                      }
                    }}
                  >
                    {historyOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    Activity
                  </button>
                  {webhook.endpointUrl ? (
                    <button
                      type="button"
                      className="text-action-button"
                      onClick={() =>
                        void copy(`url-${webhook.id}`, webhook.endpointUrl!)
                      }
                    >
                      <Copy size={13} />
                      {copied === `url-${webhook.id}` ? "Copied" : "URL"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-action-button"
                    onClick={() => {
                      setDraft(webhookDraft(webhook));
                      setSetup(undefined);
                      setFormError("");
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-action-button"
                    disabled={Boolean(busyWebhookId)}
                    onClick={() => void toggleWebhook(webhook)}
                  >
                    {busyWebhookId === webhook.id
                      ? "Saving…"
                      : webhook.enabled ? "Disable" : "Enable"}
                  </button>
                  {confirmingDeleteId === webhook.id ? (
                    <>
                      <span className={shared.deletePrompt}>Delete permanently?</span>
                      <button
                        type="button"
                        className={shared.dangerButton}
                        disabled={Boolean(busyWebhookId)}
                        onClick={() => void deleteWebhook(webhook.id)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="text-action-button"
                        onClick={() => setConfirmingDeleteId(undefined)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="text-action-button"
                      aria-label={`Delete ${webhook.name}`}
                      onClick={() => setConfirmingDeleteId(webhook.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                {historyOpen ? (
                  <WebhookHistoryView
                    history={history[webhook.id]}
                    loading={historyLoadingId === webhook.id}
                    language={language}
                    timeZone={timeZone}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WebhookSetup({
  setup,
  copied,
  onCopy,
  onClose,
}: {
  setup: EnvironmentWebhookSetup;
  copied?: string;
  onCopy: (label: string, value: string) => void;
  onClose: () => void;
}) {
  const githubSource =
    setup.webhook.source.kind === "github" ? setup.webhook.source : undefined;
  return (
    <section className={styles.setup} aria-labelledby="webhook-setup-title">
      <header>
        <div>
          <span>Webhook setup</span>
          <strong id="webhook-setup-title">Configure the event source</strong>
        </div>
        <button type="button" className="icon-button" aria-label="Close setup" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>
      <p>
        {githubSource
          ? `GitHub events from ${githubSource.repositories.length} selected ${githubSource.repositories.length === 1 ? "repository" : "repositories"} are ready to route through ${githubSource.accountLogin}.`
          : "POST JSON, form, or text data with Authorization: Bearer <token>. X-Sandpi-Event can name the event type."}
      </p>
      {setup.webhook.endpointUrl ? (
        <CopyField
          label="Webhook URL"
          value={setup.webhook.endpointUrl}
          copied={copied === "setup-url"}
          onCopy={() => onCopy("setup-url", setup.webhook.endpointUrl!)}
        />
      ) : null}
      {setup.setupSecret ? (
        <>
          <CopyField
            label="Bearer token"
            value={setup.setupSecret}
            copied={copied === "setup-secret"}
            onCopy={() => onCopy("setup-secret", setup.setupSecret!)}
          />
          <p className={styles.oneTimeSecret}>
            This token is shown once. Store it in the event source now.
          </p>
        </>
      ) : null}
    </section>
  );
}

function CopyField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className={styles.copyField}>
      <span>{label}</span>
      <code>{value}</code>
      <button type="button" className="text-action-button" onClick={onCopy}>
        <Copy size={13} /> {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function WebhookEditor({
  draft,
  sessions,
  githubInventory,
  githubLoading,
  githubInstalling,
  githubError,
  busyGitHubConnectionId,
  saving,
  error,
  onChange,
  onCancel,
  onSave,
  onConnectGitHub,
  onRefreshGitHub,
  onDisconnectGitHub,
}: {
  draft: WebhookDraft;
  sessions: CodingSession[];
  githubInventory?: GitHubWebhookConnectionInventory;
  githubLoading: boolean;
  githubInstalling: boolean;
  githubError: string;
  busyGitHubConnectionId?: string;
  saving: boolean;
  error: string;
  onChange: (draft: WebhookDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onConnectGitHub: () => void;
  onRefreshGitHub: () => void;
  onDisconnectGitHub: (connectionId: string) => void;
}) {
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const connections = githubInventory?.connections ?? [];
  const selectedConnection = connections.find(
    (connection) => connection.id === draft.githubConnectionId,
  );
  const repositories = (selectedConnection?.repositories ?? []).filter(
    (repository) =>
      repository.fullName
        .toLocaleLowerCase()
        .includes(repositoryQuery.trim().toLocaleLowerCase()),
  );
  const selectedEventTypes = new Set(splitEventTypes(draft.eventTypes));
  return (
    <section className="environment-credential-editor" aria-labelledby="environment-webhook-editor-title">
      <header>
        <div>
          <span>{draft.id ? "Edit Webhook" : "New Webhook"}</span>
          <strong id="environment-webhook-editor-title">
            {draft.id ? draft.name : "Trigger a Codex task from an event"}
          </strong>
        </div>
        <button type="button" className="icon-button" aria-label="Close Webhook editor" disabled={saving} onClick={onCancel}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <label className="full-field">
        Name
        <input autoComplete="off" maxLength={80} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </label>

      <div className={styles.policySection}>
        <header>
          <strong>Event source</strong>
          <span>
            The source owns authentication and delivery; the Webhook owns
            filtering and execution.
          </span>
        </header>
        <div className={styles.sourceChoices}>
          <button
            type="button"
            className={draft.sourceKind === "github" ? styles.sourceActive : ""}
            disabled={Boolean(draft.id)}
            onClick={() => {
              const connection = connections.find(
                (candidate) => candidate.status === "active",
              );
              onChange({
                ...draft,
                sourceKind: "github",
                secret: "",
                githubConnectionId: connection?.id ?? "",
                githubRepositoryIds: [],
                eventTypes: DEFAULT_GITHUB_WEBHOOK_EVENT_TYPES.join(", "),
                statePath: "/stateValue",
                targetKind: "sourceThread",
              });
            }}
          >
            <Github size={15} aria-hidden="true" />
            <span><strong>GitHub App</strong><small>Choose repositories and events</small></span>
          </button>
          <button
            type="button"
            className={draft.sourceKind === "custom" ? styles.sourceActive : ""}
            disabled={Boolean(draft.id)}
            onClick={() =>
              onChange({
                ...draft,
                sourceKind: "custom",
                githubConnectionId: "",
                githubRepositoryIds: [],
                eventTypes: "",
                statePath: "/payload/status",
                targetKind: "newSession",
              })
            }
          >
            <Webhook size={15} aria-hidden="true" />
            <span><strong>Custom URL</strong><small>Bearer-authenticated ingress</small></span>
          </button>
        </div>
        {draft.id ? (
          <small className={styles.sourceNote}>
            A Webhook source cannot be changed after creation.
          </small>
        ) : null}

        {draft.sourceKind === "custom" ? (
          <label className="full-field">
            <span className={shared.fieldHeading}>
              Bearer token
              <small>{draft.id ? "leave blank to keep current" : "generated if blank"}</small>
            </span>
            <input
              type="password"
              autoComplete="new-password"
              maxLength={1_000}
              value={draft.secret}
              onChange={(event) => onChange({ ...draft, secret: event.target.value })}
            />
          </label>
        ) : (
          <div className={styles.githubSource}>
            {githubLoading && !githubInventory ? (
              <p>Loading GitHub availability…</p>
            ) : !githubInventory?.configured ? (
              <p>
                This Sandpi deployment has not configured a GitHub App for
                Webhooks.
              </p>
            ) : (
              <>
                <div className={styles.githubActions}>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={githubInstalling}
                    onClick={onConnectGitHub}
                  >
                    <Github size={13} aria-hidden="true" />
                    {githubInstalling ? "Waiting for GitHub…" : "Connect GitHub"}
                  </button>
                  <button
                    type="button"
                    className="text-action-button"
                    disabled={githubLoading}
                    onClick={onRefreshGitHub}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    Refresh
                  </button>
                </div>
                {connections.length ? (
                  <label className="full-field">
                    GitHub account
                    <select
                      value={draft.githubConnectionId}
                      onChange={(event) =>
                        onChange({
                          ...draft,
                          githubConnectionId: event.target.value,
                          githubRepositoryIds: [],
                        })
                      }
                    >
                      <option value="">Choose an installation</option>
                      {connections.map((connection) => (
                        <option
                          key={connection.id}
                          value={connection.id}
                          disabled={connection.status !== "active"}
                        >
                          {connection.accountLogin}
                          {connection.status === "active"
                            ? ""
                            : ` (${connection.status})`}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p>Connect GitHub to choose an organization or account.</p>
                )}
                {selectedConnection ? (
                  <div className={styles.repositoryPicker}>
                    <div className={styles.repositoryHeading}>
                      <label>
                        Repositories
                        <input
                          type="search"
                          placeholder="Filter repositories"
                          value={repositoryQuery}
                          onChange={(event) => setRepositoryQuery(event.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className="text-action-button"
                        disabled={
                          busyGitHubConnectionId === selectedConnection.id
                        }
                        onClick={() => onDisconnectGitHub(selectedConnection.id)}
                      >
                        {busyGitHubConnectionId === selectedConnection.id
                          ? "Disconnecting…"
                          : "Disconnect"}
                      </button>
                    </div>
                    <div className={styles.repositoryList}>
                      {repositories.map((repository) => (
                        <label key={repository.id}>
                          <input
                            type="checkbox"
                            disabled={
                              !draft.githubRepositoryIds.includes(repository.id) &&
                              draft.githubRepositoryIds.length >= 100
                            }
                            checked={draft.githubRepositoryIds.includes(
                              repository.id,
                            )}
                            onChange={(event) =>
                              onChange({
                                ...draft,
                                githubRepositoryIds: event.target.checked
                                  ? [
                                      ...draft.githubRepositoryIds,
                                      repository.id,
                                    ]
                                  : draft.githubRepositoryIds.filter(
                                      (id) => id !== repository.id,
                                    ),
                              })
                            }
                          />
                          <span>{repository.fullName}</span>
                          <small>{repository.private ? "Private" : "Public"}</small>
                        </label>
                      ))}
                      {!repositories.length ? (
                        <p>No matching repositories are available.</p>
                      ) : null}
                    </div>
                    <small>
                      {draft.githubRepositoryIds.length} selected · up to 100
                    </small>
                  </div>
                ) : null}
              </>
            )}
            {githubError ? (
              <p className="settings-inline-error" role="alert">{githubError}</p>
            ) : null}
          </div>
        )}
      </div>

      <label className="full-field">
        Prompt
        <textarea
          className={shared.promptInput}
          maxLength={50_000}
          rows={7}
          placeholder="Tell Codex how to investigate or respond. The authenticated event is appended as untrusted data."
          value={draft.prompt}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
        />
        <small className={shared.characterCount}>{draft.prompt.length.toLocaleString()} / 50,000</small>
      </label>

      <div className={styles.policySection}>
        <header>
          <strong>Trigger policy</strong>
          <span>Choose which verified deliveries produce runs.</span>
        </header>
        <div className="field-grid two-columns">
          <label>
            Trigger
            <select value={draft.triggerMode} onChange={(event) => onChange({ ...draft, triggerMode: event.target.value as WebhookDraft["triggerMode"] })}>
              <option value="every">Every matching event</option>
              <option value="stateChange">Only when state changes</option>
            </select>
          </label>
          {draft.sourceKind === "custom" ? (
            <label>
              <span className={shared.fieldHeading}>Event types <small>comma or newline separated</small></span>
              <input placeholder="issues.opened, deploy.failed" value={draft.eventTypes} onChange={(event) => onChange({ ...draft, eventTypes: event.target.value })} />
            </label>
          ) : null}
        </div>
        {draft.sourceKind === "github" ? (
          <div className={styles.eventPicker}>
            {GITHUB_WEBHOOK_EVENT_TYPES.map((eventType) => (
              <label key={eventType.value}>
                <input
                  type="checkbox"
                  checked={selectedEventTypes.has(eventType.value)}
                  onChange={(event) => {
                    const next = new Set(selectedEventTypes);
                    if (event.target.checked) next.add(eventType.value);
                    else next.delete(eventType.value);
                    onChange({
                      ...draft,
                      eventTypes: GITHUB_WEBHOOK_EVENT_TYPES
                        .filter((candidate) => next.has(candidate.value))
                        .map((candidate) => candidate.value)
                        .join(", "),
                    });
                  }}
                />
                <span>{eventType.label}</span>
              </label>
            ))}
          </div>
        ) : null}
        <div className="field-grid two-columns">
          {draft.triggerMode === "stateChange" ? (
            <label>
              <span className={shared.fieldHeading}>State JSON Pointer <small>normalized event</small></span>
              <input className={styles.codeInput} placeholder="/payload/status" value={draft.statePath} onChange={(event) => onChange({ ...draft, statePath: event.target.value })} />
            </label>
          ) : null}
          {draft.sourceKind === "custom" ? (
            <label>
              <span className={shared.fieldHeading}>Group JSON Pointer <small>optional</small></span>
              <input className={styles.codeInput} placeholder="/groupKey or /payload/repository/full_name" value={draft.groupKeyPath} onChange={(event) => onChange({ ...draft, groupKeyPath: event.target.value })} />
            </label>
          ) : null}
        </div>
        <label className="full-field">
          <span className={shared.fieldHeading}>Conditions <small>one per line: JSON Pointer, operator, value</small></span>
          <textarea
            className={styles.codeInput}
            rows={4}
            placeholder={'/payload/action equals opened\n/payload/labels contains urgent'}
            value={draft.conditions}
            onChange={(event) => onChange({ ...draft, conditions: event.target.value })}
          />
          <small>Operators: equals, notEquals, contains, exists.</small>
        </label>
      </div>

      <div className={styles.policySection}>
        <header>
          <strong>Cooldown policy</strong>
          <span>Control event storms before a Session is created or woken.</span>
        </header>
        <div className="field-grid two-columns">
          <label>
            Mode
            <select value={draft.cooldownMode} onChange={(event) => onChange({ ...draft, cooldownMode: event.target.value as WebhookDraft["cooldownMode"] })}>
              <option value="none">None</option>
              <option value="throttle">Throttle</option>
              <option value="debounce">Debounce</option>
              <option value="batch">Batch window</option>
            </select>
          </label>
          {draft.cooldownMode !== "none" ? (
            <label>
              Duration (seconds)
              <input type="number" min={1} max={86_400} value={draft.cooldownSeconds} onChange={(event) => onChange({ ...draft, cooldownSeconds: event.target.valueAsNumber || 1 })} />
            </label>
          ) : null}
        </div>
        {draft.cooldownMode !== "none" ? (
          <label className="full-field">
            Events during the window
            <select value={draft.cooldownBehavior} onChange={(event) => onChange({ ...draft, cooldownBehavior: event.target.value as WebhookDraft["cooldownBehavior"] })}>
              <option value="merge">Merge up to 50 event payloads</option>
              <option value="latest">Keep only the latest payload</option>
              <option value="suppress">Suppress after the first accepted payload</option>
            </select>
          </label>
        ) : null}
      </div>

      <div className={styles.policySection}>
        <header>
          <strong>Run policy</strong>
          <span>Bound concurrency and backlog independently from cooldown.</span>
        </header>
        <div className="field-grid two-columns">
          <label>
            Target
            <select
              value={
                draft.targetKind === "session"
                  ? draft.targetSessionId
                  : draft.targetKind
              }
              onChange={(event) => {
                const value = event.target.value;
                onChange({
                  ...draft,
                  targetKind:
                    value === "newSession" || value === "sourceThread"
                      ? value
                      : "session",
                  targetSessionId:
                    value === "newSession" || value === "sourceThread"
                      ? draft.targetSessionId
                      : value,
                });
              }}
            >
              <option value="newSession">New Session per run</option>
              {draft.sourceKind === "github" ||
              draft.targetKind === "sourceThread" ? (
                <option value="sourceThread">
                  One Session per pull request or issue
                </option>
              ) : null}
              {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
            </select>
          </label>
          <label>
            If target Session is busy
            <select value={draft.overlapPolicy} onChange={(event) => onChange({ ...draft, overlapPolicy: event.target.value as WebhookDraft["overlapPolicy"] })}>
              <option value="queue">Queue and retry</option>
              <option value="skip">Record as skipped</option>
            </select>
          </label>
        </div>
        <div className="field-grid two-columns">
          <label>
            Concurrent runs
            <input type="number" min={1} max={10} disabled={draft.targetKind === "session"} value={draft.targetKind === "session" ? 1 : draft.maxConcurrentRuns} onChange={(event) => onChange({ ...draft, maxConcurrentRuns: event.target.valueAsNumber || 1 })} />
          </label>
          <label>
            Pending-run limit
            <input type="number" min={1} max={1_000} value={draft.maxPendingRuns} onChange={(event) => onChange({ ...draft, maxPendingRuns: event.target.valueAsNumber || 1 })} />
          </label>
        </div>
      </div>

      <label className={shared.enabledField}>
        <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} />
        Accept deliveries immediately
      </label>

      {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" className="button-secondary" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="button-primary" disabled={saving} onClick={onSave}>{saving ? "Saving…" : draft.id ? "Save Webhook" : "Create Webhook"}</button>
      </footer>
    </section>
  );
}

function WebhookHistoryView({
  history,
  loading,
  language,
  timeZone,
}: {
  history?: WebhookHistory;
  loading: boolean;
  language: OperationLanguage;
  timeZone: string;
}) {
  if (loading && !history) return <div className={shared.historyEmpty}>Loading activity…</div>;
  return (
    <div className={styles.activity}>
      <section>
        <strong>Deliveries</strong>
        {history?.deliveries.length ? history.deliveries.map((delivery) => (
          <div key={delivery.id}>
            <span>{delivery.eventType} · {delivery.status}</span>
            <small>{formatUnixTimestamp(delivery.receivedAt, language, timeZone, { dateStyle: "medium", timeStyle: "short" })}</small>
            {delivery.reason ? <small>{delivery.reason}</small> : null}
          </div>
        )) : <small>No verified deliveries yet.</small>}
      </section>
      <section>
        <strong>Runs</strong>
        {history?.runs.length ? history.runs.map((run) => (
          <div key={run.id}>
            <span>{run.status} · {run.eventCount} event{run.eventCount === 1 ? "" : "s"}</span>
            <small>{formatUnixTimestamp(run.createdAt, language, timeZone, { dateStyle: "medium", timeStyle: "short" })}</small>
            {run.error ? <small>{run.error}</small> : null}
          </div>
        )) : <small>No runs yet.</small>}
      </section>
    </div>
  );
}

function webhookDraftPayload(draft: WebhookDraft):
  | { error: string }
  | { value: ReturnType<typeof editableWebhookPayload> & { secret?: string } } {
  if (!draft.name.trim()) return { error: "Name is required." };
  if (!draft.prompt.trim()) return { error: "Prompt is required." };
  if (
    draft.sourceKind === "custom" &&
    draft.secret.trim() &&
    draft.secret.trim().length < 16
  ) {
    return { error: "Webhook secrets must contain at least 16 characters." };
  }
  if (draft.sourceKind === "github" && !draft.githubConnectionId) {
    return { error: "Choose a GitHub account or organization." };
  }
  if (
    draft.sourceKind === "github" &&
    !draft.githubRepositoryIds.length
  ) {
    return { error: "Select at least one GitHub repository." };
  }
  if (draft.targetKind === "session" && !draft.targetSessionId) {
    return { error: "Choose a target Session." };
  }
  const parsedConditions = parseConditions(draft.conditions);
  if ("error" in parsedConditions) return parsedConditions;
  const eventTypes = splitEventTypes(draft.eventTypes);
  if (draft.sourceKind === "github" && !eventTypes.length) {
    return { error: "Select at least one GitHub event." };
  }
  const value = {
    source:
      draft.sourceKind === "github"
        ? {
            kind: "github" as const,
            connectionId: draft.githubConnectionId,
            repositoryIds: draft.githubRepositoryIds,
          }
        : { kind: "custom" as const },
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    triggerPolicy: {
      mode: draft.triggerMode,
      eventTypes,
      conditions: parsedConditions.value,
      ...(draft.statePath.trim() ? { statePath: draft.statePath.trim() } : {}),
      ...(draft.groupKeyPath.trim() ? { groupKeyPath: draft.groupKeyPath.trim() } : {}),
    },
    cooldownPolicy: draft.cooldownMode === "none"
      ? { mode: "none" as const }
      : {
          mode: draft.cooldownMode,
          durationSeconds: draft.cooldownSeconds,
          behavior: draft.cooldownBehavior,
        },
    target:
      draft.targetKind === "newSession"
        ? { kind: "newSession" as const }
        : draft.targetKind === "sourceThread"
          ? { kind: "sourceThread" as const }
          : { kind: "session" as const, sessionId: draft.targetSessionId },
    overlapPolicy: draft.overlapPolicy,
    maxConcurrentRuns: draft.targetKind === "session" ? 1 : draft.maxConcurrentRuns,
    maxPendingRuns: draft.maxPendingRuns,
    enabled: draft.enabled,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.modelId ? { modelId: draft.modelId } : {}),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.collaborationMode ? { collaborationMode: draft.collaborationMode } : {}),
    ...(draft.serviceTier ? { serviceTier: draft.serviceTier } : {}),
    ...(draft.sourceKind === "custom" && draft.secret.trim()
      ? { secret: draft.secret.trim() }
      : {}),
  };
  return { value };
}

function editableWebhookPayload(webhook: EnvironmentWebhook) {
  return {
    source:
      webhook.source.kind === "github"
        ? {
            kind: "github" as const,
            connectionId: webhook.source.connectionId,
            repositoryIds: webhook.source.repositories.map(
              (repository) => repository.id,
            ),
          }
        : { kind: "custom" as const },
    name: webhook.name,
    prompt: webhook.prompt,
    triggerPolicy: webhook.triggerPolicy,
    cooldownPolicy: webhook.cooldownPolicy,
    target: webhook.target,
    overlapPolicy: webhook.overlapPolicy,
    maxConcurrentRuns: webhook.maxConcurrentRuns,
    maxPendingRuns: webhook.maxPendingRuns,
    enabled: webhook.enabled,
    ...(webhook.title ? { title: webhook.title } : {}),
    ...(webhook.modelId ? { modelId: webhook.modelId } : {}),
    ...(webhook.reasoningEffort ? { reasoningEffort: webhook.reasoningEffort } : {}),
    ...(webhook.collaborationMode ? { collaborationMode: webhook.collaborationMode } : {}),
    ...(webhook.serviceTier ? { serviceTier: webhook.serviceTier } : {}),
  };
}

function emptyDraft(sessionId?: string): WebhookDraft {
  return {
    sourceKind: "custom",
    githubConnectionId: "",
    githubRepositoryIds: [],
    name: "",
    secret: "",
    prompt: "Investigate this event, make any safe in-scope changes, run relevant checks, and summarize the outcome.",
    eventTypes: "",
    conditions: "",
    triggerMode: "every",
    statePath: "/payload/status",
    groupKeyPath: "",
    cooldownMode: "throttle",
    cooldownSeconds: 60,
    cooldownBehavior: "merge",
    targetKind: "newSession",
    targetSessionId: sessionId ?? "",
    overlapPolicy: "queue",
    maxConcurrentRuns: 1,
    maxPendingRuns: 100,
    enabled: true,
  };
}

function webhookDraft(webhook: EnvironmentWebhook): WebhookDraft {
  return {
    id: webhook.id,
    sourceKind: webhook.source.kind,
    githubConnectionId:
      webhook.source.kind === "github" ? webhook.source.connectionId : "",
    githubRepositoryIds:
      webhook.source.kind === "github"
        ? webhook.source.repositories.map((repository) => repository.id)
        : [],
    name: webhook.name,
    secret: "",
    prompt: webhook.prompt,
    eventTypes: webhook.triggerPolicy.eventTypes.join(", "),
    conditions: webhook.triggerPolicy.conditions.map(formatCondition).join("\n"),
    triggerMode: webhook.triggerPolicy.mode,
    statePath: webhook.triggerPolicy.statePath ?? "/payload/status",
    groupKeyPath: webhook.triggerPolicy.groupKeyPath ?? "",
    cooldownMode: webhook.cooldownPolicy.mode,
    cooldownSeconds: webhook.cooldownPolicy.mode === "none" ? 60 : webhook.cooldownPolicy.durationSeconds,
    cooldownBehavior: webhook.cooldownPolicy.mode === "none" ? "merge" : webhook.cooldownPolicy.behavior,
    targetKind: webhook.target.kind,
    targetSessionId: webhook.target.kind === "session" ? webhook.target.sessionId : "",
    overlapPolicy: webhook.overlapPolicy,
    maxConcurrentRuns: webhook.maxConcurrentRuns,
    maxPendingRuns: webhook.maxPendingRuns,
    enabled: webhook.enabled,
    title: webhook.title,
    modelId: webhook.modelId,
    reasoningEffort: webhook.reasoningEffort,
    collaborationMode: webhook.collaborationMode,
    serviceTier: webhook.serviceTier,
  };
}

function parseConditions(input: string):
  | { value: EnvironmentWebhookCondition[] }
  | { error: string } {
  const conditions: EnvironmentWebhookCondition[] = [];
  for (const [index, rawLine] of input.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const [path, operator, ...valueParts] = line.split(/\s+/);
    if (!path || (!path.startsWith("/") && path !== "")) {
      return { error: `Condition ${index + 1} needs a JSON Pointer starting with /.` };
    }
    if (!isConditionOperator(operator)) {
      return { error: `Condition ${index + 1} uses an unknown operator.` };
    }
    const value = valueParts.join(" ");
    if (operator !== "exists" && !value) {
      return { error: `Condition ${index + 1} needs a comparison value.` };
    }
    conditions.push({ path, operator, ...(operator === "exists" ? {} : { value }) });
  }
  return { value: conditions };
}

function splitEventTypes(input: string) {
  return Array.from(
    new Set(
      input
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function isConditionOperator(value: string | undefined): value is EnvironmentWebhookCondition["operator"] {
  return value === "equals" || value === "notEquals" || value === "contains" || value === "exists";
}

function formatCondition(condition: EnvironmentWebhookCondition) {
  return `${condition.path} ${condition.operator}${condition.value === undefined ? "" : ` ${condition.value}`}`;
}

function triggerSummary(webhook: EnvironmentWebhook) {
  const eventTypes = webhook.triggerPolicy.eventTypes.length
    ? webhook.triggerPolicy.eventTypes.join(", ")
    : "all events";
  return webhook.triggerPolicy.mode === "stateChange"
    ? `State change · ${eventTypes}`
    : eventTypes;
}

function cooldownSummary(webhook: EnvironmentWebhook) {
  const policy = webhook.cooldownPolicy;
  return policy.mode === "none"
    ? "None"
    : `${policy.mode} · ${policy.durationSeconds}s · ${policy.behavior}`;
}

function webhookSourceSummary(webhook: EnvironmentWebhook) {
  if (webhook.source.kind === "custom") {
    return webhook.endpointUrl ?? "Custom Webhook";
  }
  const count = webhook.source.repositories.length;
  return `GitHub · ${webhook.source.accountLogin} · ${count} ${count === 1 ? "repository" : "repositories"}`;
}

function webhookCollectionPath(environmentId: string) {
  return `/api/v1/environments/${encodeURIComponent(environmentId)}/webhooks`;
}

function webhookPath(environmentId: string, webhookId: string) {
  return `${webhookCollectionPath(environmentId)}/${encodeURIComponent(webhookId)}`;
}

function githubWebhookSourcePath(environmentId: string) {
  return `/api/v1/environments/${encodeURIComponent(environmentId)}/webhook-sources/github`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
