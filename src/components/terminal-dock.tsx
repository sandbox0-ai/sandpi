"use client";

import { Maximize2, SquareTerminal, X } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { CodingSession } from "@/lib/types";

import styles from "./terminal-dock.module.css";

export interface TerminalDockProps {
  session: CodingSession;
  onClose: () => void;
  onExpand?: () => void;
}

type TerminalLineKind = "command" | "error" | "output" | "system";

interface TerminalLine {
  id: number;
  kind: TerminalLineKind;
  content: string;
}

function initialLines(session: CodingSession): TerminalLine[] {
  return [
    {
      id: 0,
      kind: "system",
      content: `Attached to ${session.sandboxId} via supervisor ${session.supervisorSessionId}.`,
    },
    {
      id: 1,
      kind: "output",
      content: 'Sandpi mock shell · type "help" for available commands.',
    },
  ];
}

function stripMatchingQuotes(value: string) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function mockOutput(command: string, session: CodingSession): Omit<TerminalLine, "id">[] {
  const normalized = command.trim().replace(/\s+/g, " ");
  const [executable = ""] = normalized.split(" ");

  if (normalized === "help") {
    return [
      {
        kind: "output",
        content: [
          "Available mock commands:",
          "  pwd, ls, whoami, hostname, date, env",
          "  git status, git branch --show-current",
          "  node --version, npm test, cat README.md",
          "  echo <text>, clear, help",
        ].join("\n"),
      },
    ];
  }

  if (normalized === "pwd") {
    return [{ kind: "output", content: "/workspace" }];
  }

  if (normalized === "ls" || normalized === "ls -la") {
    return [
      {
        kind: "output",
        content:
          normalized === "ls"
            ? "README.md  app  package.json  tests"
            : [
                "drwxr-xr-x  1 sandpi sandpi  128 Jul 12 09:17 .",
                "drwxr-xr-x  1 root   root     48 Jul 12 09:17 ..",
                "-rw-r--r--  1 sandpi sandpi 6.8K Jul  9 14:02 README.md",
                "drwxr-xr-x  1 sandpi sandpi   96 Jul 12 09:22 app",
                "-rw-r--r--  1 sandpi sandpi 1.1K Jul 10 18:41 package.json",
                "drwxr-xr-x  1 sandpi sandpi   64 Jul 12 09:22 tests",
              ].join("\n"),
      },
    ];
  }

  if (normalized === "whoami") {
    return [{ kind: "output", content: "sandpi" }];
  }

  if (normalized === "hostname") {
    return [{ kind: "output", content: session.sandboxId }];
  }

  if (normalized === "date") {
    return [{ kind: "output", content: new Date().toString() }];
  }

  if (normalized === "env") {
    return [
      {
        kind: "output",
        content: [
          "HOME=/home/sandpi",
          "PWD=/workspace",
          "SHELL=/bin/bash",
          `SANDPI_SESSION_ID=${session.id}`,
          `SANDBOX_ID=${session.sandboxId}`,
        ].join("\n"),
      },
    ];
  }

  if (normalized === "git status") {
    return [
      {
        kind: "output",
        content: [
          `On branch ${session.branch}`,
          `Your branch is up to date with 'origin/${session.branch}'.`,
          "",
          "nothing to commit, working tree clean",
        ].join("\n"),
      },
    ];
  }

  if (normalized === "git branch --show-current") {
    return [{ kind: "output", content: session.branch }];
  }

  if (normalized === "node --version" || normalized === "node -v") {
    return [{ kind: "output", content: "v24.4.0" }];
  }

  if (normalized === "npm test") {
    return [
      {
        kind: "output",
        content: [
          "> console@0.1.0 test",
          "> vitest run",
          "",
          " ✓ tests/auth-callback.test.ts (4 tests) 31ms",
          "",
          " Test Files  1 passed (1)",
          "      Tests  4 passed (4)",
        ].join("\n"),
      },
    ];
  }

  if (normalized === "cat README.md") {
    return [
      {
        kind: "output",
        content: "# Console\n\nInternal control plane for remote agent sessions.",
      },
    ];
  }

  if (normalized === "cd" || normalized === "cd /workspace" || normalized === "cd ~") {
    return [];
  }

  if (normalized.startsWith("cd ")) {
    return [
      {
        kind: "error",
        content: `bash: cd: ${normalized.slice(3)}: No such file or directory`,
      },
    ];
  }

  if (normalized === "echo") {
    return [{ kind: "output", content: "" }];
  }

  if (normalized.startsWith("echo ")) {
    return [
      {
        kind: "output",
        content: stripMatchingQuotes(command.trim().slice(5)),
      },
    ];
  }

  return [{ kind: "error", content: `bash: ${executable}: command not found` }];
}

