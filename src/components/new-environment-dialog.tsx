"use client";

import {
  ArrowRight,
  Check,
  ChevronRight,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  Server,
  TerminalSquare,
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

import type { Environment, Sandbox0ConnectionSummary } from "@/lib/types";

import styles from "./new-environment-dialog.module.css";

interface NewEnvironmentDialogProps {
  environments: Environment[];
  sandbox0Connections: Sandbox0ConnectionSummary[];
  defaultSandbox0ConnectionId: string;
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
  environments,
  sandbox0Connections,
  defaultSandbox0ConnectionId,
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
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [sandbox0ConnectionId, setSandbox0ConnectionId] = useState(
    sandbox0Connections.some((connection) => connection.id === defaultSandbox0ConnectionId)
      ? defaultSandbox0ConnectionId
      : (sandbox0Connections[0]?.id ?? ""),
  );
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
          name: name.trim(),
          repository: repository.trim(),
          branch: branch.trim(),
          sandbox0ConnectionId,
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

  const selectedSandbox0Connection = sandbox0Connections.find(
    (connection) => connection.id === sandbox0ConnectionId,
  );

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
              <span className={styles.kicker}>Create a reusable baseline</span>
              <h1 id={titleId}>New Environment</h1>
              <p id={descriptionId}>
                Configure the versioned workspace that every new Session will fork.
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

              <div className={styles.repositoryGrid}>
                <label className={styles.field}>
                  <span className={styles.labelRow}>
                    <span>Git repository</span>
                    <span className={styles.optional}>Optional</span>
                  </span>
                  <span className={styles.inputWithIcon}>
                    <GitBranch size={16} aria-hidden="true" />
                    <input
                      name="repository"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={240}
                      value={repository}
                      placeholder="e.g. sandbox0-ai/sandpi…"
                      onChange={(event) => setRepository(event.target.value)}
                    />
                  </span>
                  <span className={styles.fieldHint}>Leave empty for a blank /workspace.</span>
                </label>

                <label className={styles.field}>
                  <span className={styles.labelRow}>
                    <span>Branch</span>
                  </span>
                  <input
                    name="branch"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={120}
                    value={branch}
                    placeholder="e.g. main…"
                    onChange={(event) => setBranch(event.target.value)}
                  />
                  <span className={styles.fieldHint}>Defaults to main when left empty.</span>
                </label>
              </div>
            </fieldset>

            <fieldset className={styles.fieldset} disabled={creating}>
              <legend>Sandbox0 control plane</legend>
              <div className={styles.connectionGrid}>
                <label className={styles.field}>
                  <span className={styles.labelRow}>
                    <span>Connection</span>
                    <span className={styles.required}>Required</span>
                  </span>
                  <select
                    name="sandbox0-connection"
                    value={sandbox0ConnectionId}
                    required
                    onChange={(event) => setSandbox0ConnectionId(event.target.value)}
                  >
                    {sandbox0Connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                  <span className={styles.fieldHint}>
                    The default comes from Preferences and can be changed for this Environment.
                  </span>
                </label>
                <div className={styles.connectionSummary}>
                  <span aria-hidden="true">
                    <Server size={17} />
                  </span>
                  <div>
                    <strong>{selectedSandbox0Connection?.name ?? "No connection"}</strong>
                    <code>
                      {selectedSandbox0Connection?.apiHost ??
                        "Add a Sandbox0 connection in Preferences"}
                    </code>
                  </div>
                  <span className={styles.connectionBinding}>Bound at creation</span>
                </div>
              </div>
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
                  <span className={styles.agentEyebrow}>Only option available today</span>
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
                  inherits Codex and cannot switch to another coding agent later.
                </span>
              </p>
            </fieldset>

            <section className={styles.initialization} aria-labelledby={`${titleId}-initialization`}>
              <span className={styles.initializationIcon} aria-hidden="true">
                <TerminalSquare size={18} />
              </span>
              <div>
                <strong id={`${titleId}-initialization`}>Initialization creates revision 1</strong>
                <p>
                  Sandpi prepares a seed Sandbox. If you provide a repository, it checks out the
                  selected branch into /workspace before publishing the rootfs and workspace
                  baseline. Each Session receives an isolated fork of that revision.
                </p>
                <div className={styles.initializationFlow} aria-hidden="true">
                  <span>Seed Sandbox</span>
                  <ChevronRight size={13} />
                  <span>Initialize</span>
                  <ChevronRight size={13} />
                  <span>Publish r1</span>
                </div>
              </div>
            </section>

            {submitError ? (
              <p className={styles.submitError} role="alert">
                {submitError}
              </p>
            ) : null}
          </div>

          <footer className={styles.footer}>
            <span className={styles.footerNote}>You can edit initialization settings later.</span>
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
