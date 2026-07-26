import { Github, Smartphone } from "lucide-react";

import { SANDPI_GITHUB_REPOSITORY_URL } from "@/lib/help-feedback";
import type { SandpiUser } from "@/lib/types";

export function SandpiBrandLockup() {
  return (
    <div className="brand-lockup" aria-label="Sandpi" translate="no">
      <span className="brand-mark" aria-hidden="true" />
      <span>sandpi</span>
    </div>
  );
}

export function SidebarAccountSummary({
  viewer,
  context,
}: {
  viewer: SandpiUser;
  context: string;
}) {
  return (
    <>
      <span className="account-avatar">{viewer.avatarInitials}</span>
      <span className="account-copy">
        <strong>{viewer.name}</strong>
        <small>{context}</small>
      </span>
    </>
  );
}

export function SidebarProductLinks({
  githubLabel,
  mobileAppsLabel,
}: {
  githubLabel: string;
  mobileAppsLabel: string;
}) {
  return (
    <div className="sidebar-product-links">
      <a
        href={SANDPI_GITHUB_REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={githubLabel}
        title={githubLabel}
      >
        <Github size={13} aria-hidden="true" />
        <span>github.com/sandbox0-ai/sandpi</span>
      </a>
      <p>
        <Smartphone size={12} aria-hidden="true" />
        <span>{mobileAppsLabel}</span>
      </p>
    </div>
  );
}
