"use client";

import {
  ArrowUp,
  CircleHelp,
  Cloud,
  LockKeyhole,
  LogIn,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppFrame, AppSidebar } from "@/components/app-frame";
import { HelpFeedbackDialog } from "@/components/help-feedback-dialog";
import { SidebarTips } from "@/components/sidebar-tips";
import {
  navigateToAuthLogin,
  newSessionAuthLoginUrl,
  storePendingGuestPrompt,
} from "@/lib/auth-navigation";
import {
  DEFAULT_CLIENT_PREFERENCES,
  loadClientPreferences,
} from "@/lib/client-preferences";
import {
  getOperationUiCopy,
  shouldSubmitComposer,
} from "@/lib/operation-ui";
import { useNativeChromeSurfaces } from "@/lib/use-native-chrome-surfaces";

import workspaceStyles from "@/components/new-session-workspace.module.css";
import styles from "./guest-sandpi-app.module.css";

export function GuestSandpiApp({
  loginUrl,
  registrationOpen,
}: {
  loginUrl: string;
  registrationOpen: boolean;
}) {
  const preferences = loadClientPreferences(DEFAULT_CLIENT_PREFERENCES);
  const ui = getOperationUiCopy(preferences.general.language);
  const [prompt, setPrompt] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [helpFeedbackOpen, setHelpFeedbackOpen] = useState(false);
  const signInLabel = registrationOpen
    ? ui.guest.signInOrSignUp
    : ui.guest.signIn;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useNativeChromeSurfaces(
    sidebarOpen ? "sidebar" : "canvas",
    sidebarOpen ? "sidebar" : "canvas",
  );

  useEffect(() => {
    if (!window.matchMedia("(min-width: 641px)").matches) return;
    const focusFrame = window.requestAnimationFrame(() =>
      promptRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  function continueToLogin() {
    const hasPendingPrompt = Boolean(prompt.trim());
    if (hasPendingPrompt) {
      try {
        storePendingGuestPrompt(window.sessionStorage, prompt);
      } catch {
        // Storage can be unavailable in restricted browser contexts. Login
        // remains usable even when Sandpi cannot carry this draft across OIDC.
      }
    }
    navigateToAuthLogin(
      hasPendingPrompt
        ? newSessionAuthLoginUrl(loginUrl, window.location.href)
        : loginUrl,
    );
  }

  function sendMessage() {
    if (!prompt.trim()) {
      promptRef.current?.focus();
      return;
    }
    continueToLogin();
  }

  const sidebar = (
    <AppSidebar
      className="sidebar"
      label={ui.sidebar.navigation}
      headerAction={
        <>
          <button
            className="icon-button sidebar-collapse-button"
            type="button"
            aria-label={ui.sidebar.collapse}
            title={ui.sidebar.collapse}
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelLeftClose size={17} aria-hidden="true" />
          </button>
          <button
            className="icon-button sidebar-close-button"
            type="button"
            aria-label={ui.sidebar.close}
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose size={18} aria-hidden="true" />
          </button>
        </>
      }
      footer={
        <div className={styles.sidebarFooterActions}>
          <button
            type="button"
            className={`account-menu-trigger ${styles.signInButton}`}
            aria-label={signInLabel}
            onClick={() => continueToLogin()}
          >
            <span className={`account-avatar ${styles.signInAvatar}`}>
              <LogIn size={14} aria-hidden="true" />
            </span>
            <span className="account-copy">
              <strong>{signInLabel}</strong>
              <small>{ui.guest.signInContext}</small>
            </span>
          </button>
          <button
            type="button"
            className={styles.helpButton}
            aria-label={ui.sidebar.help}
            title={ui.sidebar.help}
            onClick={() => setHelpFeedbackOpen(true)}
          >
            <CircleHelp size={17} aria-hidden="true" />
          </button>
        </div>
      }
    >
      <button
        className="new-session-button"
        type="button"
        onClick={() => {
          setSidebarOpen(false);
          promptRef.current?.focus();
        }}
      >
        <Sparkles size={17} strokeWidth={2.2} aria-hidden="true" />
        {ui.sidebar.newSession}
      </button>

      <button
        className="sidebar-search"
        type="button"
        onClick={() => continueToLogin()}
      >
        <Search size={16} aria-hidden="true" />
        <span>{ui.sidebar.searchSessions}</span>
      </button>

      <div className="sidebar-scroll-region">
        <div className="sidebar-section-heading">
          <span>{ui.sidebar.environments}</span>
        </div>
        <p className={styles.sidebarEmpty}>{ui.guest.emptySidebar}</p>
      </div>
      <SidebarTips language={preferences.general.language} />
    </AppSidebar>
  );

  return (
    <AppFrame
      as="main"
      className={`app-shell ${sidebarOpen ? "sidebar-is-open" : ""} ${
        sidebarCollapsed ? "sidebar-is-collapsed" : ""
      }`}
    >
      {sidebar}
      {sidebarOpen ? (
        <button
          type="button"
          className="mobile-scrim"
          aria-label={ui.sidebar.close}
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <section
        id="conversation"
        className={workspaceStyles.workspace}
        tabIndex={-1}
      >
        <header
          className={workspaceStyles.header}
          data-native-titlebar-leading-content
        >
          <button
            type="button"
            className={workspaceStyles.desktopExpandButton}
            aria-label={ui.guest.expandSidebar}
            title={ui.guest.expandSidebar}
            onClick={() => setSidebarCollapsed(false)}
          >
            <PanelLeftOpen size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={workspaceStyles.mobileMenuButton}
            aria-label={ui.guest.openNavigation}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={19} aria-hidden="true" />
          </button>
          <div className={workspaceStyles.heading}>
            <div className={workspaceStyles.breadcrumb}>
              <span>Sandpi</span>
              <i>/</i>
              <strong>{ui.guest.newSession}</strong>
            </div>
            <div className={workspaceStyles.meta}>
              <span className={workspaceStyles.readyDot} aria-hidden="true" />
              {ui.guest.ready}
            </div>
          </div>
        </header>

        <div className={workspaceStyles.content}>
          <div className={workspaceStyles.intro}>
            <span className={workspaceStyles.agentMark} aria-hidden="true">
              <span />
            </span>
            <h1>{ui.guest.question}</h1>
            <p>{ui.guest.introduction}</p>
            {!registrationOpen ? (
              <div className={styles.betaNotice} role="status">
                <LockKeyhole size={15} aria-hidden="true" />
                <div>
                  <strong>{ui.guest.privateBeta}</strong>
                  <span>{ui.guest.registrationClosed}</span>
                </div>
              </div>
            ) : null}
            <div className={workspaceStyles.facts}>
              <span>
                <Cloud size={13} aria-hidden="true" />{" "}
                {ui.guest.persistentWorkspace}
              </span>
              <span>
                <ShieldCheck size={13} aria-hidden="true" />{" "}
                {ui.guest.secureSandbox}
              </span>
              <span>{ui.guest.backgroundWork}</span>
            </div>
          </div>

          <div className={`composer-shell ${workspaceStyles.composer}`}>
            <textarea
              ref={promptRef}
              name="guest-session-instruction"
              autoComplete="off"
              rows={3}
              value={prompt}
              placeholder={ui.guest.placeholder}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (
                  shouldSubmitComposer(
                    {
                      key: event.key,
                      shiftKey: event.shiftKey,
                      metaKey: event.metaKey,
                      ctrlKey: event.ctrlKey,
                      isComposing: event.nativeEvent.isComposing,
                    },
                    preferences.general.sendShortcut,
                  )
                ) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <span className="composer-agent-bound">
                  <LockKeyhole size={12} aria-hidden="true" />
                  Codex
                </span>
              </div>
              <div className="composer-send-area">
                <span className={styles.loginOnSend}>
                  {ui.guest.signedOut}
                </span>
                <button
                  type="button"
                  className="send-button"
                  disabled={!prompt.trim()}
                  aria-label={ui.guest.send}
                  onClick={sendMessage}
                >
                  <ArrowUp size={17} strokeWidth={2.5} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          <div
            className={workspaceStyles.starters}
            aria-label={ui.guest.starterLabel}
          >
            {ui.guest.starters.map((starter) => (
              <button
                type="button"
                key={starter}
                onClick={() => {
                  setPrompt(starter);
                  promptRef.current?.focus();
                }}
              >
                <Sparkles size={13} aria-hidden="true" />
                {starter}
              </button>
            ))}
          </div>
        </div>
      </section>
      {helpFeedbackOpen ? (
        <HelpFeedbackDialog
          language={preferences.general.language}
          onClose={() => setHelpFeedbackOpen(false)}
        />
      ) : null}
    </AppFrame>
  );
}
