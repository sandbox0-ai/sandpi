"use client";

import {
  ArrowUp,
  AtSign,
  GitFork,
  LockKeyhole,
  Menu,
  Paperclip,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CodingSession, Environment } from "@/lib/types";

import styles from "./new-session-workspace.module.css";

interface NewSessionWorkspaceProps {
  environment: Environment;
  onCreated: (session: CodingSession) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}

const starterPrompts = [
  "Inspect this repository and explain its architecture",
  "Find the highest-risk bug and fix it",
  "Run the tests and resolve any failures",
];

export function NewSessionWorkspace({
  environment,
  onCreated,
  onOpenSettings,
  onToggleSidebar,
}: NewSessionWorkspaceProps) {
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(min-width: 641px)").matches) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => promptRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  async function createSession() {
    const instruction = prompt.trim();
    if (!instruction) {
      setError(`Tell ${environment.codingAgent.label} what to work on.`);
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
        }),
      });
      const payload = (await response.json()) as {
        data?: CodingSession;
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message || "Could not start the Session. Try again.");
      }
      onCreated(payload.data);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start the Session. Try again.",
      );
      setCreating(false);
    }
  }

  return (
    <section id="conversation" className={styles.workspace} tabIndex={-1}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.mobileMenuButton}
          aria-label="Open navigation"
          onClick={onToggleSidebar}
        >
          <Menu size={19} aria-hidden="true" />
        </button>
        <div className={styles.heading}>
          <div className={styles.breadcrumb}>
            <span>{environment.name}</span>
            <i>/</i>
            <strong>New session</strong>
          </div>
          <div className={styles.meta}>
            <span className={styles.readyDot} aria-hidden="true" />
            Ready to fork Environment r{environment.revision}
          </div>
        </div>
        <button
          type="button"
          className={styles.settingsButton}
          aria-label={`${environment.name} settings`}
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
          <h1>What should {environment.codingAgent.label} work on?</h1>
          <p>
            The first instruction creates an isolated Sandbox from {environment.name} and starts
            its bound native coding agent.
          </p>
          <div className={styles.facts}>
            <span>
              <GitFork size={13} aria-hidden="true" /> Environment r{environment.revision}
            </span>
            <span>
              <LockKeyhole size={13} aria-hidden="true" /> {environment.codingAgent.label} bound
            </span>
            <span>30-day hard TTL</span>
          </div>
        </div>

        <div className={styles.composer}>
          <textarea
            ref={promptRef}
            name="new-session-instruction"
            autoComplete="off"
            rows={3}
            value={prompt}
            placeholder={`Ask ${environment.codingAgent.label} to work on something…`}
            onChange={(event) => {
              setPrompt(event.target.value);
              if (error && event.target.value.trim()) {
                setError("");
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void createSession();
              }
            }}
          />
          <div className={styles.composerToolbar}>
            <div>
              <button type="button" aria-label="Attach file">
                <Paperclip size={17} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Mention file">
                <AtSign size={17} aria-hidden="true" />
              </button>
              <span className={styles.boundAgent}>
                <span className={styles.boundAgentMark} aria-hidden="true" />
                {environment.codingAgent.label}
                <small>Environment</small>
              </span>
            </div>
            <button
              type="button"
              className={styles.sendButton}
              aria-label={creating ? "Starting Session" : "Send instruction and start Session"}
              disabled={creating}
              onClick={() => void createSession()}
            >
              {creating ? <span className={styles.spinner} /> : <ArrowUp size={18} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.starters} aria-label="Starter instructions">
          {starterPrompts.map((starter) => (
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
