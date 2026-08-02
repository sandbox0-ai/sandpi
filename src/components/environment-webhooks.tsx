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
  githubEventTypes: string[];
  batchWindowSeconds: number;
  targetKind: "newSession" | "sourceThread" | "session";
  targetSessionId: string;
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
          persists, batches, and safely delivers events to Codex.
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
                    <dt>Delivery handling</dt>
                    <dd>{batchSummary(webhook)}</dd>
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
  const curlExample =
    !githubSource && setup.webhook.endpointUrl
      ? customWebhookCurlExample(
          setup.webhook.endpointUrl,
          setup.setupSecret,
        )
      : undefined;
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
          : "POST JSON, form, or text data with Authorization: Bearer <token>. A top-level prompt in JSON or form data adds per-delivery instructions; the Base prompt takes precedence."}
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
      {curlExample ? (
        <CopyCodeExample
          value={curlExample}
          copied={copied === "setup-curl"}
          onCopy={() => onCopy("setup-curl", curlExample)}
        />
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

function CopyCodeExample({
  value,
  copied,
  onCopy,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className={styles.codeExample}>
      <div>
        <span>curl example</span>
        <button type="button" className="text-action-button" onClick={onCopy}>
          <Copy size={13} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{value}</code></pre>
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
  const selectedEventTypes = new Set(draft.githubEventTypes);
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
            Choose GitHub events or create an authenticated URL for any sender.
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
                githubEventTypes: [...DEFAULT_GITHUB_WEBHOOK_EVENT_TYPES],
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
                githubEventTypes: [],
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
            <small>Every authenticated request starts this Webhook.</small>
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
        Base prompt
        <textarea
          className={shared.promptInput}
          maxLength={50_000}
          rows={7}
          placeholder="Tell Codex how to handle every delivery."
          value={draft.prompt}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
        />
        <small>
          {draft.sourceKind === "custom"
            ? "Takes precedence. An optional top-level request-body prompt adds per-delivery instructions; all other payload fields remain untrusted data."
            : "Always applied before the selected GitHub event, which remains untrusted data."}
        </small>
        <small className={shared.characterCount}>{draft.prompt.length.toLocaleString()} / 50,000</small>
      </label>

      {draft.sourceKind === "github" ? (
        <div className={styles.policySection}>
          <header>
            <strong>GitHub events</strong>
            <span>Only the selected event actions start this Webhook.</span>
          </header>
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
                      githubEventTypes: GITHUB_WEBHOOK_EVENT_TYPES
                        .filter((candidate) => next.has(candidate.value))
                        .map((candidate) => candidate.value),
                    });
                  }}
                />
                <span>{eventType.label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.policySection}>
        <header>
          <strong>Delivery batching</strong>
          <span>Run immediately or combine a short burst into one task.</span>
        </header>
        <label className="full-field">
          Behavior
          <select
            value={draft.batchWindowSeconds}
            onChange={(event) =>
              onChange({
                ...draft,
                batchWindowSeconds: Number(event.target.value),
              })
            }
          >
            <option value={0}>Run every delivery immediately</option>
            <option value={30}>Combine deliveries for 30 seconds</option>
            <option value={60}>Combine deliveries for 1 minute</option>
            <option value={300}>Combine deliveries for 5 minutes</option>
            <option value={900}>Combine deliveries for 15 minutes</option>
            {![0, 30, 60, 300, 900].includes(draft.batchWindowSeconds) ? (
              <option value={draft.batchWindowSeconds}>
                Combine deliveries for {draft.batchWindowSeconds} seconds
              </option>
            ) : null}
          </select>
        </label>
        <p className={styles.policyExplanation}>
          {draft.batchWindowSeconds === 0
            ? "Each accepted delivery creates one queued run."
            : draft.sourceKind === "github"
              ? "The fixed window starts with the first event and combines events for the same pull request, issue, or repository."
              : "The fixed window starts with the first request and combines all requests received by this Webhook."}
        </p>
      </div>

      <div className={styles.policySection}>
        <header>
          <strong>Run destination</strong>
          <span>Choose where Sandpi should deliver each accepted run.</span>
        </header>
        <label className="full-field">
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
            <option value="newSession">Create a new Session for each run</option>
            {draft.sourceKind === "github" ||
            draft.targetKind === "sourceThread" ? (
              <option value="sourceThread">
                Reuse one Session per pull request or issue
              </option>
            ) : null}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                Existing Session: {session.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className={shared.enabledField}>
        <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} />
        Enable this Webhook after saving
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
  if (draft.sourceKind === "github" && !draft.githubEventTypes.length) {
    return { error: "Select at least one GitHub event." };
  }
  const value = {
    source:
      draft.sourceKind === "github"
        ? {
            kind: "github" as const,
            connectionId: draft.githubConnectionId,
            repositoryIds: draft.githubRepositoryIds,
            eventTypes: draft.githubEventTypes,
          }
        : { kind: "custom" as const },
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    batchWindowSeconds: draft.batchWindowSeconds,
    target:
      draft.targetKind === "newSession"
        ? { kind: "newSession" as const }
        : draft.targetKind === "sourceThread"
          ? { kind: "sourceThread" as const }
          : { kind: "session" as const, sessionId: draft.targetSessionId },
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
            eventTypes: webhook.source.eventTypes,
          }
        : { kind: "custom" as const },
    name: webhook.name,
    prompt: webhook.prompt,
    batchWindowSeconds: webhook.batchWindowSeconds,
    target: webhook.target,
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
    githubEventTypes: [],
    batchWindowSeconds: 0,
    targetKind: "newSession",
    targetSessionId: sessionId ?? "",
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
    githubEventTypes:
      webhook.source.kind === "github" ? webhook.source.eventTypes : [],
    batchWindowSeconds: webhook.batchWindowSeconds,
    targetKind: webhook.target.kind,
    targetSessionId: webhook.target.kind === "session" ? webhook.target.sessionId : "",
    enabled: webhook.enabled,
    title: webhook.title,
    modelId: webhook.modelId,
    reasoningEffort: webhook.reasoningEffort,
    collaborationMode: webhook.collaborationMode,
    serviceTier: webhook.serviceTier,
  };
}

function triggerSummary(webhook: EnvironmentWebhook) {
  if (webhook.source.kind === "custom") return "Every authenticated request";
  return webhook.source.eventTypes.length === 1
    ? webhook.source.eventTypes[0]!
    : `${webhook.source.eventTypes.length} selected GitHub events`;
}

function batchSummary(webhook: EnvironmentWebhook) {
  return webhook.batchWindowSeconds === 0
    ? "Run immediately"
    : `Combine for ${webhook.batchWindowSeconds}s`;
}

function webhookSourceSummary(webhook: EnvironmentWebhook) {
  if (webhook.source.kind === "custom") {
    return webhook.endpointUrl ?? "Custom Webhook";
  }
  const count = webhook.source.repositories.length;
  return `GitHub · ${webhook.source.accountLogin} · ${count} ${count === 1 ? "repository" : "repositories"}`;
}

function customWebhookCurlExample(endpointUrl: string, setupSecret?: string) {
  const token = setupSecret ?? "<bearer-token>";
  return `curl --request POST '${endpointUrl}' \\
  --header 'Authorization: Bearer ${token}' \\
  --header 'Content-Type: application/json' \\
  --header 'X-Sandpi-Event: deploy.failed' \\
  --header 'Idempotency-Key: deploy-123' \\
  --data '{
    "prompt": "Investigate this failed deployment and prepare a safe fix.",
    "deploymentId": "deploy-123",
    "environment": "production"
  }'`;
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
