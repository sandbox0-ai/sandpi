"use client";

import {
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Eraser,
  Maximize2,
  Minimize2,
  RotateCcw,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { CodingSession } from "@/lib/types";

import styles from "./terminal-dock.module.css";
import {
  terminalConnectionLabel,
  useTerminalSession,
} from "./use-terminal-session";

export interface TerminalDockProps {
  session: CodingSession;
  height: number;
  maximized: boolean;
  onHeightChange: (height: number) => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

const MIN_TERMINAL_HEIGHT = 190;
const SEARCH_OPTIONS = {
  caseSensitive: false,
  incremental: true,
} as const;

function maxTerminalHeight() {
  return Math.max(MIN_TERMINAL_HEIGHT, Math.floor(window.innerHeight * 0.72));
}

function clampTerminalHeight(height: number) {
  return Math.min(maxTerminalHeight(), Math.max(MIN_TERMINAL_HEIGHT, height));
}

function TerminalDockSession({
  session,
  height,
  maximized,
  onHeightChange,
  onToggleMaximize,
  onClose,
}: TerminalDockProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFound, setSearchFound] = useState<boolean | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resizePointerRef = useRef<number | null>(null);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const {
    terminalHostRef,
    searchAddonRef,
    connectionState,
    connectionError,
    hasSelection,
    copied,
    focusTerminal,
    copySelection,
    clearTerminal,
    restartTerminal,
  } = useTerminalSession(session.id, openSearch);

  const closeSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchFound(null);
    window.requestAnimationFrame(focusTerminal);
  }, [focusTerminal, searchAddonRef]);

  const findNext = useCallback(
    (query = searchQuery) => {
      if (!query) {
        searchAddonRef.current?.clearDecorations();
        setSearchFound(null);
        return;
      }
      setSearchFound(
        searchAddonRef.current?.findNext(query, SEARCH_OPTIONS) ?? false,
      );
    },
    [searchAddonRef, searchQuery],
  );

  const findPrevious = useCallback(() => {
    if (searchQuery) {
      setSearchFound(
        searchAddonRef.current?.findPrevious(searchQuery, SEARCH_OPTIONS) ??
          false,
      );
    }
  }, [searchAddonRef, searchQuery]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const handleWindowResize = () => {
      if (height > maxTerminalHeight()) {
        onHeightChange(maxTerminalHeight());
      }
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [height, onHeightChange]);

  useEffect(
    () => () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (maximized || event.button !== 0) return;
    resizePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerRef.current !== event.pointerId) return;
    onHeightChange(clampTerminalHeight(window.innerHeight - event.clientY));
  }

  function handleResizePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizePointerRef.current !== event.pointerId) return;
    resizePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? 24 : -24;
    onHeightChange(clampTerminalHeight(height + delta));
  }

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    if (!value) {
      searchAddonRef.current?.clearDecorations();
      setSearchFound(null);
      return;
    }
    setSearchFound(
      searchAddonRef.current?.findNext(value, SEARCH_OPTIONS) ?? false,
    );
  }

  const stateLabel = terminalConnectionLabel(connectionState);
  const showConnectionNotice = connectionState !== "connected";

  return (
    <section className={styles.dock} aria-label={`Terminal for ${session.title}`}>
      <div
        className={`${styles.resizeHandle} ${maximized ? styles.resizeHandleDisabled : ""}`}
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        aria-valuemin={MIN_TERMINAL_HEIGHT}
        aria-valuemax={maxTerminalHeight()}
        aria-valuenow={Math.round(height)}
        tabIndex={maximized ? -1 : 0}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
      >
        <span aria-hidden="true" />
      </div>

      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.terminalIcon} aria-hidden="true">
            <SquareTerminal size={15} strokeWidth={2} />
          </span>
          <strong>Terminal</strong>
          <span className={styles.titleSeparator}>/</span>
          <span className={styles.shellName}>bash</span>
          <span className={styles.path} title={session.workspaceRoot}>
            {session.workspaceRoot}
          </span>
        </div>

        <div className={styles.statuses} aria-label="Terminal connection status">
          <span className={styles.sandboxName} title={session.sandboxId}>
            {session.sandboxId}
          </span>
          <span className={styles.statusDivider} aria-hidden="true" />
          <span className={styles.statusItem}>
            <span
              className={`${styles.statusDot} ${
                connectionState === "connected"
                  ? styles.statusReady
                  : connectionState === "error" || connectionState === "exited"
                    ? styles.statusOffline
                    : styles.statusWaiting
              }`}
              aria-hidden="true"
            />
            <strong>{stateLabel}</strong>
          </span>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.iconButton} ${searchOpen ? styles.iconButtonActive : ""}`}
            aria-label="Search terminal"
            aria-pressed={searchOpen}
            title="Search (⌘/Ctrl F)"
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
          >
            <Search size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={copied ? "Selection copied" : "Copy terminal selection"}
            title={copied ? "Copied" : "Copy selection"}
            disabled={!hasSelection}
            onClick={() => void copySelection()}
          >
            <ClipboardCopy size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Clear terminal"
            title="Clear buffer"
            onClick={clearTerminal}
          >
            <Eraser size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={maximized ? "Restore terminal size" : "Maximize terminal"}
            title={maximized ? "Restore" : "Maximize"}
            onClick={onToggleMaximize}
          >
            {maximized ? (
              <Minimize2 size={14} aria-hidden="true" />
            ) : (
              <Maximize2 size={14} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close terminal"
            title="Close terminal"
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {searchOpen ? (
          <div className={styles.searchBar} role="search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              aria-label="Search terminal output"
              placeholder="Find in terminal"
              spellCheck={false}
              onChange={(event) => handleSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSearch();
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) findPrevious();
                  else findNext();
                }
              }}
            />
            <span className={styles.searchCount} aria-live="polite">
              {searchQuery
                ? searchFound
                  ? "Match"
                  : "No results"
                : ""}
            </span>
            <button
              type="button"
              className={styles.searchButton}
              aria-label="Previous match"
              disabled={!searchQuery}
              onClick={findPrevious}
            >
              <ChevronUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.searchButton}
              aria-label="Next match"
              disabled={!searchQuery}
              onClick={() => findNext()}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.searchButton}
              aria-label="Close terminal search"
              onClick={closeSearch}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div
          ref={terminalHostRef}
          className={styles.terminalHost}
          role="application"
          aria-label={`Interactive terminal in ${session.sandboxId}`}
        />

        {showConnectionNotice ? (
          <div
            className={`${styles.connectionNotice} ${
              connectionState === "error" || connectionState === "exited"
                ? styles.connectionNoticeError
                : ""
            }`}
            role="status"
          >
            <span
              className={`${styles.statusDot} ${
                connectionState === "error" || connectionState === "exited"
                  ? styles.statusOffline
                  : styles.statusWaiting
              }`}
              aria-hidden="true"
            />
            <span>{connectionError ?? stateLabel}</span>
            {connectionState === "exited" ? (
              <button type="button" onClick={restartTerminal}>
                <RotateCcw size={11} aria-hidden="true" />
                Restart shell
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function TerminalDock(props: TerminalDockProps) {
  return <TerminalDockSession key={props.session.id} {...props} />;
}
