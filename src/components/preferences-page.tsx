"use client";

import {
  ArrowLeft,
  Bell,
  Check,
  CircleAlert,
  Clock3,
  Database,
  Info,
  LoaderCircle,
  LockKeyhole,
  Palette,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";

import type { SandpiPreferences } from "@/lib/types";

import styles from "./preferences-page.module.css";

type PreferenceTab =
  | "general"
  | "appearance"
  | "notifications"
  | "security"
  | "advanced";

interface PreferencesPageProps {
  initialPreferences: SandpiPreferences;
}

const tabs: Array<{
  id: PreferenceTab;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
];

function getErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

export function PreferencesPage({ initialPreferences }: PreferencesPageProps) {
  const [activeTab, setActiveTab] = useState<PreferenceTab>("general");
  const [baseline, setBaseline] = useState(initialPreferences);
  const [draft, setDraft] = useState(initialPreferences);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<
    { tone: "success" | "error"; message: string } | undefined
  >();

  const hasChanges = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [baseline, draft],
  );

  function markChanged() {
    setSaveState(undefined);
  }

  function updateGeneral<Key extends keyof SandpiPreferences["general"]>(
    key: Key,
    value: SandpiPreferences["general"][Key],
  ) {
    setDraft((current) => ({
      ...current,
      general: { ...current.general, [key]: value },
    }));
    markChanged();
  }

  function updateAppearance<
    Key extends keyof SandpiPreferences["appearance"],
  >(
    key: Key,
    value: SandpiPreferences["appearance"][Key],
  ) {
    setDraft((current) => ({
      ...current,
      appearance: { ...current.appearance, [key]: value },
    }));
    markChanged();
  }

  function updateNotification<
    Key extends keyof SandpiPreferences["notifications"],
  >(
    key: Key,
    value: SandpiPreferences["notifications"][Key],
  ) {
    setDraft((current) => ({
      ...current,
      notifications: { ...current.notifications, [key]: value },
    }));
    markChanged();
  }

  async function savePreferences() {
    if (!hasChanges || saving) {
      return;
    }

    setSaving(true);
    setSaveState(undefined);
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          general: draft.general,
          appearance: draft.appearance,
          notifications: draft.notifications,
        }),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(
          getErrorMessage(payload) ?? "Preferences could not be saved.",
        );
      }

      setBaseline(draft);
      setSaveState({
        tone: "success",
        message: "Saved for this preview.",
      });
    } catch (error) {
      setSaveState({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Preferences could not be saved.",
      });
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    setDraft(baseline);
    setSaveState(undefined);
  }

  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#preferences-content">
        Skip to preferences
      </a>

      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <Link className={styles.sidebarBackLink} href="/">
            <ArrowLeft size={15} aria-hidden="true" />
            Back to workspace
          </Link>
          <div className={styles.sidebarHeading}>
            <span>Settings</span>
            <h1>Preferences</h1>
            <p>Personal choices for how Sandpi looks and behaves.</p>
          </div>
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
                  <Icon size={16} aria-hidden />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
          <p className={styles.sidebarNote}>
            Environment and coding agent settings live with each Environment.
          </p>
        </aside>

        <main className={styles.content} id="preferences-content">
          {activeTab === "general" ? (
            <PreferenceSection
              eyebrow="Personal preferences"
              title="General"
              description="Choose how Sandpi behaves for you. These choices do not change Environment or Session configuration."
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
              <OptionGroup label="Theme">
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
              </OptionGroup>
              <OptionGroup label="Density">
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
                      <span className={styles.densityPreview} aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>
                        <strong>
                          {density[0].toUpperCase() + density.slice(1)}
                        </strong>
                        <small>
                          {density === "comfortable"
                            ? "More breathing room"
                            : "More content at once"}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </OptionGroup>
            </PreferenceSection>
          ) : null}

          {activeTab === "notifications" ? (
            <PreferenceSection
              eyebrow="Stay informed"
              title="Notifications"
              description="Choose which remote Session state changes should get your attention."
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
              <Callout icon={<Bell size={17} aria-hidden="true" />}>
                Browser notifications require permission. Mobile push and
                email delivery will be configured here when those channels are
                available.
              </Callout>
            </PreferenceSection>
          ) : null}

          {activeTab === "security" ? (
            <PreferenceSection
              eyebrow="Deployment managed"
              title="Security"
              description="Security policy belongs to the Sandpi deployment, not to an individual browser."
            >
              <CapabilityCard
                icon={<LockKeyhole size={18} aria-hidden="true" />}
                title="Authentication and runtime credentials"
                badge="Deployment managed"
                description="Identity providers, runtime endpoints and credentials are configured by the Sandpi operator. End users cannot override them from Preferences."
              />
              <CapabilityCard
                icon={<ShieldCheck size={18} aria-hidden="true" />}
                title="Active devices and sessions"
                badge="Coming later"
                description="Review signed-in devices and revoke browser sessions from one place."
              />
              <Callout icon={<Info size={17} aria-hidden="true" />}>
                Environment network policy, sharing permissions and audit data
                remain scoped to the relevant Environment or Session.
              </Callout>
            </PreferenceSection>
          ) : null}

          {activeTab === "advanced" ? (
            <PreferenceSection
              eyebrow="Local tools"
              title="Advanced"
              description="Troubleshooting controls will stay local to this browser unless a deployment explicitly enables upload."
            >
              <CapabilityCard
                icon={<Database size={18} aria-hidden="true" />}
                title="Diagnostics bundle"
                badge="Coming later"
                description="Export local UI logs and browser metadata for support without including workspace files or prompts."
              />
              <CapabilityCard
                icon={<Clock3 size={18} aria-hidden="true" />}
                title="Local cache controls"
                badge="Coming later"
                description="Inspect and clear browser-only interface state without affecting running coding agent Sessions."
              />
              <Callout icon={<CircleAlert size={17} aria-hidden="true" />}>
                This preview uses mock data. Advanced controls are intentionally
                read-only until their storage and privacy contracts are defined.
              </Callout>
            </PreferenceSection>
          ) : null}
        </main>
      </div>

      <footer className={styles.saveBar}>
        <div className={styles.saveStatus} aria-live="polite">
          {saveState ? (
            <span
              className={
                saveState.tone === "error" ? styles.error : styles.success
              }
            >
              {saveState.tone === "success" ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <CircleAlert size={14} aria-hidden="true" />
              )}
              {saveState.message}
            </span>
          ) : hasChanges ? (
            <span>You have unsaved changes.</span>
          ) : (
            <span>Preferences are up to date.</span>
          )}
        </div>
        <div className={styles.saveActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={!hasChanges || saving}
            onClick={discardChanges}
          >
            Discard
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!hasChanges || saving}
            onClick={savePreferences}
          >
            {saving ? (
              <LoaderCircle
                className={styles.spinner}
                size={15}
                aria-hidden="true"
              />
            ) : (
              <Check size={15} aria-hidden="true" />
            )}
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </footer>
    </div>
  );
}

function PreferenceSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={`preference-${title}`}>
      <header className={styles.sectionHeader}>
        <span>{eyebrow}</span>
        <h2 id={`preference-${title}`}>{title}</h2>
        <p>{description}</p>
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
  control: ReactNode;
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
    <PreferenceRow
      title={title}
      description={description}
      control={
        <button
          type="button"
          className={`${styles.toggle} ${checked ? styles.on : ""}`}
          role="switch"
          aria-checked={checked}
          aria-label={title}
          onClick={() => onChange(!checked)}
        >
          <span aria-hidden="true" />
        </button>
      }
    />
  );
}

function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.optionGroup}>
      <span className={styles.optionLabel}>{label}</span>
      {children}
    </div>
  );
}

function Callout({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.callout}>
      {icon}
      <p>{children}</p>
    </div>
  );
}

function CapabilityCard({
  icon,
  title,
  badge,
  description,
}: {
  icon: ReactNode;
  title: string;
  badge: string;
  description: string;
}) {
  return (
    <article className={styles.capabilityCard}>
      <span className={styles.capabilityIcon}>{icon}</span>
      <div>
        <div className={styles.capabilityTitle}>
          <h3>{title}</h3>
          <span>{badge}</span>
        </div>
        <p>{description}</p>
      </div>
    </article>
  );
}
