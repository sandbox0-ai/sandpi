"use client";

import {
  BookOpen,
  Bug,
  ExternalLink,
  Lightbulb,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  SANDPI_DOCUMENTATION_URL,
  sandpiFeedbackIssueUrl,
} from "@/lib/help-feedback";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";

import styles from "./help-feedback-dialog.module.css";

interface HelpFeedbackDialogProps {
  language: OperationLanguage;
  onClose: () => void;
}

const fallbackContext = {
  pageUrl: "https://sandpi.ai/",
  userAgent: "Unknown",
};

export function HelpFeedbackDialog({
  language,
  onClose,
}: HelpFeedbackDialogProps) {
  const ui = getOperationUiCopy(language).helpFeedback;
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const firstActionRef = useRef<HTMLAnchorElement>(null);
  const [reportBugUrl, setReportBugUrl] = useState(() =>
    sandpiFeedbackIssueUrl("bug", fallbackContext),
  );
  const [shareFeedbackUrl, setShareFeedbackUrl] = useState(() =>
    sandpiFeedbackIssueUrl("feedback", fallbackContext),
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const context = {
      pageUrl: window.location.href,
      userAgent: window.navigator.userAgent,
    };
    setReportBugUrl(sandpiFeedbackIssueUrl("bug", context));
    setShareFeedbackUrl(sandpiFeedbackIssueUrl("feedback", context));
    const focusFrame = window.requestAnimationFrame(() =>
      firstActionRef.current?.focus(),
    );

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  function keepFocusInside(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }

  const actions = [
    {
      href: SANDPI_DOCUMENTATION_URL,
      icon: BookOpen,
      title: ui.documentation,
      description: ui.documentationDescription,
      first: true,
    },
    {
      href: reportBugUrl,
      icon: Bug,
      title: ui.reportBug,
      description: ui.reportBugDescription,
    },
    {
      href: shareFeedbackUrl,
      icon: Lightbulb,
      title: ui.shareFeedback,
      description: ui.shareFeedbackDescription,
    },
  ];

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={keepFocusInside}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <span>{ui.eyebrow}</span>
            <h1 id={titleId}>{ui.title}</h1>
          </div>
          <button
            type="button"
            aria-label={ui.close}
            title={ui.close}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.content}>
          <p className={styles.introduction}>{ui.description}</p>
          <div className={styles.actions}>
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <a
                  ref={action.first ? firstActionRef : undefined}
                  href={action.href}
                  target="_blank"
                  rel="noreferrer"
                  title={ui.opensNewTab}
                  key={action.title}
                >
                  <span className={styles.actionIcon} aria-hidden="true">
                    <Icon size={17} />
                  </span>
                  <span className={styles.actionCopy}>
                    <strong>{action.title}</strong>
                    <small>{action.description}</small>
                  </span>
                  <ExternalLink
                    className={styles.externalIcon}
                    size={14}
                    aria-hidden="true"
                  />
                </a>
              );
            })}
          </div>
          <p className={styles.notice}>{ui.publicIssueNotice}</p>
        </div>
      </section>
    </div>
  );
}
