"use client";

import type { SearchAddon as XTermSearchAddon } from "@xterm/addon-search";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiWebSocketUrl } from "@/lib/api-client";

export type TerminalConnectionState =
  | "initializing"
  | "connecting"
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
  type: "ack" | "error" | "event" | "ready";
  error?: string;
  sessionId?: string;
  attemptId?: string;
  event?: TerminalEvent;
}

function decodeBase64(data: string) {
  const raw = window.atob(data);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function terminalRequestId(kind: string) {
  return `terminal-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    case "error":
      return "connection error";
    case "exited":
      return "process exited";
    case "initializing":
      return "starting renderer";
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
  sessionId: string,
  onOpenSearch: () => void,
) {
  const [connectionState, setConnectionState] =
    useState<TerminalConnectionState>("initializing");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rendererGeneration, setRendererGeneration] = useState(0);

  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<XTermFitAddon | null>(null);
  const searchAddonRef = useRef<XTermSearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const lastSequenceRef = useRef(0);
  const currentAttemptIdRef = useRef<string | null>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const focusTerminal = useCallback(() => terminalRef.current?.focus(), []);

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
    focusTerminal();
  }, [focusTerminal]);

  const restartTerminal = useCallback(() => {
    setConnectionError(null);
    setConnectionState("initializing");
    setRendererGeneration((generation) => generation + 1);
  }, []);

  useEffect(() => {
    const terminalHost = terminalHostRef.current;
    if (!terminalHost) return;

    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let fitFrame: number | undefined;
    let terminalExited = false;
    let terminal: XTerm | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const disposables: Array<{ dispose: () => void }> = [];

    const send = (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    };

    const sendResize = (rows: number, cols: number) => {
      send({
        type: "resize",
        requestId: terminalRequestId("resize"),
        rows,
        cols,
      });
    };

    const scheduleFit = () => {
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (disposed || !fitAddonRef.current || !terminalRef.current) return;
        try {
          fitAddonRef.current.fit();
        } catch {
          // The host can briefly have zero dimensions while the dock closes.
        }
      });
    };

    const connect = () => {
      if (disposed || terminalExited) return;
      setConnectionState("connecting");

      const search = new URLSearchParams({
        after: String(lastSequenceRef.current),
      });
      const socket = new WebSocket(
        apiWebSocketUrl(
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminal?${search.toString()}`,
        ),
      );
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setConnectionError(null);
      });
      socket.addEventListener("message", (message) => {
        try {
          const payload = JSON.parse(String(message.data)) as TerminalMessage;
          if (payload.type === "ready") {
            currentAttemptIdRef.current = payload.attemptId ?? null;
            setConnectionState("connected");
            setConnectionError(null);
            scheduleFit();
            if (terminalRef.current) {
              sendResize(terminalRef.current.rows, terminalRef.current.cols);
              terminalRef.current.focus();
            }
            return;
          }
          if (payload.type === "error") {
            setConnectionState("error");
            setConnectionError(payload.error ?? "Terminal request failed.");
            return;
          }
          if (payload.type !== "event" || !payload.event) return;
          if (payload.event.seq <= lastSequenceRef.current) return;

          lastSequenceRef.current = payload.event.seq;
          if (payload.event.dataBase64) {
            // Decoding PTY chunks as text first would corrupt split UTF-8 and
            // ANSI control sequences, so xterm receives the original bytes.
            terminal?.write(decodeBase64(payload.event.dataBase64));
          }
          if (
            isCurrentTerminalExit(
              payload.event,
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
        if (disposed || terminalExited || socketRef.current !== socket) return;
        setConnectionState("disconnected");
        const delay = Math.min(750 * 2 ** reconnectAttempt, 10_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => {
        if (!disposed) setConnectionState("error");
      });
    };

    const initialize = async () => {
      try {
        const [xtermModule, fitModule, searchModule, webLinksModule] =
          await Promise.all([
            import("@xterm/xterm"),
            import("@xterm/addon-fit"),
            import("@xterm/addon-search"),
            import("@xterm/addon-web-links"),
          ]);
        if (disposed) return;

        terminal = new xtermModule.Terminal({
          allowProposedApi: false,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "block",
          fontFamily:
            '"SFMono-Regular", "SF Mono", Menlo, Monaco, "Cascadia Mono", "Roboto Mono", "Noto Sans Mono", "WenQuanYi Micro Hei Mono", Consolas, "Liberation Mono", monospace',
          fontSize: 12.5,
          letterSpacing: 0,
          lineHeight: 1.25,
          macOptionIsMeta: true,
          rightClickSelectsWord: true,
          screenReaderMode: true,
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
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        searchAddonRef.current = searchAddon;

        disposables.push(
          terminal.onData((data) => {
            send({
              type: "input",
              requestId: terminalRequestId("input"),
              data,
            });
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
        connect();
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
      resizeObserver?.disconnect();
      disposables.forEach((disposable) => disposable.dispose());
      socketRef.current?.close();
      socketRef.current = null;
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [onOpenSearch, rendererGeneration, sessionId]);

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
  };
}
