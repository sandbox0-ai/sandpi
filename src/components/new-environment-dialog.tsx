"use client";

import {
  ArrowRight,
  Check,
  LoaderCircle,
  LockKeyhole,
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

import type { Environment } from "@/lib/types";

import styles from "./new-environment-dialog.module.css";

interface NewEnvironmentDialogProps {
  teamId: string;
  teamName: string;
  environments: Environment[];
  onCreated: (environment: Environment) => void;
  onClose: () => void;
}

interface CreateEnvironmentResponse {
  data?: Environment;
  error?: { message?: string } | string;
}

function normalizedName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function NewEnvironmentDialog({
  teamId,
  teamName,
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
      const response = await fetch("/api/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name: name.trim(),
        }),
      });

      let payload: CreateEnvironmentResponse = {};
      try {
        payload = (await response.json()) as CreateEnvironmentResponse;
      } catch {
        // The fallback below also covers an empty or non-JSON server response.
      }

      if (!response.ok || !payload.data) {
        const serverMessage =
          typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw new Error(serverMessage || "Could not create the Environment. Try again.");
      }

      onCreated(payload.data);
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
                Create a reusable workspace for {teamName}. Every new Session inherits its
                coding agent and Team ownership.
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
                  Use a short name your team will recognize.
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
              <legend>Coding agent</legend>
              <label className={styles.agentOption} aria-describedby={agentHelpId}>
                <input
                  className={styles.agentRadio}
                  type="radio"
                  name="coding-agent"
                  value="codex"
                  defaultChecked
                  disabled
                />
                <span className={styles.codexMark} aria-hidden="true">
                  <span />
                  <span />
                </span>
                <span className={styles.agentCopy}>
                  <span className={styles.agentEyebrow}>First supported harness</span>
                  <strong>Codex</strong>
                  <small>Native coding harness</small>
                </span>
                <span className={styles.lockedBadge}>
                  <Check size={12} aria-hidden="true" /> Selected · locked
                  <LockKeyhole size={13} aria-hidden="true" />
                </span>
              </label>
              <p id={agentHelpId} className={styles.agentHelp}>
                <LockKeyhole size={15} aria-hidden="true" />
                <span>
                  The coding agent is bound when this Environment is created. Every Session
                  inherits Codex and cannot switch to another coding agent later. Future harnesses
                  will be selected by creating a separate Environment.
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
            <span className={styles.footerNote}>Each Session gets an isolated Sandbox.</span>
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
