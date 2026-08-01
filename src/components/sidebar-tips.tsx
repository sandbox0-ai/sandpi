"use client";

import { Check, Copy, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { copyTextToClipboard } from "@/lib/clipboard";
import { dismissSidebarTip } from "@/lib/local-ui-preferences";
import type { OperationLanguage } from "@/lib/operation-ui";
import {
  firstVisibleSidebarTip,
  type SidebarTip,
} from "@/lib/sidebar-tips";
import { useLocalUiPreferences } from "@/lib/use-local-ui-preferences";

import styles from "./sidebar-tips.module.css";

type CopyState = "idle" | "copied" | "failed";

export function SidebarTips({ language }: { language: OperationLanguage }) {
  const dismissedTipIds = useLocalUiPreferences().dismissedSidebarTips;
  const tip = firstVisibleSidebarTip(language, dismissedTipIds);

  return tip ? <SidebarTipCard key={tip.id} tip={tip} /> : null;
}

function SidebarTipCard({ tip }: { tip: SidebarTip }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  async function copyPrompt() {
    try {
      await copyTextToClipboard(tip.prompt);
      setCopyState("copied");
      if (resetTimer.current !== undefined) {
        window.clearTimeout(resetTimer.current);
      }
      resetTimer.current = window.setTimeout(() => {
        setCopyState("idle");
      }, 1_600);
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <section
      className={styles.tip}
      aria-labelledby={`sidebar-tip-${tip.id}`}
    >
      <div className={styles.header}>
        <span className={styles.spark} aria-hidden="true">
          <Sparkles size={13} />
        </span>
        <strong id={`sidebar-tip-${tip.id}`}>{tip.title}</strong>
        <span className={styles.actions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={
              copyState === "copied" ? tip.copiedLabel : tip.copyLabel
            }
            title={
              copyState === "copied" ? tip.copiedLabel : tip.copyLabel
            }
            onClick={() => void copyPrompt()}
          >
            {copyState === "copied" ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={tip.dismissLabel}
            title={tip.dismissLabel}
            onClick={() => dismissSidebarTip(tip.id)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </div>
      <p className={styles.description}>{tip.description}</p>
      <p className={styles.prompt}>{tip.prompt}</p>
      {copyState === "failed" ? (
        <p className={styles.error} role="alert">
          {tip.copyFailed}
        </p>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "copied" ? tip.copiedLabel : ""}
      </span>
    </section>
  );
}
