"use client";

import { Maximize2, SquareTerminal, X } from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { apiWebSocketUrl } from "@/lib/api-client";
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
      content: `Connecting to ${session.sandboxId} through the durable Sandpi terminal stream…`,
    },
  ];
}

function decodeBase64(data: string) {
  const raw = window.atob(data);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

type TerminalConnectionState = "connecting" | "connected" | "disconnected" | "error";

function TerminalDockSession({ session, onClose, onExpand }: TerminalDockProps) {
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState<TerminalLine[]>(() => initialLines(session));
  const [connectionState, setConnectionState] =
    useState<TerminalConnectionState>("connecting");
  const inputId = useId();
  const outputRef = useRef<HTMLDivElement>(null);
  const nextLineId = useRef(1);
  const socketRef = useRef<WebSocket | null>(null);
  const lastSequenceRef = useRef(0);
  const decoderRef = useRef(new TextDecoder());

  const sandboxState = connectionState === "connected" ? "ready" : "connecting";
  const supervisorState = connectionState;
  const sandboxAvailable = connectionState === "connected";
  const supervisorConnected = connectionState === "connected";

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;

    const appendLine = (kind: TerminalLineKind, content: string) => {
      if (!content) {
        return;
      }
      setLines((current) => [
        ...current,
        { id: nextLineId.current++, kind, content },
      ]);
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      setConnectionState("connecting");
      const search = new URLSearchParams({
        after: String(lastSequenceRef.current),
      });
      const socket = new WebSocket(
        apiWebSocketUrl(
          `/api/v1/sessions/${encodeURIComponent(session.id)}/terminal?${search.toString()}`,
        ),
      );
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setConnectionState("connected");
      });
      socket.addEventListener("message", (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as {
            type: "ack" | "error" | "event" | "ready";
            error?: string;
            sessionId?: string;
            event?: {
              seq: number;
              stream?: string;
              dataBase64?: string;
              type: string;
            };
          };
          if (payload.type === "ready") {
            appendLine(
              "system",
              `Connected to ${session.sandboxId}${payload.sessionId ? ` · terminal ${payload.sessionId}` : ""}.`,
            );
            return;
          }
          if (payload.type === "error") {
            setConnectionState("error");
            appendLine("error", payload.error ?? "Terminal request failed.");
            return;
          }
          if (payload.type !== "event" || !payload.event) {
            return;
          }
          if (payload.event.seq <= lastSequenceRef.current) {
            return;
          }
          lastSequenceRef.current = payload.event.seq;
          if (payload.event.dataBase64) {
            const content = decoderRef.current.decode(
              decodeBase64(payload.event.dataBase64),
              { stream: true },
            );
            appendLine(
              payload.event.stream === "stderr" ? "error" : "output",
              content,
            );
          } else if (payload.event.type === "exit") {
            appendLine("system", "Terminal process exited.");
          }
        } catch (error) {
          setConnectionState("error");
          appendLine(
            "error",
            error instanceof Error ? error.message : "Invalid terminal event.",
          );
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) {
          return;
        }
        setConnectionState("disconnected");
        const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => {
        setConnectionState("error");
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [session.id, session.sandboxId]);

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

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setLines((current) => [
        ...current,
        {
          id: nextLineId.current++,
          kind: "error",
          content: "Terminal is reconnecting. Try again in a moment.",
        },
      ]);
      return;
    }
    socket.send(
      JSON.stringify({
        type: "input",
        requestId: `terminal-input-${Date.now()}`,
        data: `${command}\n`,
      }),
    );
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
                  : supervisorState === "error" ||
                      supervisorState === "disconnected"
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
                  sandpi@{session.sandboxId}:<b>{session.workspaceRoot}</b>$
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
            <span>sandpi@{session.sandboxId}</span>:<b>{session.workspaceRoot}</b>$
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
            Press Enter to send the command to the Session terminal.
          </span>
        </form>
      </div>
    </section>
  );
}

export function TerminalDock(props: TerminalDockProps) {
  return <TerminalDockSession key={props.session.id} {...props} />;
}
