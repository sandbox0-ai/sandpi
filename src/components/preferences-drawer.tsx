"use client";

import {
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Palette,
  Plus,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { Sandbox0ConnectionSummary, SandpiPreferences } from "@/lib/types";

import styles from "./preferences-drawer.module.css";

type PreferenceTab =
  | "general"
  | "appearance"
  | "notifications"
  | "sandbox0"
  | "security"
  | "advanced";

export interface PreferencesDrawerProps {
  preferences: SandpiPreferences;
  onChange: (preferences: SandpiPreferences) => void;
  onClose: () => void;
}

interface ConnectionForm {
  name: string;
  apiHost: string;
  apiKey: string;
}

interface TestResult {
  tone: "success" | "error";
  message: string;
}

const tabs: Array<{
  id: PreferenceTab;
  label: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "sandbox0", label: "Sandbox0", icon: Cloud },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
];

const emptyConnectionForm: ConnectionForm = {
  name: "",
  apiHost: "",
  apiKey: "",
};

function isConnectionSummary(
  value: unknown,
): value is Sandbox0ConnectionSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Sandbox0ConnectionSummary>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.apiHost === "string" &&
    (candidate.targetKind === "cloud" ||
      candidate.targetKind === "self-hosted") &&
    (candidate.managedBy === "deployment" || candidate.managedBy === "team") &&
    typeof candidate.readOnly === "boolean" &&
    (candidate.status === "connected" ||
      candidate.status === "unverified" ||
      candidate.status === "error") &&
    typeof candidate.apiKeyConfigured === "boolean"
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function responseMessage(payload: Record<string, unknown>, fallback: string) {
  const error = payload.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  const data = payload.data;
  if (data && typeof data === "object") {
    const message = (data as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  const nested = payload.result;
  if (nested && typeof nested === "object") {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return typeof payload.message === "string" ? payload.message : fallback;
}

export function PreferencesDrawer({
  preferences,
  onChange,
  onClose,
}: PreferencesDrawerProps) {
  const titleId = useId();
  const [activeTab, setActiveTab] = useState<PreferenceTab>("general");
  const [draft, setDraft] = useState(preferences);
  const [connectionFormOpen, setConnectionFormOpen] = useState(false);
  const [connectionForm, setConnectionForm] =
    useState<ConnectionForm>(emptyConnectionForm);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [connectionAction, setConnectionAction] = useState<
    "test" | "save" | null
  >(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmBeforeSharing, setConfirmBeforeSharing] = useState(true);
  const [diagnostics, setDiagnostics] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const connectionNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(preferences);
  }, [preferences]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
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
      document.body.style.overflow = previousOverflow;
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

  function updateGeneral<Key extends keyof SandpiPreferences["general"]>(
    key: Key,
    value: SandpiPreferences["general"][Key],
  ) {
    setDraft((current) => ({
      ...current,
      general: { ...current.general, [key]: value },
    }));
    setSaved(false);
  }

  function updateAppearance<Key extends keyof SandpiPreferences["appearance"]>(
    key: Key,
    value: SandpiPreferences["appearance"][Key],
  ) {
    setDraft((current) => ({
      ...current,
      appearance: { ...current.appearance, [key]: value },
    }));
    setSaved(false);
  }

  function updateNotification<
    Key extends keyof SandpiPreferences["notifications"],
  >(key: Key, value: SandpiPreferences["notifications"][Key]) {
    setDraft((current) => ({
      ...current,
      notifications: { ...current.notifications, [key]: value },
    }));
    setSaved(false);
  }

  function openConnectionForm() {
    setConnectionFormOpen(true);
    setTestResult(null);
    window.requestAnimationFrame(() => connectionNameRef.current?.focus());
  }

  function closeConnectionForm() {
    if (connectionAction) {
      return;
    }
    setConnectionFormOpen(false);
    setConnectionForm(emptyConnectionForm);
    setApiKeyVisible(false);
    setTestResult(null);
  }

  async function testConnection() {
    setConnectionAction("test");
    setTestResult(null);
    try {
      const response = await fetch(
        "/api/preferences/sandbox0-connections/test",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            apiHost: connectionForm.apiHost.trim(),
            apiKey: connectionForm.apiKey,
          }),
        },
      );
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(
          responseMessage(payload, "Could not reach this Sandbox0 API."),
        );
      }
      setTestResult({
        tone: "success",
        message: responseMessage(
          payload,
          "Connection verified. Credentials are accepted.",
        ),
      });
    } catch (error) {
      setTestResult({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Connection test failed.",
      });
    } finally {
      setConnectionAction(null);
    }
  }

  async function saveConnection() {
    setConnectionAction("save");
    setTestResult(null);
    try {
      const response = await fetch("/api/preferences/sandbox0-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: connectionForm.name.trim(),
          apiHost: connectionForm.apiHost.trim(),
          apiKey: connectionForm.apiKey,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(
          responseMessage(payload, "Could not save this Sandbox0 connection."),
        );
      }

      const candidate = payload.data ?? payload.connection ?? payload;
      if (!isConnectionSummary(candidate)) {
        throw new Error("The server returned an invalid connection summary.");
      }

      const next: SandpiPreferences = {
        ...draft,
        sandbox0: {
          ...draft.sandbox0,
          connections: [...draft.sandbox0.connections, candidate],
        },
      };
      setDraft(next);
      onChange(next);
      setConnectionFormOpen(false);
      setConnectionForm(emptyConnectionForm);
      setApiKeyVisible(false);
      setSaved(true);
    } catch (error) {
      setTestResult({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Connection could not be saved.",
      });
    } finally {
      setConnectionAction(null);
    }
  }

  function savePreferences() {
    onChange(draft);
    setSaved(true);
  }

  const formComplete =
    connectionForm.name.trim().length > 0 &&
    connectionForm.apiHost.trim().length > 0 &&
    connectionForm.apiKey.length > 0;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={drawerRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <span className={styles.kicker}>Sandpi</span>
            <h1 id={titleId}>Preferences</h1>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.iconButton}
            aria-label="Close preferences"
            onClick={onClose}
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>
          <nav className={styles.navigation} aria-label="Preference sections">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  type="button"
                  key={tab.id}
                  className={activeTab === tab.id ? styles.active : undefined}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={16} />
                  <span>{tab.label}</span>
                  {tab.id === "sandbox0" ? (
                    <span className={styles.navCount}>
                      {draft.sandbox0.connections.length}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <main className={styles.content}>
            {activeTab === "general" ? (
              <PreferenceSection
                eyebrow="Personal preferences"
                title="General"
                description="Choose how Sandpi behaves for you. These settings do not change Environment or Session configuration."
              >
                <PreferenceRow
                  title="Language"
                  description="Language used by the Sandpi interface."
                  control={
                    <select
                      aria-label="Interface language"
                      value={draft.general.language}
                      onChange={(event) =>
                        updateGeneral(
                          "language",
                          event.target
                            .value as SandpiPreferences["general"]["language"],
                        )
                      }
                    >
                      <option value="en">English</option>
                      <option value="zh-CN">简体中文</option>
                    </select>
                  }
                />
                <PreferenceRow
                  title="Time zone"
                  description="Used for Session activity, audit events and scheduled features."
                  control={
                    <select
                      aria-label="Time zone"
                      value={draft.general.timeZone}
                      onChange={(event) =>
                        updateGeneral("timeZone", event.target.value)
                      }
                    >
                      <option value="auto">System default</option>
                      <option value="Asia/Shanghai">Asia/Shanghai</option>
                      <option value="UTC">UTC</option>
                      <option value="America/Los_Angeles">
                        America/Los_Angeles
                      </option>
                    </select>
                  }
                />
                <PreferenceRow
                  title="Send message"
                  description="Select the keyboard shortcut that sends a prompt."
                  control={
                    <select
                      aria-label="Send message shortcut"
                      value={draft.general.sendShortcut}
                      onChange={(event) =>
                        updateGeneral(
                          "sendShortcut",
                          event.target
                            .value as SandpiPreferences["general"]["sendShortcut"],
                        )
                      }
                    >
                      <option value="enter">Enter</option>
                      <option value="mod-enter">⌘ / Ctrl + Enter</option>
                    </select>
                  }
                />
              </PreferenceSection>
            ) : null}

            {activeTab === "appearance" ? (
              <PreferenceSection
                eyebrow="Interface"
                title="Appearance"
                description="Adjust Sandpi’s visual treatment without changing the content of a Session."
              >
                <div className={styles.optionGroup}>
                  <span className={styles.optionLabel}>Theme</span>
                  <div className={styles.segmented}>
                    {(["system", "light", "dark"] as const).map((theme) => (
                      <button
                        type="button"
                        key={theme}
                        className={
                          draft.appearance.theme === theme
                            ? styles.selected
                            : undefined
                        }
                        aria-pressed={draft.appearance.theme === theme}
                        onClick={() => updateAppearance("theme", theme)}
                      >
                        {theme[0].toUpperCase() + theme.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.optionGroup}>
                  <span className={styles.optionLabel}>Density</span>
                  <div className={styles.densityGrid}>
                    {(["comfortable", "compact"] as const).map((density) => (
                      <button
                        type="button"
                        key={density}
                        className={
                          draft.appearance.density === density
                            ? styles.selected
                            : undefined
                        }
                        aria-pressed={draft.appearance.density === density}
                        onClick={() => updateAppearance("density", density)}
                      >
                        <span
                          className={styles.densityPreview}
                          aria-hidden="true"
                        >
                          <i />
                          <i />
                          <i />
                        </span>
                        <strong>
                          {density[0].toUpperCase() + density.slice(1)}
                        </strong>
                      </button>
                    ))}
                  </div>
                </div>
              </PreferenceSection>
            ) : null}

            {activeTab === "notifications" ? (
              <PreferenceSection
                eyebrow="Stay informed"
                title="Notifications"
                description="Get notified when remote coding Sessions change state, even when this browser tab is not active."
              >
                <ToggleRow
                  title="Session completed"
                  description="Notify when a coding agent finishes a turn."
                  checked={draft.notifications.sessionCompleted}
                  onChange={(checked) =>
                    updateNotification("sessionCompleted", checked)
                  }
                />
                <ToggleRow
                  title="Needs attention"
                  description="Notify when a Session needs approval, clarification or credentials."
                  checked={draft.notifications.needsAttention}
                  onChange={(checked) =>
                    updateNotification("needsAttention", checked)
                  }
                />
                <div className={styles.infoCallout}>
                  <Bell size={16} aria-hidden="true" />
                  <p>
                    Browser notifications require permission. Mobile push and
                    email delivery can be added without changing Session
                    execution.
                  </p>
                </div>
              </PreferenceSection>
            ) : null}

            {activeTab === "sandbox0" ? (
              <PreferenceSection
                eyebrow="Runtime connections"
                title="Sandbox0"
                description="Connect Sandpi to Sandbox0 Cloud or a private Sandbox0 control plane. Each Environment keeps the connection it was created with."
                action={
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={openConnectionForm}
                    disabled={connectionFormOpen}
                  >
                    <Plus size={15} aria-hidden="true" /> Add private connection
                  </button>
                }
              >
                <div className={styles.securityCallout}>
                  <LockKeyhole size={17} aria-hidden="true" />
                  <div>
                    <strong>API keys stay on the Sandpi server</strong>
                    <p>
                      The browser receives only connection status and the last
                      four characters. Keys must never be returned by a
                      Preferences API or stored in browser storage.
                    </p>
                  </div>
                </div>

                <fieldset className={styles.connectionList}>
                  <legend>Default connection for new Environments</legend>
                  {draft.sandbox0.connections.map((connection) => (
                    <ConnectionOption
                      key={connection.id}
                      connection={connection}
                      checked={
                        draft.sandbox0.defaultConnectionId === connection.id
                      }
                      onSelect={() => {
                        setDraft((current) => ({
                          ...current,
                          sandbox0: {
                            ...current.sandbox0,
                            defaultConnectionId: connection.id,
                          },
                        }));
                        setSaved(false);
                      }}
                    />
                  ))}
                </fieldset>

                {connectionFormOpen ? (
                  <div className={styles.connectionForm}>
                    <div className={styles.formHeading}>
                      <div>
                        <span>Private Sandbox0</span>
                        <h3>Add connection</h3>
                      </div>
                      <button
                        type="button"
                        className={styles.smallIconButton}
                        aria-label="Cancel adding connection"
                        onClick={closeConnectionForm}
                        disabled={connectionAction !== null}
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.formGrid}>
                      <label className={styles.field}>
                        <span>Connection name</span>
                        <input
                          ref={connectionNameRef}
                          name="sandbox0-connection-name"
                          autoComplete="off"
                          value={connectionForm.name}
                          placeholder="Production Sandbox0"
                          onChange={(event) =>
                            setConnectionForm((current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className={styles.field}>
                        <span>API Host</span>
                        <span className={styles.inputWithIcon}>
                          <Server size={15} aria-hidden="true" />
                          <input
                            name="sandbox0-api-host"
                            type="url"
                            inputMode="url"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            value={connectionForm.apiHost}
                            placeholder="https://sandbox0.internal.example.com"
                            onChange={(event) =>
                              setConnectionForm((current) => ({
                                ...current,
                                apiHost: event.target.value,
                              }))
                            }
                          />
                        </span>
                      </label>
                      <label className={styles.field}>
                        <span>API Key</span>
                        <span className={styles.inputWithIcon}>
                          <KeyRound size={15} aria-hidden="true" />
                          <input
                            name="sandbox0-api-key"
                            type={apiKeyVisible ? "text" : "password"}
                            autoComplete="new-password"
                            spellCheck={false}
                            value={connectionForm.apiKey}
                            placeholder="s0_••••••••••••••••"
                            onChange={(event) =>
                              setConnectionForm((current) => ({
                                ...current,
                                apiKey: event.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            aria-label={
                              apiKeyVisible ? "Hide API key" : "Show API key"
                            }
                            aria-pressed={apiKeyVisible}
                            onClick={() =>
                              setApiKeyVisible((visible) => !visible)
                            }
                          >
                            {apiKeyVisible ? (
                              <EyeOff size={15} aria-hidden="true" />
                            ) : (
                              <Eye size={15} aria-hidden="true" />
                            )}
                          </button>
                        </span>
                        <small>
                          Sent once to the Sandpi backend and never returned by
                          the connection API.
                        </small>
                      </label>
                    </div>
                    {testResult ? (
                      <div
                        className={`${styles.testResult} ${
                          testResult.tone === "success"
                            ? styles.success
                            : styles.error
                        }`}
                        role={testResult.tone === "error" ? "alert" : "status"}
                      >
                        {testResult.tone === "success" ? (
                          <CheckCircle2 size={15} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={15} aria-hidden="true" />
                        )}
                        <span>{testResult.message}</span>
                      </div>
                    ) : null}
                    <div className={styles.formActions}>
                      <button
                        type="button"
                        className={styles.ghostButton}
                        disabled={!formComplete || connectionAction !== null}
                        onClick={testConnection}
                      >
                        {connectionAction === "test" ? (
                          <LoaderCircle
                            className={styles.spinner}
                            size={15}
                            aria-hidden="true"
                          />
                        ) : null}
                        Test connection
                      </button>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={!formComplete || connectionAction !== null}
                        onClick={saveConnection}
                      >
                        {connectionAction === "save" ? (
                          <LoaderCircle
                            className={styles.spinner}
                            size={15}
                            aria-hidden="true"
                          />
                        ) : null}
                        Save connection
                      </button>
                    </div>
                  </div>
                ) : null}

                <p className={styles.sectionFootnote}>
                  Changing this default affects only future Environments.
                  Existing Environments and their Sessions remain pinned to
                  their original Sandbox0 connection.
                </p>
              </PreferenceSection>
            ) : null}

            {activeTab === "security" ? (
              <PreferenceSection
                eyebrow="Personal safeguards"
                title="Security"
                description="Control confirmation and local visibility. Team roles, SSO and secret storage belong to Sandpi administration."
              >
                <ToggleRow
                  title="Confirm before creating a public link"
                  description="Ask before creating an expiring file share from a Session volume."
                  checked={confirmBeforeSharing}
                  onChange={setConfirmBeforeSharing}
                />
                <div className={styles.infoCallout}>
                  <ShieldCheck size={17} aria-hidden="true" />
                  <p>
                    API keys, coding-agent credentials and encryption keys are
                    deployment secrets, not personal Preferences. Organization
                    administrators manage those separately.
                  </p>
                </div>
              </PreferenceSection>
            ) : null}

            {activeTab === "advanced" ? (
              <PreferenceSection
                eyebrow="Troubleshooting"
                title="Advanced"
                description="Diagnostics help support inspect browser-to-Sandpi connectivity. They never expose coding-agent or Sandbox0 credentials."
              >
                <ToggleRow
                  title="Client diagnostics"
                  description="Keep a short local buffer of UI and connection events for troubleshooting."
                  checked={diagnostics}
                  onChange={setDiagnostics}
                />
                <button type="button" className={styles.diagnosticRow}>
                  <span>
                    <strong>Export client diagnostics</strong>
                    <small>
                      Session IDs and secret-shaped values are redacted.
                    </small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </PreferenceSection>
            ) : null}
          </main>
        </div>

        <footer className={styles.footer}>
          <span className={styles.saveStatus} aria-live="polite">
            {saved ? (
              <>
                <Check size={13} aria-hidden="true" /> Saved
              </>
            ) : (
              "Preferences apply to your account"
            )}
          </span>
          <div>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={savePreferences}
            >
              Save changes
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function PreferenceSection({
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <div>
          <span>{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {action ? <div className={styles.sectionAction}>{action}</div> : null}
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

function PreferenceRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div className={styles.preferenceRow}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className={styles.rowControl}>{control}</div>
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={styles.preferenceRow}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={`${styles.toggle} ${checked ? styles.on : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function ConnectionOption({
  connection,
  checked,
  onSelect,
}: {
  connection: Sandbox0ConnectionSummary;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`${styles.connectionOption} ${checked ? styles.selected : ""}`}
    >
      <input
        type="radio"
        name="default-sandbox0-connection"
        checked={checked}
        onChange={onSelect}
      />
      <span className={styles.connectionIcon} aria-hidden="true">
        {connection.targetKind === "cloud" ? (
          <Cloud size={17} />
        ) : (
          <Server size={17} />
        )}
      </span>
      <span className={styles.connectionCopy}>
        <span className={styles.connectionTitle}>
          <strong>{connection.name}</strong>
          <span className={styles.connectionKind}>
            {connection.targetKind === "cloud" ? "Cloud" : "Private"} ·{" "}
            {connection.managedBy === "deployment"
              ? "Deployment"
              : "Team managed"}
          </span>
          <ConnectionStatus status={connection.status} />
        </span>
        <code title={connection.apiHost}>{connection.apiHost}</code>
        <small>
          {connection.apiKeyConfigured
            ? `API key configured${connection.apiKeyLast4 ? ` · ends in ${connection.apiKeyLast4}` : ""}`
            : "API key required"}
          {connection.lastCheckedAt
            ? ` · checked ${connection.lastCheckedAt}`
            : ""}
        </small>
      </span>
    </label>
  );
}

function ConnectionStatus({
  status,
}: {
  status: Sandbox0ConnectionSummary["status"];
}) {
  const label =
    status === "connected"
      ? "Connected"
      : status === "error"
        ? "Error"
        : "Unverified";
  return (
    <span className={`${styles.statusBadge} ${styles[status]}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
