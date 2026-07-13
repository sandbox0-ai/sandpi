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
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import { getCodexUiCopy } from "@/harnesses/codex/ui";
import {
  getDefaultMockCodexModel,
  getMockCodexModels,
} from "@/harnesses/codex/models";
import type { CodexSession } from "@/harnesses/codex/types";
import type { Environment } from "@/lib/types";

import styles from "@/components/new-session-workspace.module.css";

interface NewSessionWorkspaceProps {
  language: OperationLanguage;
  sendShortcut: SendShortcut;
  environment: Environment;
  onCreated: (session: CodexSession) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}

export function CodexNewSessionWorkspace({
  language,
  sendShortcut,
  environment,
  onCreated,
  onOpenSettings,
  onToggleSidebar,
}: NewSessionWorkspaceProps) {
  const ui = getCodexUiCopy(language).newSession;
  const modelOptions = getMockCodexModels();
  const [prompt, setPrompt] = useState("");
  const [selectedModelId, setSelectedModelId] = useState(
    getDefaultMockCodexModel().id,
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
    setSelectedModelId(getDefaultMockCodexModel().id);
  }, [environment.id]);

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
          modelId: selectedModelId,
        }),
      });
      const payload = (await response.json()) as {
        data?: CodexSession;
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
          {/*
            Codex slash-command completion belongs in this Codex composer. Future harnesses
            provide their own composer instead of registering commands in a shared catalog.
          */}
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
                    value={selectedModelId}
                    onChange={(event) =>
                      setSelectedModelId(event.target.value)
                    }
                  >
                    {modelOptions.map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.displayName}
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
