"use client";

import {
  ArrowRight,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type { Environment, EnvironmentAgentId } from "@/lib/types";

import styles from "./new-environment-dialog.module.css";

interface NewEnvironmentDialogProps {
  environments: Environment[];
  onCreated: (environment: Environment) => void;
  onClose: () => void;
}

const AGENT_OPTIONS: ReadonlyArray<{
  id: EnvironmentAgentId;
  label: string;
  description: string;
  mark: string;
}> = [
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI's native coding-agent TUI",
    mark: "CX",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic's native coding-agent TUI",
    mark: "CC",
  },
  {
    id: "pi",
    label: "Pi",
    description: "Pi's native extensible coding-agent TUI",
    mark: "PI",
  },
];

function normalizedName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function NewEnvironmentDialog({
  environments,
  onCreated,
  onClose,
}: NewEnvironmentDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();
  const agentHelpId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState<EnvironmentAgentId>("codex");
  const [nameError, setNameError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [creating, setCreating] = useState(false);

  const duplicateEnvironment = useMemo(() => {
    const candidate = normalizedName(name);
    if (!candidate) {
      return undefined;
    }
    return environments.find((environment) => normalizedName(environment.name) === candidate);
  }, [environments, name]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const shouldFocusName = window.matchMedia("(min-width: 641px)").matches;
    const focusFrame = window.requestAnimationFrame(() => {
      if (shouldFocusName) {
        nameInputRef.current?.focus();
      } else {
        dialogRef.current?.focus();
      }
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !creating) {
        event.preventDefault();
        onClose();
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [creating, onClose]);

  function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") {
      return;
    }

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hasAttribute("aria-hidden"));

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

  function validateName() {
    if (!name.trim()) {
      setNameError("Give the Environment a name.");
      return false;
    }
    setNameError("");
    return true;
  }

  async function createEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) {
      return;
    }
    if (!validateName()) {
      nameInputRef.current?.focus();
      return;
    }

    setCreating(true);
    setSubmitError("");
    window.requestAnimationFrame(() => dialogRef.current?.focus());

    try {
      const response = await apiFetch<ApiEnvelope<Environment>>(
        "/api/v1/environments",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            agentId,
          }),
        },
      );

      onCreated(response.data);
    } catch (cause) {
      setSubmitError(
        cause instanceof Error ? cause.message : "Could not create the Environment. Try again.",
      );
      setCreating(false);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creating) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={creating}
        tabIndex={-1}
        onKeyDown={keepFocusInside}
      >
        <form className={styles.form} noValidate onSubmit={createEnvironment}>
          <header className={styles.header}>
            <div>
              <span className={styles.kicker}>Create a reusable workspace</span>
              <h1 id={titleId}>New Environment</h1>
              <p id={descriptionId}>
                A shared workspace for all your Sessions.
              </p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              aria-label="Close New Environment dialog"
              disabled={creating}
              onClick={onClose}
            >
              <X size={19} aria-hidden="true" />
            </button>
          </header>

          <div className={styles.content}>
            <fieldset className={styles.fieldset} disabled={creating}>
              <legend>Environment details</legend>

              <label className={styles.field}>
                <span className={styles.labelRow}>
                  <span>Name</span>
                  <span className={styles.required}>Required</span>
                </span>
                <input
                  ref={nameInputRef}
                  name="name"
                  type="text"
                  autoComplete="off"
                  maxLength={80}
                  value={name}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={`${nameHintId}${nameError ? ` ${nameErrorId}` : ""}`}
                  placeholder="e.g. Payments API…"
                  onBlur={validateName}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (nameError && event.target.value.trim()) {
                      setNameError("");
                    }
                  }}
                />
                <span id={nameHintId} className={styles.fieldHint}>
                  Use a short name that makes this workspace easy to recognize.
                </span>
                {nameError ? (
                  <span id={nameErrorId} className={styles.fieldError} role="alert">
                    {nameError}
                  </span>
                ) : null}
                {duplicateEnvironment ? (
                  <span className={styles.duplicateWarning} role="status" aria-live="polite">
                    “{duplicateEnvironment.name}” already exists. You can continue, but a unique
                    name will make Sessions easier to distinguish.
                  </span>
                ) : null}
              </label>

            </fieldset>
            <fieldset className={styles.fieldset} disabled={creating}>
              <legend>Agent harness</legend>
              <div className={styles.agentGrid}>
                {AGENT_OPTIONS.map((agent) => (
                  <label
                    key={agent.id}
                    className={`${styles.agentOption} ${
                      agentId === agent.id ? styles.agentOptionSelected : ""
                    }`}
                    aria-describedby={agentHelpId}
                  >
                    <input
                      className={styles.agentRadio}
                      type="radio"
                      name="coding-agent"
                      value={agent.id}
                      checked={agentId === agent.id}
                      onChange={() => setAgentId(agent.id)}
                    />
                    <span className={styles.agentMark} aria-hidden="true">
                      {agent.mark}
                    </span>
                    <span className={styles.agentCopy}>
                      <strong>{agent.label}</strong>
                      <small>{agent.description}</small>
                    </span>
                    <span className={styles.agentSelected} aria-hidden="true">
                      {agentId === agent.id ? "[SELECTED]" : "[SELECT]"}
                    </span>
                  </label>
                ))}
              </div>
              <p id={agentHelpId} className={styles.agentHelp}>
                <span>
                  The Environment owns one persistent native agent TUI. Agent type cannot be
                  changed after creation; fork the Environment to experiment safely.
                </span>
              </p>
            </fieldset>

            {submitError ? (
              <p className={styles.submitError} role="alert">
                {submitError}
              </p>
            ) : null}
          </div>

          <footer className={styles.footer}>
            <span className={styles.footerNote}>
              Sessions share this Environment&apos;s Sandbox and Workspace.
            </span>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={creating}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={creating}
              >
                {creating ? (
                  <>
                    <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" />
                    Creating Environment…
                  </>
                ) : (
                  <>
                    Create Environment
                    <ArrowRight size={15} aria-hidden="true" />
                  </>
                )}
              </button>
            </div>
            <span className={styles.srOnly} aria-live="polite">
              {creating ? "Creating the Environment. Please wait." : ""}
            </span>
          </footer>
        </form>
      </section>
    </div>
  );
}