function TerminalDockSession({ session, onClose, onExpand }: TerminalDockProps) {
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState<TerminalLine[]>(() => initialLines(session));
  const inputId = useId();
  const outputRef = useRef<HTMLDivElement>(null);
  const nextLineId = useRef(2);

  const sandboxState = session.status === "completed" ? "offline" : "ready";
  const supervisorState =
    session.status === "completed"
      ? "ended"
      : session.status === "paused"
        ? "paused"
        : session.status === "waiting"
          ? "waiting"
          : "connected";
  const sandboxAvailable = sandboxState === "ready";
  const supervisorConnected = supervisorState === "connected";

  useEffect(() => {
    const output = outputRef.current;
    if (output) {
      output.scrollTop = output.scrollHeight;
    }
  }, [lines]);

  function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = draft.trim();

    if (!command) {
      return;
    }

    setDraft("");

    if (command === "clear") {
      setLines([]);
      return;
    }

    const additions: TerminalLine[] = [
      {
        id: nextLineId.current++,
        kind: "command",
        content: command,
      },
      ...mockOutput(command, session).map((line) => ({
        ...line,
        id: nextLineId.current++,
      })),
    ];

    setLines((current) => [...current, ...additions]);
  }

  return (
    <section className={styles.dock} aria-label={`Terminal for ${session.title}`}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.terminalIcon} aria-hidden="true">
            <SquareTerminal size={15} strokeWidth={2} />
          </span>
          <strong>Terminal</strong>
          <span className={styles.titleSeparator}>/</span>
          <span className={styles.shellName}>bash</span>
        </div>

        <div className={styles.statuses} aria-label="Terminal connection status">
          <span className={styles.statusItem}>
            <span
              className={`${styles.statusDot} ${
                sandboxAvailable ? styles.statusReady : styles.statusOffline
              }`}
              aria-hidden="true"
            />
            <span>sandbox</span>
            <strong>{sandboxState}</strong>
          </span>
          <span className={styles.statusDivider} aria-hidden="true" />
          <span className={styles.statusItem}>
            <span
              className={`${styles.statusDot} ${
                supervisorConnected
                  ? styles.statusReady
                  : supervisorState === "ended"
                    ? styles.statusOffline
                    : styles.statusWaiting
              }`}
              aria-hidden="true"
            />
            <span>supervisor</span>
            <strong>{supervisorState}</strong>
          </span>
        </div>

        <div className={styles.actions}>
          {onExpand ? (
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Expand terminal"
              onClick={onExpand}
            >
              <Maximize2 size={15} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close terminal"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div
          ref={outputRef}
          className={styles.outputRegion}
          role="log"
          aria-label="Terminal output"
          aria-live="polite"
          aria-relevant="additions"
        >
          {lines.map((line) => (
            <div className={`${styles.line} ${styles[line.kind]}`} key={line.id}>
              {line.kind === "command" ? (
                <span className={styles.previousPrompt} aria-hidden="true">
                  sandpi@{session.sandboxId}:<b>/workspace</b>$
                </span>
              ) : null}
              <span>{line.content}</span>
            </div>
          ))}
        </div>

        <form className={styles.promptRow} onSubmit={submitCommand}>
          <label className={styles.visuallyHidden} htmlFor={inputId}>
            Terminal command
          </label>
          <span className={styles.prompt} aria-hidden="true">
            <span>sandpi@{session.sandboxId}</span>:<b>/workspace</b>$
          </span>
          <input
            id={inputId}
            name="terminal-command"
            className={styles.input}
            type="text"
            value={draft}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={`${inputId}-hint`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span id={`${inputId}-hint`} className={styles.visuallyHidden}>
            Press Enter to run a mock shell command.
          </span>
        </form>
      </div>
    </section>
  );
}

export function TerminalDock(props: TerminalDockProps) {
  return <TerminalDockSession key={props.session.id} {...props} />;
}
