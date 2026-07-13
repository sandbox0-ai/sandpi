"use client";

import { ArrowDown, ArrowUp, CornerDownLeft, Pin, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { searchSessions } from "@/lib/session-search";
import type { CodingSession, Environment } from "@/lib/types";

import styles from "./session-search-dialog.module.css";

interface SessionSearchDialogProps {
  environments: Environment[];
  sessions: CodingSession[];
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

export function SessionSearchDialog({
  environments,
  sessions,
  onSelect,
  onClose,
}: SessionSearchDialogProps) {
  const titleId = useId();
  const resultsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(
    () => searchSessions(sessions, environments, query).slice(0, 12),
    [environments, query, sessions],
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => inputRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function openResult(index: number) {
    const result = results[index];
    if (result) {
      onSelect(result.session.id);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
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
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            const focusable = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ) ?? [],
            );
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.target !== inputRef.current) {
            return;
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((current) =>
              results.length ? (current + 1) % results.length : 0,
            );
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) =>
              results.length ? (current - 1 + results.length) % results.length : 0,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            openResult(activeIndex);
          }
        }}
      >
        <h1 className={styles.srOnly} id={titleId}>
          Search sessions
        </h1>
        <div className={styles.searchBar}>
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            name="session-search"
            inputMode="search"
            role="searchbox"
            aria-label="Search sessions or environments"
            aria-controls={resultsId}
            aria-activedescendant={
              results[activeIndex] ? `${resultsId}-${results[activeIndex].session.id}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="Search sessions or environments…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" aria-label="Close session search" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.resultHeading}>
          <span>{query.trim() ? "Search results" : "Recent sessions"}</span>
          <small>{results.length} shown</small>
        </div>

        <div className={styles.results} id={resultsId} role="listbox">
          {results.length ? (
            results.map(({ session, environment }, index) => (
              <button
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                className={activeIndex === index ? styles.active : undefined}
                id={`${resultsId}-${session.id}`}
                key={session.id}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openResult(index)}
              >
                <span className={styles.resultLeading}>
                  {session.pinned ? <Pin size={12} aria-label="Pinned" /> : null}
                  <i data-status={session.status} aria-hidden="true" />
                </span>
                <span className={styles.resultCopy}>
                  <strong>{session.title}</strong>
                  <small>
                    {environment.name} <span>·</span> {session.harnessLabel}
                  </small>
                </span>
                <span className={styles.resultMeta}>{session.status}</span>
              </button>
            ))
          ) : (
            <div className={styles.emptyState}>
              <Search size={21} aria-hidden="true" />
              <strong>No sessions found</strong>
              <p>Try a Session title, Environment name, or coding agent.</p>
            </div>
          )}
        </div>

        <footer className={styles.footer}>
          <span>
            <ArrowUp size={12} aria-hidden="true" />
            <ArrowDown size={12} aria-hidden="true" /> Navigate
          </span>
          <span>
            <CornerDownLeft size={12} aria-hidden="true" /> Open
          </span>
          <span>
            <kbd>esc</kbd> Close
          </span>
        </footer>
      </section>
    </div>
  );
}
