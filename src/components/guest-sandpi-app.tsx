"use client";

import {
  CircleHelp,
  Cloud,
  LockKeyhole,
  LogIn,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";

import { AppFrame, AppSidebar } from "@/components/app-frame";
import { HelpFeedbackDialog } from "@/components/help-feedback-dialog";
import { SidebarTips } from "@/components/sidebar-tips";
import { navigateToAuthLogin } from "@/lib/auth-navigation";
import {
  DEFAULT_CLIENT_PREFERENCES,
  loadClientPreferences,
} from "@/lib/client-preferences";
import { getOperationUiCopy } from "@/lib/operation-ui";
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [helpFeedbackOpen, setHelpFeedbackOpen] = useState(false);
  const signInLabel = registrationOpen
    ? ui.guest.signInOrSignUp
    : ui.guest.signIn;
  useNativeChromeSurfaces(
    sidebarOpen ? "sidebar" : "canvas",
    sidebarOpen ? "sidebar" : "canvas",
  );

  function continueToLogin() {
    navigateToAuthLogin(loginUrl);
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
      <div className={styles.releaseLine}>
        <TerminalSquare size={13} aria-hidden="true" />
        <span>SANDPI V2 // WEB TTY</span>
        <strong>ONLINE</strong>
      </div>

      <button
        className={styles.openEnvironmentButton}
        type="button"
        onClick={continueToLogin}
      >
        <LogIn size={15} aria-hidden="true" />
        [ {ui.sidebar.newEnvironment.toUpperCase()} ]
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
      className={`app-shell terminal-v2-shell ${sidebarOpen ? "sidebar-is-open" : ""} ${
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
              <span>SANDPI</span>
              <i>/</i>
              <strong>{ui.guest.newSession}</strong>
            </div>
            <div className={workspaceStyles.meta}>
              <span className={workspaceStyles.readyDot} aria-hidden="true" />
              {ui.guest.ready}
            </div>
          </div>
        </header>

        <div className={styles.terminalStage}>
          <section
            className={styles.terminalWindow}
            aria-label="Sandpi native coding-agent terminal"
          >
            <div className={styles.terminalTitlebar}>
              <span>
                <TerminalSquare size={13} aria-hidden="true" /> WEB-TTY
              </span>
              <span>AUTH: GUEST</span>
            </div>
            <div className={styles.terminalOutput}>
              <p className={styles.command}>
                <span>$</span> sandpi environment attach
              </p>
              <p className={styles.banner}>SANDPI V2 / NATIVE AGENT TERMINAL</p>
              <dl className={styles.statusGrid}>
                <div>
                  <dt>GATEWAY</dt>
                  <dd>ONLINE</dd>
                </div>
                <div>
                  <dt>AGENTS</dt>
                  <dd>CODEX · CLAUDE CODE · PI</dd>
                </div>
                <div>
                  <dt>RUNTIME</dt>
                  <dd>PERSISTENT SANDBOX0 ENVIRONMENT</dd>
                </div>
                <div>
                  <dt>CLIENTS</dt>
                  <dd>WEB · DESKTOP · MOBILE</dd>
                </div>
              </dl>
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
              <div className={styles.facts}>
                <span>
                  <Cloud size={13} aria-hidden="true" />
                  {ui.guest.persistentWorkspace}
                </span>
                <span>
                  <ShieldCheck size={13} aria-hidden="true" />
                  {ui.guest.secureSandbox}
                </span>
                <span>{ui.guest.backgroundWork}</span>
              </div>
              <p className={styles.command}>
                <span>$</span> login --open-environment
                <span className={styles.cursor} aria-hidden="true">
                  _
                </span>
              </p>
            </div>
            <div
              className={styles.touchActions}
              aria-label="Guest terminal actions"
            >
              <button type="button" onClick={continueToLogin}>
                <LogIn size={14} aria-hidden="true" /> [{" "}
                {signInLabel.toUpperCase()} ]
              </button>
              <button type="button" onClick={() => setHelpFeedbackOpen(true)}>
                <CircleHelp size={14} aria-hidden="true" /> [{" "}
                {ui.sidebar.help.toUpperCase()} ]
              </button>
            </div>
          </section>
          <div className={styles.pointerNote}>
            TOUCH / MOUSE / KEYBOARD READY · A PHYSICAL KEYBOARD IS OPTIONAL
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
