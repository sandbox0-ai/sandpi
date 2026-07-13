import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { SandpiBrandLockup } from "@/components/sidebar-primitives";

/** Shared viewport boundary for the workspace and full-page settings surfaces. */
export function AppFrame({
  as = "div",
  className,
  children,
}: {
  as?: "div" | "main";
  className?: string;
  children: ReactNode;
}) {
  const Component = as;

  return (
    <Component className={`app-frame${className ? ` ${className}` : ""}`}>
      {children}
    </Component>
  );
}

/**
 * Stable Sidebar chrome shared by the workspace, Team settings and Preferences.
 * Callers own only the page-specific navigation body and header/footer actions.
 */
export function AppSidebar({
  className,
  bodyClassName,
  footerClassName,
  label,
  headerAction,
  footer,
  children,
}: {
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  label?: string;
  headerAction: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <aside
      className={`app-sidebar${className ? ` ${className}` : ""}`}
      aria-label={label}
    >
      <div className="sidebar-brand-row">
        <SandpiBrandLockup />
        {headerAction}
      </div>
      <div
        className={`app-sidebar-body${bodyClassName ? ` ${bodyClassName}` : ""}`}
      >
        {children}
      </div>
      {footer ? (
        <div
          className={`sidebar-footer${footerClassName ? ` ${footerClassName}` : ""}`}
        >
          {footer}
        </div>
      ) : null}
    </aside>
  );
}

export function SidebarBackAction({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      className="icon-button app-sidebar-back-action"
      href={href}
      aria-label={label}
      title={label}
    >
      <ArrowLeft size={17} aria-hidden="true" />
    </Link>
  );
}
