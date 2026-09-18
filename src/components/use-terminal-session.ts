"use client";

import type { SearchAddon as XTermSearchAddon } from "@xterm/addon-search";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import type {
  IBufferLine,
  ILink,
  Terminal as XTerm,
} from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiWebSocketUrl } from "@/lib/api-client";
import { randomToken } from "@/lib/id";
import {
  sandboxLoopbackMatches,
  sandboxLoopbackUrl,
} from "@/lib/sandbox-loopback-url";
import {
  advanceTerminalSequence,
  emptyTerminalReplayState,
  parseTerminalReplayState,
  rememberTerminalCommand,
  resetTerminalReplay,
  terminalReplayAfter,
  terminalReplayStorageKey,
  type TerminalReplayState,
} from "@/lib/terminal-replay-state";
import {
  TERMINAL_FAST_PATH_PROTOCOL,
  TerminalBinaryOpcode,
  decodeTerminalBase64,
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryInput,
  isTerminalEventBatchMessage,
  TerminalFastPathMetrics,
} from "@/lib/terminal-fast-path";
import { terminalReplayMemoryCache } from "@/lib/terminal-replay-cache";

export type TerminalConnectionState =
  | "initializing"
  | "waiting"
  | "connecting"
  | "restoring"
  | "connected"
  | "disconnected"
  | "error"
  | "exited";

interface TerminalEvent {
  seq: number;
  attemptId?: string;
  stream?: string;
  dataBase64?: string;
  type: string;
}

interface TerminalMessage {
  type:
    | "ack"
    | "error"
    | "event"
    | "events"
    | "ready"
    | "control.granted"
    | "control.revoked"
    | "control.state";
  code?: string;
  error?: string;
  requestId?: string;
  sessionId?: string;
  attemptId?: string;
  replayAfter?: number;
  replayUntil?: number;
  replayReset?: boolean;
  protocol?: string;
  event?: TerminalEvent;
  fromSeq?: number;
  toSeq?: number;
 stream?: string;
  dataBase64?: string;
  control?: {
    role: "controller" | "viewer";
    leaseVersion: number;
    expiresAt: number;
  };
}

interface TerminalFastPathWindow extends Window {
  __sandpiTerminalFastPathMetrics?: TerminalFastPathMetrics;
}

const MAX_TERMINAL_RECONNECT_ATTEMPTS = 5;
const TERMINAL_CLIENT_ID_STORAGE_KEY = "sandpi.terminal-client.v1";
const TERMINAL_ATTACHMENT_ID_STORAGE_KEY = "sandpi.terminal-attachment.v1";
const TERMINAL_SCREEN_READER_STORAGE_KEY = "sandpi.terminal.screen-reader.v1";
const TERMINAL_INPUT_OUTBOX_MAX_ENTRIES = 256;
const TERMINAL_INPUT_OUTBOX_MAX_BYTES = 1_000_000;

function terminalClientId() {
  const generated = () => randomToken(32);
  try {
    let deviceId = window.localStorage.getItem(TERMINAL_CLIENT_ID_STORAGE_KEY);
    if (!deviceId) {
      deviceId = generated();
      window.localStorage.setItem(TERMINAL_CLIENT_ID_STORAGE_KEY, deviceId);
    }
    let attachmentId = window.sessionStorage.getItem(
      TERMINAL_ATTACHMENT_ID_STORAGE_KEY,
    );
    if (!attachmentId) {
      attachmentId = generated();
      window.sessionStorage.setItem(
        TERMINAL_ATTACHMENT_ID_STORAGE_KEY,
        attachmentId,
      );
    }
    return `device-${deviceId}:attachment-${attachmentId}`;
  } catch {
    return `ephemeral-${generated()}`;
  }
}

function terminalColumnForStringIndex(
  line: IBufferLine,
  stringIndex: number,
) {
  let remaining = stringIndex;
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    if (remaining === 0) return column;
    remaining -= cell.getChars().length || 1;
    if (remaining < 0) return column;
  }
  return remaining === 0 ? line.length : undefined;
}

