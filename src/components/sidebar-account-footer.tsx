"use client";

import {
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Gauge,
  Github,
  LogOut,
  Settings,
  Smartphone,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { HelpFeedbackDialog } from "@/components/help-feedback-dialog";
import { SidebarAccountSummary } from "@/components/sidebar-primitives";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { loggedOutHomeUrl } from "@/lib/auth-navigation";
import {
  formatGiBHours,
  type SandpiBillingSummary,
} from "@/lib/billing";
import { SANDPI_GITHUB_REPOSITORY_URL } from "@/lib/help-feedback";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import type { SandpiUser } from "@/lib/types";

interface SidebarAccountFooterProps {
  language: OperationLanguage;
  viewer: SandpiUser;
  showPreferences?: boolean;
}

export function SidebarAccountFooter({
  language,
  viewer,
  showPreferences = true,
}: SidebarAccountFooterProps) {
  const ui = getOperationUiCopy(language).sidebar;
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [helpFeedbackOpen, setHelpFeedbackOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountActionError, setAccountActionError] = useState("");
  const [billingSummary, setBillingSummary] =
    useState<SandpiBillingSummary>();
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageUnavailable, setUsageUnavailable] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const focusFrame = window.requestAnimationFrame(() => {
      accountMenuRef.current
        ?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")
        ?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !accountMenuRef.current?.contains(target) &&
        !accountTriggerRef.current?.contains(target)
      ) {
        setAccountMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAccountMenuOpen(false);
      window.requestAnimationFrame(() => accountTriggerRef.current?.focus());
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const controller = new AbortController();
    setUsageLoading(true);
    setUsageUnavailable(false);
    void apiFetch<ApiEnvelope<SandpiBillingSummary>>(
      "/api/v1/billing/summary",
      { signal: controller.signal },
    )
      .then((response) => {
        if (!controller.signal.aborted) setBillingSummary(response.data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsageUnavailable(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setUsageLoading(false);
      });

    return () => controller.abort();
  }, [accountMenuOpen]);

  function handleAccountMenuKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not([disabled])",
      ),
    );
    const activeIndex = menuItems.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown") {
      nextIndex = activeIndex < menuItems.length - 1 ? activeIndex + 1 : 0;
    } else if (event.key === "ArrowUp") {
      nextIndex = activeIndex > 0 ? activeIndex - 1 : menuItems.length - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = menuItems.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setAccountActionError("");
    try {
      await apiFetch<void>("/api/v1/auth/logout", { method: "POST" });
      window.location.replace(loggedOutHomeUrl(window.location.href));
    } catch {
      setAccountActionError(ui.logoutFailed);
      setLoggingOut(false);
    }
  }

  function closeHelpFeedback() {
    setHelpFeedbackOpen(false);
    window.requestAnimationFrame(() => accountTriggerRef.current?.focus());
  }

  const usagePercent =
    billingSummary?.usage.percentUsed == null
      ? undefined
      : Math.min(100, Math.max(0, billingSummary.usage.percentUsed));

  return (
    <>
      <button
        ref={accountTriggerRef}
        type="button"
        className={`account-menu-trigger ${accountMenuOpen ? "is-open" : ""}`}
        aria-label={
          accountMenuOpen ? ui.closeAccountMenu : ui.accountMenu
        }
        aria-haspopup="menu"
        aria-expanded={accountMenuOpen}
        onClick={() => {
          setAccountActionError("");
          setAccountMenuOpen((open) => !open);
        }}
        onKeyDown={(event) => {
          if (
            !accountMenuOpen &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            event.preventDefault();
            setAccountMenuOpen(true);
          }
        }}
      >
        <SidebarAccountSummary viewer={viewer} context={viewer.email} />
        {accountMenuOpen ? (
          <ChevronDown
            className="account-menu-indicator"
            size={14}
            aria-hidden="true"
          />
        ) : (
          <ChevronUp
            className="account-menu-indicator"
            size={14}
            aria-hidden="true"
          />
        )}
      </button>
      {accountMenuOpen ? (
        <div
          ref={accountMenuRef}
          className="sidebar-account-menu"
          role="menu"
          aria-label={ui.accountActions}
          onKeyDown={handleAccountMenuKeyDown}
        >
          <div
            className={`sidebar-account-usage ${
              billingSummary?.usage.exhausted ? "is-exhausted" : ""
            }`}
            aria-busy={usageLoading}
          >
            <div className="sidebar-account-usage-heading">
              <span>
                <Gauge size={13} aria-hidden="true" />
                {ui.sandboxRuntime}
              </span>
              {billingSummary ? <small>{billingSummary.plan.name}</small> : null}
            </div>
            {billingSummary ? (
              <>
                <strong>
                  {formatGiBHours(billingSummary.usage.usedGiBHours)}
                  {billingSummary.usage.limitGiBHours == null
                    ? ` ${ui.gibHoursUsed}`
                    : ` / ${formatGiBHours(
                        billingSummary.usage.limitGiBHours,
                      )} ${ui.gibHours}`}
                </strong>
                {usagePercent == null ? (
                  <div
                    className="sidebar-account-usage-meter is-unlimited"
                    title={ui.unlimitedRuntime}
                  />
                ) : (
                  <div
                    className="sidebar-account-usage-meter"
                    role="progressbar"
                    aria-label={ui.billingUsage}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(usagePercent)}
                  >
                    <span style={{ width: `${usagePercent}%` }} />
                  </div>
                )}
              </>
            ) : (
              <span
                className="sidebar-account-usage-state"
                aria-live="polite"
              >
                {usageLoading && !usageUnavailable
                  ? ui.loadingUsage
                  : ui.usageUnavailable}
              </span>
            )}
          </div>
          <span className="sidebar-account-menu-divider" role="separator" />
          {showPreferences ? (
            <Link
              href="/preferences"
              role="menuitem"
              onClick={() => setAccountMenuOpen(false)}
            >
              <Settings size={15} aria-hidden="true" />
              {ui.preferences}
            </Link>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAccountMenuOpen(false);
              setHelpFeedbackOpen(true);
            }}
          >
            <CircleHelp size={15} aria-hidden="true" />
            {ui.help}
          </button>
          <a
            href={SANDPI_GITHUB_REPOSITORY_URL}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            aria-label={ui.githubRepository}
            title={ui.githubRepository}
          >
            <Github size={15} aria-hidden="true" />
            <span>github.com/sandbox0-ai/sandpi</span>
          </a>
          <div className="sidebar-account-platforms" role="presentation">
            <Smartphone size={14} aria-hidden="true" />
            <span>{ui.mobileAppsComingSoon}</span>
          </div>
          <span className="sidebar-account-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            <LogOut size={15} aria-hidden="true" />
            {loggingOut ? ui.loggingOut : ui.logout}
          </button>
          {accountActionError ? (
            <p className="sidebar-account-menu-error" role="alert">
              {accountActionError}
            </p>
          ) : null}
        </div>
      ) : null}
      {helpFeedbackOpen ? (
        <HelpFeedbackDialog
          language={language}
          onClose={closeHelpFeedback}
        />
      ) : null}
    </>
  );
}
