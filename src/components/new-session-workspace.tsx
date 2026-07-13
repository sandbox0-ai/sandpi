"use client";

import {
  ArrowUp,
  AtSign,
  ChevronDown,
  GitFork,
  LockKeyhole,
  Menu,
  PanelLeftOpen,
  Paperclip,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  getOperationUiCopy,
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import {
  getDefaultMockCodingAgentModel,
  getMockCodingAgentModels,
} from "@/lib/coding-agent-models";
import type { CodingSession, Environment } from "@/lib/types";

import styles from "./new-session-workspace.module.css";

interface NewSessionWorkspaceProps {
  language: OperationLanguage;
  sendShortcut: SendShortcut;
  environment: Environment;
  onCreated: (session: CodingSession) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}

export function NewSessionWorkspace({
  language,
  sendShortcut,
  environment,
  onCreated,
  onOpenSettings,
  onToggleSidebar,
}: NewSessionWorkspaceProps) {
  const ui = getOperationUiCopy(language).newSession;
  const modelOptions = getMockCodingAgentModels(
    environment.codingAgent.harness,
  );
  const [prompt, setPrompt] = useState("");
  const [selectedModelLabel, setSelectedModelLabel] = useState(
    getDefaultMockCodingAgentModel(environment.codingAgent.harness).label,
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(min-width: 641px)").matches) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() =>
      promptRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  useEffect(() => {
    setSelectedModelLabel(
      getDefaultMockCodingAgentModel(environment.codingAgent.harness).label,
    );
  }, [environment.codingAgent.harness, environment.id]);

  async function createSession() {
    const instruction = prompt.trim();
    if (!instruction) {
      setError(ui.emptyInstruction(environment.codingAgent.label));
      promptRef.current?.focus();
      return;
    }

    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environmentId: environment.id,
          prompt: instruction,
          modelLabel: selectedModelLabel,
        }),
      });
      const payload = (await response.json()) as {
        data?: CodingSession;
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message || ui.startFailed);
      }
      onCreated(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui.startFailed);
      setCreating(false);
    }
  }

  return (
    <section id="conversation" className={styles.workspace} tabIndex={-1}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.desktopExpandButton}
          aria-label={ui.expandSidebar}
          title={ui.expandSidebar}
          onClick={onToggleSidebar}
        >
          <PanelLeftOpen size={19} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.mobileMenuButton}
          aria-label={ui.openNavigation}
          onClick={onToggleSidebar}
        >
          <Menu size={19} aria-hidden="true" />
        </button>
        <div className={styles.heading}>
          <div className={styles.breadcrumb}>
            <span>{environment.name}</span>
            <i>/</i>
            <strong>{ui.title}</strong>
          </div>
          <div className={styles.meta}>
            <span className={styles.readyDot} aria-hidden="true" />
            {ui.readyToFork(environment.revision)}
          </div>
        </div>
        <button
          type="button"
          className={styles.settingsButton}
          aria-label={ui.environmentSettings(environment.name)}
          onClick={onOpenSettings}
        >
          <Settings2 size={17} aria-hidden="true" />
        </button>
      </header>

      <div className={styles.content}>
        <div className={styles.intro}>
          <span className={styles.agentMark} aria-hidden="true">
            <span />
          </span>
          <h1>{ui.question(environment.codingAgent.label)}</h1>
          <p>{ui.introduction(environment.name)}</p>
          <div className={styles.facts}>
            <span>
              <GitFork size={13} aria-hidden="true" />{" "}
              {ui.environmentRevision(environment.revision)}
            </span>
            <span>
              <LockKeyhole size={13} aria-hidden="true" />{" "}
              {ui.agentBound(environment.codingAgent.label)}
            </span>
            <span>{ui.hardTtl}</span>
          </div>
        </div>

        <div className={styles.composer}>
          <textarea
            ref={promptRef}
            name="new-session-instruction"
            autoComplete="off"
            rows={3}
            value={prompt}
            placeholder={ui.placeholder(environment.codingAgent.label)}
            onChange={(event) => {
              setPrompt(event.target.value);
              if (error && event.target.value.trim()) {
                setError("");
              }
            }}
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
                  sendShortcut,
                )
              ) {
                event.preventDefault();
                void createSession();
              }
            }}
          />
          <div className={styles.composerToolbar}>
            <div>
              <button type="button" aria-label={ui.attachFile}>
                <Paperclip size={17} aria-hidden="true" />
              </button>
              <button type="button" aria-label={ui.mentionFile}>
                <AtSign size={17} aria-hidden="true" />
              </button>
              <span className={styles.boundAgent}>
                <span className={styles.boundAgentMark} aria-hidden="true" />
                <span className={styles.harnessLabel}>
                  {environment.codingAgent.label}
                </span>
                <label className={styles.modelPicker}>
                  <span className={styles.srOnly}>
                    {ui.selectModel(environment.codingAgent.label)}
                  </span>
                  <select
                    name="new-session-model"
                    aria-label={ui.selectModel(
                      environment.codingAgent.label,
                    )}
                    value={selectedModelLabel}
                    onChange={(event) =>
                      setSelectedModelLabel(event.target.value)
                    }
                  >
                    {modelOptions.map((model) => (
                      <option value={model.label} key={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} aria-hidden="true" />
                </label>
              </span>
            </div>
            <button
              type="button"
              className={styles.sendButton}
              aria-label={creating ? ui.starting : ui.sendAndStart}
              disabled={creating}
              onClick={() => void createSession()}
            >
              {creating ? (
                <span className={styles.spinner} />
              ) : (
                <ArrowUp size={18} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.starters} aria-label={ui.starterLabel}>
          {ui.starters.map((starter) => (
            <button
              type="button"
              key={starter}
              onClick={() => {
                setPrompt(starter);
                setError("");
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
  );
}
