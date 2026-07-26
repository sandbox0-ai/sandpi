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
