"use client";

import {
  Camera,
  ClipboardPaste,
  Eraser,
  FolderTree,
  GitFork,
  Hand,
  PanelLeftOpen,
  Keyboard,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { Environment } from "@/lib/types";

import styles from "./agent-terminal-workspace.module.css";
import {
  terminalConnectionLabel,
  useTerminalSession,
} from "./use-terminal-session";

interface AgentTerminalWorkspaceProps {
  environment: Environment;
  onToggleSidebar: () => void;
  onOpenFiles: () => void;
  onOpenSnapshots: () => void;
  onOpenFork: () => void;
  onOpenSettings: () => void;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onOpenSandboxPreview: (url: string) => void;
}

const VIRTUAL_KEYS = [
  { label: "ESC", data: "\u001b" },
  { label: "TAB", data: "\t" },
  { label: "CTRL-C", data: "\u0003" },
  { label: "CTRL-D", data: "\u0004" },
  { label: "←", data: "\u001b[D" },
  { label: "↑", data: "\u001b[A" },
  { label: "↓", data: "\u001b[B" },
  { label: "→", data: "\u001b[C" },
] as const;

export function AgentTerminalWorkspace({
  environment,
  onToggleSidebar,
  onOpenFiles,
  onOpenSnapshots,
  onOpenFork,
  onOpenSettings,
  onPause,
  onResume,
  onOpenSandboxPreview,
}: AgentTerminalWorkspaceProps) {
  const [openPanel, setOpenPanel] = useState<"keys" | "actions">();
  const controlsRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!openPanel) return;
    const dismiss = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) {
        setOpenPanel(undefined);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpenPanel(undefined);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [openPanel]);

  const togglePanel = (panel: "keys" | "actions", trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setOpenPanel((current) => (current === panel ? undefined : panel));
  };

  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const noopSearch = useCallback(() => undefined, []);
  const terminalAvailable =
    environment.status === "ready" && Boolean(environment.sandboxId);
  const {
    terminalHostRef,
    terminalRef,
    connectionState,
    connectionError,
    controlRole,
    takeControl,
    sendInput,
    clearTerminal,
    restartTerminal,
  } = useTerminalSession(
    environment.id,
    noopSearch,
    onOpenSandboxPreview,
    { surface: "agent", enabled: terminalAvailable },
  );

  const runLifecycleAction = async (operation: () => Promise<void>) => {
    if (lifecycleBusy) return;
    setLifecycleBusy(true);
    setActionError(undefined);
    try {
      await operation();
      restartTerminal();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Environment action failed.",
      );
    } finally {
      setLifecycleBusy(false);
    }
  };

  const pasteFromClipboard = async () => {
    if (controlRole !== "controller") return;
    try {
      const value = await navigator.clipboard.readText();
      if (value) terminalRef.current?.paste(value);
    } catch {
      setActionError("Clipboard access was denied by the browser.");
    }
  };

  const agentLabel = environment.codingAgent.label;
  const stateLabel = terminalAvailable
    ? terminalConnectionLabel(connectionState)
    : environment.status === "error"
      ? "provisioning failed"
      : "provisioning";
  const terminalNotice = terminalAvailable
    ? connectionError ?? stateLabel
    : environment.status === "error"
      ? environment.provisioningError ?? "Environment provisioning failed."
      : "Environment Sandbox is being provisioned.";
  const sandboxPaused = environment.sandboxState === "paused";

  return (
    <section className={styles.workspace} aria-label={`${agentLabel} terminal`}>
      <header className={styles.header} data-native-titlebar-leading-content>
        <button
          type="button"
          className={`icon-button sidebar-expand-button ${styles.navigationButton}`}
          aria-label="Expand navigation"
          title="Expand navigation"
          onClick={onToggleSidebar}
        >
          <PanelLeftOpen size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`icon-button mobile-menu-button ${styles.navigationButton}`}
          aria-label="Open Environment navigation"
          onClick={onToggleSidebar}
        >
          <PanelLeftOpen size={17} aria-hidden="true" />
        </button>
        <div className={styles.identity}>
          <span className={styles.prompt} aria-hidden="true">
            $
          </span>
          <strong>{environment.name}</strong>
          <span>/</span>
          <span>{environment.codingAgent.harness}</span>
        </div>
        <div className={styles.status} aria-label="Agent terminal status">
          <span
            className={`${styles.statusDot} ${
              terminalAvailable && connectionState === "connected"
                ? styles.statusLive
                : environment.status === "error" ||
                    connectionState === "error" ||
                    connectionState === "exited"
                  ? styles.statusError
                  : styles.statusPending
            }`}
            aria-hidden="true"
          />
          <span>{stateLabel}</span>
          <span className={styles.separator}>/</span>
          <strong>{controlRole}</strong>
        </div>
      </header>

      <div className={styles.terminalBody}>
        <div ref={terminalHostRef} className={styles.terminalHost} />
        {controlRole === "viewer" && connectionState === "connected" ? (
          <div className={styles.viewerNotice} role="status">
            <span>VIEW ONLY — another device controls this Agent</span>
            <button type="button" onClick={takeControl}>
              <Hand size={14} aria-hidden="true" />
              TAKE CONTROL
            </button>
          </div>
        ) : null}
        {!terminalAvailable || connectionState !== "connected" ? (
          <div
            className={`${styles.connectionNotice} ${
              environment.status === "error" || connectionState === "error"
                ? styles.connectionError
                : ""
            }`}
            role={
              environment.status === "error" || connectionState === "error"
                ? "alert"
                : "status"
            }
          >
            <span>{terminalNotice}</span>
            {terminalAvailable &&
              (connectionState === "error" || connectionState === "exited") && (
              <button type="button" onClick={restartTerminal}>
                <RotateCcw size={13} aria-hidden="true" />
                RECONNECT
              </button>
            )}
          </div>
        ) : null}
      </div>

      <footer
        ref={controlsRef}
        className={styles.controls}
        aria-label="Terminal controls"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setOpenPanel(undefined);
          }
        }}
      >
        {actionError ? (
          <div className={styles.actionError} role="alert">
            {actionError}
          </div>
        ) : null}
        <div className={styles.actions}>
          <button type="button" onClick={onOpenFiles}>
            <FolderTree size={15} aria-hidden="true" /> Files
          </button>
          <button
            type="button"
            disabled={controlRole !== "controller"}
            onClick={() => void pasteFromClipboard()}
          >
            <ClipboardPaste size={15} aria-hidden="true" /> Paste
          </button>
          <button
            type="button"
            aria-expanded={openPanel === "keys"}
            aria-controls={openPanel === "keys" ? panelId : undefined}
            onClick={(event) => togglePanel("keys", event.currentTarget)}
          >
            <Keyboard size={15} aria-hidden="true" /> Keys
          </button>
          <button
            type="button"
            aria-expanded={openPanel === "actions"}
            aria-controls={openPanel === "actions" ? panelId : undefined}
            onClick={(event) => togglePanel("actions", event.currentTarget)}
          >
            <MoreHorizontal size={15} aria-hidden="true" /> More
          </button>
        </div>
        {openPanel ? (
          <div
            id={panelId}
            className={`${styles.panel} ${openPanel === "keys" ? styles.virtualKeys : styles.environmentActions}`}
            role="group"
            aria-label={openPanel === "keys" ? "Terminal special keys" : "Environment actions"}
          >
            {openPanel === "keys" ? VIRTUAL_KEYS.map((key) => (
              <button
                key={key.label}
                type="button"
                disabled={controlRole !== "controller"}
                onClick={() => sendInput(key.data)}
              >
                {key.label}
              </button>
            )) : (
              <>
                <button type="button" onClick={() => {
                    setOpenPanel(undefined);
                    onOpenSnapshots();
                  }}>
                  <Camera size={15} aria-hidden="true" /> Snapshots
                </button>
                <button type="button" onClick={() => {
                    setOpenPanel(undefined);
                    onOpenFork();
                  }}>
                  <GitFork size={15} aria-hidden="true" /> Fork
                </button>
                <button
                  type="button"
                  disabled={lifecycleBusy || !terminalAvailable}
                  onClick={() => {
                    setOpenPanel(undefined);
                    void runLifecycleAction(sandboxPaused ? onResume : onPause);
                  }}
                >
                  {sandboxPaused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
                  {sandboxPaused ? "Resume" : "Pause"}
                </button>
                <button type="button" onClick={() => {
                    setOpenPanel(undefined);
                    onOpenSettings();
                  }}>
                  <Settings size={15} aria-hidden="true" /> Settings
                </button>
                <button type="button" onClick={() => {
                    setOpenPanel(undefined);
                    clearTerminal();
                  }}>
                  <Eraser size={15} aria-hidden="true" /> Clear terminal
                </button>
                <span className={styles.coordinates} title={environment.sandboxId}>
                  sandbox:{environment.sandboxId || "provisioning"}
                </span>
              </>
            )}
          </div>
        ) : null}
      </footer>
    </section>
  );
}
