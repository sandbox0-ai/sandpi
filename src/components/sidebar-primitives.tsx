import { SandpiMark, UserAvatar } from "@/components/identity-avatar";
import type { SandpiUser } from "@/lib/types";

export function SandpiBrandLockup() {
  return (
    <div className="brand-lockup" aria-label="Sandpi" translate="no">
      <SandpiMark className="brand-mark" />
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
      <UserAvatar viewer={viewer} />
      <span className="account-copy">
        <strong>{viewer.name}</strong>
        <small>{context}</small>
      </span>
    </>
  );
}