function terminalRequestId(kind: string) {
  return `terminal-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function terminalScreenReaderMode() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TERMINAL_SCREEN_READER_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

async function copyText(text: string) {
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

export function terminalConnectionLabel(state: TerminalConnectionState) {
  switch (state) {
    case "connected":
      return "live";
    case "disconnected":
      return "reconnecting";
    case "restoring":
      return "restoring screen";
    case "error":
      return "connection error";
    case "exited":
      return "process exited";
    case "initializing":
      return "starting renderer";
    case "waiting":
      return "waiting for Environment";
    default:
      return "connecting";
  }
}

export function isCurrentTerminalExit(
  event: Pick<TerminalEvent, "attemptId" | "type">,
  currentAttemptId: string | null,
) {
  const exited = event.type === "attempt.exited" || event.type === "exit";
  return (
    exited &&
    (!event.attemptId || event.attemptId === currentAttemptId)
  );
}

/**
 * Owns the browser terminal emulator and its durable Supervisor transport.
 * The xterm buffer stays mounted across WebSocket reconnects while the event
 * cursor requests only output missed during the network interruption.
 */
export function useTerminalSession(
  environmentId: string,
  onOpenSearch: () => void,
  onOpenSandboxPreview: (url: string) => void,
  options: {
    surface?: "shell" | "agent";
    enabled?: boolean;
    screenReaderMode?: boolean;
  } = {},
) {
  const surface = options.surface ?? "shell";
  const enabled = options.enabled ?? true;
  const screenReaderMode = options.screenReaderMode ?? terminalScreenReaderMode();
  const [connectionState, setConnectionState] =
    useState<TerminalConnectionState>("initializing");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [controlRole, setControlRole] = useState<"controller" | "viewer">(
    surface === "agent" ? "viewer" : "controller",
  );

  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<XTermFitAddon | null>(null);
  const searchAddonRef = useRef<XTermSearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sendMessageRef = useRef<(message: Record<string, unknown>) => boolean>(
    () => false,
  );
  const controlRoleRef = useRef(controlRole);
  controlRoleRef.current = controlRole;
  const replayStateRef = useRef<TerminalReplayState | null>(null);
  if (replayStateRef.current === null) {
    if (typeof window === "undefined") {
      replayStateRef.current = emptyTerminalReplayState();
    } else {
      try {
        replayStateRef.current = parseTerminalReplayState(
          window.localStorage.getItem(
            terminalReplayStorageKey(
              surface === "agent" ? `${environmentId}:agent` : environmentId,
            ),
          ),
        );
      } catch {
        replayStateRef.current = emptyTerminalReplayState();
      }
    }
  }
  const lastSequenceRef = useRef(
    terminalReplayAfter(replayStateRef.current),
  );
  const receivedSequenceRef = useRef(lastSequenceRef.current);
  const currentAttemptIdRef = useRef<string | null>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);
  const pendingCommandStartRef = useRef<number | null>(null);
  const fastPathMetricsRef = useRef(new TerminalFastPathMetrics());
  const sendInputRef = useRef<(data: string, binary?: boolean) => boolean>(
    () => false,
  );
  const inputSequenceRef = useRef(0);
  const fastPathMetrics = fastPathMetricsRef.current;

  const persistReplayState = useCallback(() => {
    if (typeof window === "undefined" || !replayStateRef.current) return;
    try {
      window.localStorage.setItem(
        terminalReplayStorageKey(
          surface === "agent" ? `${environmentId}:agent` : environmentId,
        ),
        JSON.stringify(replayStateRef.current),
      );
    } catch {
      // Terminal recovery remains available for this mount when storage is disabled.
    }
  }, [environmentId, surface]);

  const focusTerminal = useCallback(() => terminalRef.current?.focus(), []);

  const fitTerminal = useCallback(() => {
    const host = terminalHostRef.current;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fitAddonRef.current?.fit();
    } catch {
      // The dock can change layout between measuring and fitting.
    }
  }, []);

  const copySelection = useCallback(async () => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!(await copyText(selection))) return;
    setCopied(true);
    if (copiedTimerRef.current !== undefined) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1_200);
    focusTerminal();
  }, [focusTerminal]);

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
    if (replayStateRef.current) {
      replayStateRef.current = resetTerminalReplay(
        replayStateRef.current,
        receivedSequenceRef.current,
      );
      persistReplayState();
    }
    focusTerminal();
  }, [focusTerminal, persistReplayState]);

  const restartTerminal = useCallback(() => {
    setConnectionError(null);
    setConnectionState("initializing");
    setRendererGeneration((generation) => generation + 1);
  }, []);

  const takeControl = useCallback(() => {
    sendMessageRef.current({
      type: "control.takeover",
      requestId: terminalRequestId("take-control"),
    });
  }, []);

  const sendInput = useCallback((data: string) => {
    if (controlRoleRef.current !== "controller") return false;
    return sendInputRef.current(data);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const terminalWindow = window as TerminalFastPathWindow;
    const previousMetrics = terminalWindow.__sandpiTerminalFastPathMetrics;
    terminalWindow.__sandpiTerminalFastPathMetrics = fastPathMetrics;
    return () => {
      if (
        terminalWindow.__sandpiTerminalFastPathMetrics === fastPathMetrics
      ) {
        delete terminalWindow.__sandpiTerminalFastPathMetrics;
      } else if (previousMetrics) {
        terminalWindow.__sandpiTerminalFastPathMetrics = previousMetrics;
      }
    };
  }, [fastPathMetrics]);

  useEffect(() => {
    const terminalHost = terminalHostRef.current;
    if (!terminalHost) return;
    if (!enabled) {
      setConnectionState("waiting");
      setConnectionError(null);
      return;
    }

    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let fitFrame: number | undefined;
    let replayPersistTimer: number | undefined;
    let terminalExited = false;
    let terminalFailed = false;
    let replayComplete = false;
    let fastPathEnabled = false;
    let terminal: XTerm | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const textEncoder = new TextEncoder();
    const inputIdPrefix = randomToken(24);
    const replayCacheKey =
      surface === "agent" ? `${environmentId}:agent` : environmentId;
    const inputOutbox: Array<{ data: Uint8Array; binary: boolean }> = [];
    let inputOutboxBytes = 0;
    const disposables: Array<{ dispose: () => void }> = [];

    const send = (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    };
    sendMessageRef.current = send;

    const flushInputOutbox = () => {
      if (!replayComplete) return;
      while (inputOutbox.length > 0) {
        const pending = inputOutbox[0];
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        inputSequenceRef.current += 1;
        const sequence = inputSequenceRef.current;
        const requestId = `${pending.binary ? "b" : "j"}:${inputIdPrefix}:${sequence}`;
        if (fastPathEnabled) {
          socket.send(encodeTerminalBinaryInput(sequence, pending.data));
          fastPathMetricsRef.current.recordInputSent(requestId, true);
        } else if (pending.binary) {
          let binary = "";
          for (const byte of pending.data) binary += String.fromCharCode(byte);
          fastPathMetricsRef.current.recordInputSent(requestId, false);
          socket.send(
            JSON.stringify({
              type: "binary",
              requestId,
              dataBase64: window.btoa(binary),
            }),
          );
        } else {
          fastPathMetricsRef.current.recordInputSent(requestId, false);
          socket.send(
            JSON.stringify({
              type: "input",
              requestId,
              data: new TextDecoder().decode(pending.data),
            }),
          );
        }
        inputOutbox.shift();
        inputOutboxBytes -= pending.data.byteLength;
      }
    };

    sendInputRef.current = (data: string, binary = false) => {
      const payload = binary
        ? Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff)
        : textEncoder.encode(data);
      if (payload.byteLength === 0) return true;
      if (
        inputOutbox.length >= TERMINAL_INPUT_OUTBOX_MAX_ENTRIES ||
        inputOutboxBytes + payload.byteLength > TERMINAL_INPUT_OUTBOX_MAX_BYTES
      ) {
        setConnectionState("error");
        setConnectionError("Too much terminal input is waiting to reconnect.");
        return false;
      }
      inputOutbox.push({ data: payload, binary });
      inputOutboxBytes += payload.byteLength;
      flushInputOutbox();
      return true;
    };

    const sendResize = (rows: number, cols: number) => {
      if (surface === "agent" && controlRoleRef.current !== "controller") {
        return false;
      }
      send({
        type: "resize",
        requestId: terminalRequestId("resize"),
        rows,
        cols,
      });
      return true;
    };

    const scheduleReplayPersist = () => {
      if (replayPersistTimer !== undefined) return;
      replayPersistTimer = window.setTimeout(() => {
        replayPersistTimer = undefined;
        persistReplayState();
      }, 250);
    };

    const trackSubmittedCommands = (data: string) => {
      // Bookmark the Supervisor cursor before the first input byte rather than
      // at Enter, because PTY echo events may already contain most of the typed
      // command by then. This stays a client concern and does not inject shell
      // integration into the user's Bash configuration.
      let changed = false;
      for (const character of data) {
        if (character === "\r" || character === "\n") {
          if (
            pendingCommandStartRef.current !== null &&
            replayStateRef.current
          ) {
            replayStateRef.current = rememberTerminalCommand(
              replayStateRef.current,
              pendingCommandStartRef.current,
            );
            changed = true;
          }
          pendingCommandStartRef.current = null;
          continue;
        }
        if (character === "\u0003") {
          pendingCommandStartRef.current = null;
          continue;
        }
        pendingCommandStartRef.current ??= receivedSequenceRef.current;
      }
      if (changed) persistReplayState();
    };

    const scheduleFit = () => {
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (disposed || !fitAddonRef.current || !terminalRef.current) return;
        fitTerminal();
      });
    };

    const connect = () => {
      if (disposed || terminalExited) return;
      if (terminal) terminal.options.disableStdin = true;
      setConnectionState("connecting");

      const search = new URLSearchParams({
        after: String(receivedSequenceRef.current),
        protocol: TERMINAL_FAST_PATH_PROTOCOL,
        inputId: inputIdPrefix,
      });
      const expectedTerminalSessionId =
        replayStateRef.current?.terminalSessionId;
      if (expectedTerminalSessionId) {
        search.set(
          surface === "agent" ? "agentSessionId" : "terminalSessionId",
          expectedTerminalSessionId,
        );
      }
      if (surface === "agent") search.set("clientId", terminalClientId());
      const socket = new WebSocket(
        apiWebSocketUrl(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/${
            surface === "agent" ? "agent-terminal" : "terminal"
          }?${search.toString()}`,
        ),
      );
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      let replayUntil = receivedSequenceRef.current;
      let replayFinished = false;
      let currentSessionId: string | undefined;

      const writeTerminalOutput = (
        fromSeq: number,
        toSeq: number,
        bytes: Uint8Array,
      ) => {
        receivedSequenceRef.current = toSeq;
        fastPathMetricsRef.current.recordOutputReceived(toSeq, bytes.byteLength);
        if (currentSessionId) {
          terminalReplayMemoryCache().append(replayCacheKey, currentSessionId, {
            fromSeq,
            toSeq,
            data: bytes,
          });
        }
        fastPathMetricsRef.current.markOutputDecoded(toSeq);
        fastPathMetricsRef.current.markOutputWriteQueued(toSeq);
        const commitRenderedOutput = () => {
          fastPathMetricsRef.current.markOutputWriteComplete(toSeq);
          if (toSeq > lastSequenceRef.current) {
            lastSequenceRef.current = toSeq;
            if (replayStateRef.current) {
              replayStateRef.current = advanceTerminalSequence(
                replayStateRef.current,
                toSeq,
              );
              scheduleReplayPersist();
            }
          }
          if (toSeq >= replayUntil) finishReplay();
        };
        terminal?.write(bytes, commitRenderedOutput);
      };

      const finishReplay = () => {
        if (
          replayFinished ||
          disposed ||
          terminalExited ||
          socketRef.current !== socket
        ) {
          return;
        }
        replayFinished = true;
        replayComplete = true;
        if (terminal) {
          terminal.options.disableStdin =
            surface === "agent" && controlRoleRef.current !== "controller";
        }
        setConnectionState("connected");
        setConnectionError(null);
        fitTerminal();
        if (terminalRef.current) {
          sendResize(terminalRef.current.rows, terminalRef.current.cols);
          terminalRef.current.focus();
        }
        flushInputOutbox();
      };

      socket.addEventListener("open", () => {
        setConnectionError(null);
      });
      socket.addEventListener("message", (message) => {
        try {
          if (message.data instanceof ArrayBuffer) {
            const frame = decodeTerminalBinaryFrame(message.data);
            if (
              !frame ||
              frame.opcode !== TerminalBinaryOpcode.Output ||
              frame.fromSeq !== receivedSequenceRef.current + 1
            ) {
              throw new Error("Invalid terminal output frame.");
            }
            writeTerminalOutput(frame.fromSeq, frame.toSeq, frame.payload);
            return;
          }
          const payload = JSON.parse(String(message.data)) as TerminalMessage;
          if (payload.type === "ready") {
            reconnectAttempt = 0;
            const priorTerminalSessionId =
              replayStateRef.current?.terminalSessionId;
            const terminalChanged = Boolean(
              priorTerminalSessionId &&
                payload.sessionId &&
                priorTerminalSessionId !== payload.sessionId,
            );
            fastPathEnabled = payload.protocol === TERMINAL_FAST_PATH_PROTOCOL;
            replayComplete = false;
            if (terminalChanged) {
              inputOutbox.length = 0;
              inputOutboxBytes = 0;
            }
            currentSessionId = payload.sessionId;
            if (typeof payload.replayAfter === "number") {
              const replayReset = Boolean(
                payload.replayReset || terminalChanged,
              );
              if (replayReset) {
                terminal?.reset();
                lastSequenceRef.current = payload.replayAfter;
                terminalReplayMemoryCache().reset(
                  replayCacheKey,
                  payload.sessionId ?? "",
                  true,
                );
              }
              receivedSequenceRef.current = payload.replayAfter;
              replayUntil =
                typeof payload.replayUntil === "number" &&
                payload.replayUntil >= payload.replayAfter
                  ? payload.replayUntil
                  : payload.replayAfter;
              if (replayStateRef.current) {
                replayStateRef.current =
                  replayReset
                    ? resetTerminalReplay(
                        replayStateRef.current,
                        payload.replayAfter,
                        payload.sessionId,
                      )
                    : {
                        ...replayStateRef.current,
                        terminalSessionId:
                          payload.sessionId ?? priorTerminalSessionId,
                      };
                persistReplayState();
              }
            }
            currentAttemptIdRef.current = payload.attemptId ?? null;
            if (surface === "agent" && payload.control) {
              controlRoleRef.current = payload.control.role;
              setControlRole(payload.control.role);
            }
            setConnectionError(null);
            scheduleFit();
            if (receivedSequenceRef.current >= replayUntil) finishReplay();
            else setConnectionState("restoring");
            return;
          }
          if (payload.type === "ack") {
            if (payload.requestId) {
              fastPathMetricsRef.current.markInputAcknowledged(
                payload.requestId,
              );
            }
            return;
          }
          if (
            payload.type === "control.granted" ||
            payload.type === "control.revoked" ||
            payload.type === "control.state"
          ) {
            if (!payload.control) return;
            controlRoleRef.current = payload.control.role;
            setControlRole(payload.control.role);
            if (terminal) {
              terminal.options.disableStdin =
                payload.control.role !== "controller";
            }
            if (payload.control.role === "controller") {
              fitTerminal();
              if (terminalRef.current) {
                sendResize(
                  terminalRef.current.rows,
                  terminalRef.current.cols,
                );
                terminalRef.current.focus();
              }
            }
            return;
          }
          if (payload.type === "error") {
            if (
              surface === "agent" &&
              payload.code === "agent_terminal_control_required"
            ) {
              controlRoleRef.current = "viewer";
              setControlRole("viewer");
              if (terminal) terminal.options.disableStdin = true;
              return;
            }
            // A structured server error is an operation failure, not a network
            // interruption. Keep it visible and wait for an explicit Retry;
            // otherwise an auth/configuration error reconnects forever.
            terminalFailed = true;
            setConnectionState("error");
            setConnectionError(payload.error ?? "Terminal request failed.");
            return;
          }
          if (payload.type === "events") {
            if (!isTerminalEventBatchMessage(payload)) return;
            if (
              payload.fromSeq !== receivedSequenceRef.current + 1 ||
              payload.toSeq < payload.fromSeq
            ) {
              throw new Error("Terminal event batch has a sequence gap.");
            }
            writeTerminalOutput(
              payload.fromSeq,
              payload.toSeq,
              decodeTerminalBase64(payload.dataBase64),
            );
            return;
          }
          if (payload.type !== "event" || !payload.event) return;
          if (payload.event.seq <= receivedSequenceRef.current) return;
          const event = payload.event;
          // Decoding PTY chunks as text first would corrupt split UTF-8 and
          // ANSI control sequences. The callback also makes the persisted
          // cursor represent output xterm has actually parsed, not merely
          // WebSocket frames the browser received.
          writeTerminalOutput(
            event.seq,
            event.seq,
            event.dataBase64
              ? decodeTerminalBase64(event.dataBase64)
              : new Uint8Array(),
          );
          if (
            isCurrentTerminalExit(
              event,
              currentAttemptIdRef.current,
            )
          ) {
            terminalExited = true;
            setConnectionState("exited");
          }
        } catch (error) {
          setConnectionState("error");
          setConnectionError(
            error instanceof Error ? error.message : "Invalid terminal event.",
          );
        }
      });
      socket.addEventListener("close", () => {
        if (
          disposed ||
          terminalExited ||
          terminalFailed ||
          socketRef.current !== socket
        ) {
          return;
        }
        if (terminal) terminal.options.disableStdin = true;
        replayComplete = false;
        if (reconnectAttempt >= MAX_TERMINAL_RECONNECT_ATTEMPTS) {
          terminalFailed = true;
          setConnectionState("error");
          setConnectionError(
            "Terminal connection could not be restored. Retry when the Environment is available.",
          );
          return;
        }
        setConnectionState("disconnected");
        const delay = Math.min(750 * 2 ** reconnectAttempt, 10_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => {
        if (!disposed && !terminalFailed) setConnectionState("error");
      });
    };

    const initialize = async () => {
      try {
        const [
          xtermModule,
          fitModule,
          searchModule,
          webLinksModule,
          webglModule,
        ] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-search"),
          import("@xterm/addon-web-links"),
          import("@xterm/addon-webgl"),
        ]);
        if (disposed) return;

        terminal = new xtermModule.Terminal({
          allowProposedApi: false,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "block",
          disableStdin: true,
          fontFamily:
            '"SFMono-Regular", "SF Mono", Menlo, Monaco, "Cascadia Mono", "Roboto Mono", "Noto Sans Mono", "WenQuanYi Micro Hei Mono", Consolas, "Liberation Mono", monospace',
          fontSize: 12.5,
          letterSpacing: 0,
          lineHeight: 1.25,
          macOptionIsMeta: true,
          rightClickSelectsWord: true,
          screenReaderMode,
          scrollback: 10_000,
          theme: {
            background: "#151715",
            foreground: "#e4e6df",
            cursor: "#d8dbd2",
            cursorAccent: "#151715",
            selectionBackground: "#44607999",
            selectionInactiveBackground: "#39443d66",
            black: "#20231f",
            red: "#df8880",
            green: "#83c798",
            yellow: "#dfb66f",
            blue: "#8daed1",
            magenta: "#c59ac8",
            cyan: "#80bfc2",
            white: "#d7dad2",
            brightBlack: "#73786f",
            brightRed: "#f19b91",
            brightGreen: "#9bd9aa",
            brightYellow: "#edc983",
            brightBlue: "#a2c2e1",
            brightMagenta: "#d9addb",
            brightCyan: "#96d3d4",
            brightWhite: "#f5f6f1",
          },
        });
        const fitAddon = new fitModule.FitAddon();
        const searchAddon = new searchModule.SearchAddon();
        const webLinksAddon = new webLinksModule.WebLinksAddon(
          (event, uri) => {
            event.preventDefault();
            const previewUrl = sandboxLoopbackUrl(uri);
            if (previewUrl) {
              onOpenSandboxPreview(previewUrl);
              return;
            }
            try {
              const parsed = new URL(uri);
              if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                window.open(parsed.href, "_blank", "noopener,noreferrer");
              }
            } catch {
              // Ignore malformed terminal-controlled links.
            }
          },
        );

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(webLinksAddon);
        terminal.open(terminalHost);
        terminal.textarea?.setAttribute("aria-label", "Terminal screen");
        try {
          const webglAddon = new webglModule.WebglAddon();
          terminal.loadAddon(webglAddon);
          webglAddon.onContextLoss(() => {
            webglAddon.dispose();
            fastPathMetricsRef.current.setRenderer("dom-fallback");
          });
          fastPathMetricsRef.current.setRenderer("webgl");
        } catch {
          // WebGL can be unavailable because of GPU policy, memory pressure,
          // or browser support. xterm's DOM renderer remains the compatible
          // fallback without changing the VT parser or input model.
          fastPathMetricsRef.current.setRenderer("dom");
        }
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        searchAddonRef.current = searchAddon;

        disposables.push(
          terminal.registerLinkProvider({
            provideLinks(bufferLineNumber, callback) {
              const line = terminal?.buffer.active.getLine(
                bufferLineNumber - 1,
              );
              if (!line) {
                callback(undefined);
                return;
              }
              const links: ILink[] = [];
              for (const match of sandboxLoopbackMatches(
                line.translateToString(true),
              )) {
                const start = terminalColumnForStringIndex(line, match.start);
                const end = terminalColumnForStringIndex(line, match.end);
                if (start === undefined || end === undefined || end <= start) {
                  continue;
                }
                links.push({
                  text: match.text,
                  range: {
                    start: { x: start + 1, y: bufferLineNumber },
                    end: { x: end, y: bufferLineNumber },
                  },
                  activate(event) {
                    event.preventDefault();
                    onOpenSandboxPreview(match.url);
                  },
                });
              }
              callback(links.length > 0 ? links : undefined);
            },
          }),
        );

        disposables.push(
          terminal.onData((data) => {
            const sent = sendInputRef.current(data);
            if (sent && terminal?.buffer.active.type === "normal") {
              trackSubmittedCommands(data);
            } else if (terminal?.buffer.active.type === "alternate") {
              // Enter presses inside Vim and other full-screen TUIs are not
              // shell command boundaries.
              pendingCommandStartRef.current = null;
            }
          }),
          terminal.onBinary((data) => {
            sendInputRef.current(data, true);
          }),
          terminal.onResize(({ rows, cols }) => sendResize(rows, cols)),
          terminal.onSelectionChange(() =>
            setHasSelection(terminal?.hasSelection() ?? false),
          ),
        );

        terminal.attachCustomKeyEventHandler((event) => {
          if (event.type !== "keydown") return true;
          const key = event.key.toLowerCase();
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            key === "f"
          ) {
            onOpenSearch();
            return false;
          }
          if (
            (event.metaKey && key === "c") ||
            (event.ctrlKey && event.shiftKey && key === "c")
          ) {
            void copyText(terminal?.getSelection() ?? "");
            return false;
          }
          if (
            (event.metaKey && key === "v") ||
            (event.ctrlKey && event.shiftKey && key === "v")
          ) {
            if (navigator.clipboard?.readText) {
              void navigator.clipboard
                .readText()
                .then((text) => terminal?.paste(text));
              return false;
            }
          }
          return true;
        });

        resizeObserver = new ResizeObserver(scheduleFit);
        resizeObserver.observe(terminalHost);
        scheduleFit();
        const cachedSessionId = replayStateRef.current?.terminalSessionId;
        const cachedChunks =
          cachedSessionId &&
          terminalReplayMemoryCache().usable(
            replayCacheKey,
            cachedSessionId,
            receivedSequenceRef.current,
          );
        if (cachedChunks) {
          // Reusing a page-lifetime journal tail avoids redownloading a valid
          // retained replay when the user returns to this Environment route.
          // The procd journal remains authoritative; a server reset still
          // rebuilds xterm when this tail is no longer sufficient.
          setConnectionState("restoring");
          let remainingWrites = cachedChunks.length;
          for (const chunk of cachedChunks) {
            terminal.write(chunk.data, () => {
              remainingWrites -= 1;
              if (remainingWrites === 0 && !disposed) connect();
            });
          }
        } else {
          connect();
        }
      } catch (error) {
        if (disposed) return;
        setConnectionState("error");
        setConnectionError(
          error instanceof Error
            ? error.message
            : "Unable to start terminal renderer.",
        );
      }
    };

    void initialize();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      if (replayPersistTimer !== undefined) {
        window.clearTimeout(replayPersistTimer);
      }
      persistReplayState();
      resizeObserver?.disconnect();
      disposables.forEach((disposable) => disposable.dispose());
      socketRef.current?.close();
      socketRef.current = null;
      sendMessageRef.current = () => false;
      sendInputRef.current = () => false;
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [
    environmentId,
    enabled,
    fitTerminal,
    onOpenSandboxPreview,
    onOpenSearch,
    persistReplayState,
    rendererGeneration,
    screenReaderMode,
    surface,
  ]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== undefined) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  return {
    terminalHostRef,
    terminalRef,
    searchAddonRef,
    connectionState,
    connectionError,
    hasSelection,
    copied,
    focusTerminal,
    copySelection,
    clearTerminal,
    restartTerminal,
    controlRole,
    takeControl,
    sendInput,
    fastPathMetrics,
  };
}
