"use client";

import {
  Check,
  CircleAlert,
  CreditCard,
  LoaderCircle,
  Palette,
  Settings2,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AppFrame,
  AppSidebar,
  SidebarBackAction,
} from "@/components/app-frame";
import { BillingSettings } from "@/components/billing-settings";
import { SidebarAccountFooter } from "@/components/sidebar-account-footer";
import {
  applyClientPreferences,
  buildAppearancePreviewPreferences,
  loadClientPreferences,
  saveClientPreferences,
} from "@/lib/client-preferences";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type { SandpiPreferences, SandpiUser } from "@/lib/types";
import { useNativeChromeSurfaces } from "@/lib/use-native-chrome-surfaces";

import styles from "./preferences-page.module.css";

type PreferenceTab = "general" | "appearance" | "billing";

interface PreferencesPageProps {
  initialPreferences: SandpiPreferences;
  viewer: SandpiUser;
}

const tabs: Array<{
  id: PreferenceTab;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "billing", label: "Billing", icon: CreditCard },
];

export function PreferencesPage({
  initialPreferences,
  viewer,
}: PreferencesPageProps) {
  const [activeTab, setActiveTab] = useState<PreferenceTab>("general");
  const [baseline, setBaseline] = useState(initialPreferences);
  const [draft, setDraft] = useState(initialPreferences);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<
    { tone: "success" | "error"; message: string } | undefined
  >();
  const baselineRef = useRef(initialPreferences);

  useNativeChromeSurfaces(
    "sidebar",
    activeTab === "billing" ? "canvas" : "panel",
  );

  const hasChanges = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baseline),
    [baseline, draft],
  );
  const isZh = baseline.general.language === "zh-CN";
  const text = (english: string, chinese: string) =>
    isZh ? chinese : english;

  useEffect(() => {
    const stored = loadClientPreferences(initialPreferences);
    baselineRef.current = stored;
    setBaseline(stored);
    setDraft(stored);
    applyClientPreferences(stored);
    setHydrated(true);

    const restoreSavedPreferences = () =>
      applyClientPreferences(baselineRef.current);
    const restoreBeforeLinkNavigation = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link) {
        return;
      }

      const destination = new URL(link.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname !== window.location.pathname
      ) {
        restoreSavedPreferences();
      }
    };

    document.addEventListener("click", restoreBeforeLinkNavigation, true);
    window.addEventListener("popstate", restoreSavedPreferences);
    window.addEventListener("pagehide", restoreSavedPreferences);
    window.addEventListener("beforeunload", restoreSavedPreferences);

    return () => {
      document.removeEventListener("click", restoreBeforeLinkNavigation, true);
      window.removeEventListener("popstate", restoreSavedPreferences);
      window.removeEventListener("pagehide", restoreSavedPreferences);
      window.removeEventListener("beforeunload", restoreSavedPreferences);
      restoreSavedPreferences();
    };
  }, [initialPreferences]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("billing")) {
      setActiveTab("billing");
    }
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    applyClientPreferences(
      buildAppearancePreviewPreferences(
        baselineRef.current,
        draft.appearance,
      ),
    );
  }, [draft.appearance, hydrated]);

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

  async function savePreferences() {
    if (!hasChanges || saving) {
      return;
    }

    setSaving(true);
    setSaveState(undefined);
    try {
      const response = await apiFetch<ApiEnvelope<SandpiPreferences>>(
        "/api/v1/preferences",
        {
          method: "PUT",
          body: JSON.stringify(draft),
        },
      );
      saveClientPreferences(response.data);
      baselineRef.current = response.data;
      setBaseline(response.data);
      setDraft(response.data);
      setSaveState({
        tone: "success",
        message:
          response.data.general.language === "zh-CN"
            ? "偏好设置已保存。"
            : "Preferences saved.",
      });
    } catch (error) {
      setSaveState({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : text("Preferences could not be saved.", "无法保存偏好设置。"),
      });
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    const saved = baselineRef.current;
    setDraft(saved);
    applyClientPreferences(saved);
    setSaveState(undefined);
  }

  return (
    <AppFrame className={styles.page}>
      <a className={styles.skipLink} href="#preferences-content">
        {text("Skip to preferences", "跳到偏好设置")}
      </a>

      <AppSidebar
        className={styles.sidebar}
        bodyClassName={styles.sidebarBody}
        footerClassName={styles.sidebarFooter}
        label={text("Preferences navigation", "偏好设置导航")}
        headerAction={
          <SidebarBackAction
            href="/"
            label={text("Back to workspace", "返回工作区")}
          />
        }
        footer={
          <SidebarAccountFooter
            language={baseline.general.language}
            viewer={viewer}
            showPreferences={false}
          />
        }
      >
        <div className={styles.sidebarHeading}>
          <span>{text("Settings", "设置")}</span>
          <h1>{text("Preferences", "偏好设置")}</h1>
          <p>
            {text(
              "Personal choices for how Sandpi looks and behaves.",
              "设置 Sandpi 的外观和交互方式。",
            )}
          </p>
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
                <span>
                  {text(
                    tab.label,
                    {
                      General: "通用",
                      Appearance: "外观",
                      Billing: "订阅与用量",
                    }[tab.label] ?? tab.label,
                  )}
                </span>
              </button>
            );
          })}
        </nav>
        <p className={styles.sidebarNote}>
          {text(
            "Environment and coding agent settings live with each Environment.",
            "Environment 和 coding agent 设置由各 Environment 独立管理。",
          )}
        </p>
      </AppSidebar>

      <div
        className={`${styles.workspace} ${
          activeTab === "billing" ? styles.workspaceFull : ""
        }`}
      >
        <main className={styles.content} id="preferences-content">
          {activeTab === "general" ? (
            <PreferenceSection
              eyebrow={text("Personal preferences", "个人偏好")}
              title={text("General", "通用")}
              description={text(
                "Choose how Sandpi behaves for you. These choices do not change Environment or Session configuration.",
                "选择 Sandpi 的个人交互方式。这些设置不会改变 Environment 或 Session 配置。",
              )}
            >
              <PreferenceRow
                title={text("Language", "语言")}
                description={text(
                  "Language used by the Sandpi interface.",
                  "Sandpi 界面使用的语言。",
                )}
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
                title={text("Time zone", "时区")}
                description={text(
                  "Used for Session activity and scheduled features.",
                  "用于 Session 活动和定时功能。",
                )}
                control={
                  <select
                    aria-label="Time zone"
                    value={draft.general.timeZone}
                    onChange={(event) =>
                      updateGeneral("timeZone", event.target.value)
                    }
                  >
                    <option value="auto">
                      {text("System default", "跟随系统")}
                    </option>
                    <option value="Asia/Shanghai">Asia/Shanghai</option>
                    <option value="UTC">UTC</option>
                    <option value="America/Los_Angeles">
                      America/Los_Angeles
                    </option>
                  </select>
                }
              />
              <PreferenceRow
                title={text("Send message", "发送消息")}
                description={text(
                  "Select the keyboard shortcut that sends a prompt.",
                  "选择用于发送提示词的键盘快捷键。",
                )}
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
              eyebrow={text("Interface", "界面")}
              title={text("Appearance", "外观")}
              description={text(
                "Adjust Sandpi’s visual treatment without changing the content of a Session.",
                "调整 Sandpi 的视觉表现，不会改变 Session 内容。",
              )}
            >
              <OptionGroup label={text("Theme", "主题")}>
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
                      {text(
                        theme[0].toUpperCase() + theme.slice(1),
                        { system: "跟随系统", light: "浅色", dark: "深色" }[
                          theme
                        ],
                      )}
                    </button>
                  ))}
                </div>
              </OptionGroup>
              <OptionGroup label={text("Density", "密度")}>
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
                          {text(
                            density[0].toUpperCase() + density.slice(1),
                            density === "comfortable" ? "舒适" : "紧凑",
                          )}
                        </strong>
                        <small>
                          {density === "comfortable"
                            ? text("More breathing room", "更多留白")
                            : text("More content at once", "同时显示更多内容")}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </OptionGroup>
            </PreferenceSection>
          ) : null}

          {activeTab === "billing" ? (
            <PreferenceSection
              eyebrow={text("Account", "账户")}
              title={text("Billing & usage", "订阅与用量")}
              description={text(
                "Manage your Sandpi plan and review account-attributed Sandbox runtime usage.",
                "管理 Sandpi 套餐并查看归属当前账户的 Sandbox 运行用量。",
              )}
            >
              <BillingSettings
                language={baseline.general.language}
                timeZone={baseline.general.timeZone}
              />
            </PreferenceSection>
          ) : null}

        </main>

        {activeTab !== "billing" ? (
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
              <span>{text("You have unsaved changes.", "有尚未保存的更改。")}</span>
            ) : (
              <span>
                {text("Preferences are up to date.", "偏好设置已是最新。")}
              </span>
            )}
          </div>
          <div className={styles.saveActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!hasChanges || saving}
              onClick={discardChanges}
            >
              {text("Discard", "放弃更改")}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!hasChanges || saving}
              onClick={() => void savePreferences()}
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
              {saving
                ? text("Saving…", "保存中…")
                : text("Save changes", "保存更改")}
            </button>
          </div>
          </footer>
        ) : null}
      </div>
    </AppFrame>
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

function OptionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.optionGroup}>
      <span className={styles.optionLabel}>{label}</span>
      {children}
    </div>
  );
}
