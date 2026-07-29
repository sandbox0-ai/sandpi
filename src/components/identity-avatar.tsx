import type { SandpiUser } from "@/lib/types";

function classNames(base: string, className?: string) {
  return className ? `${base} ${className}` : base;
}

export function SandpiMark({ className }: { className?: string }) {
  return (
    <span
      className={classNames("sandpi-mark", className)}
      aria-hidden="true"
    >
      <span className="sandpi-mark-bubble">
        <span className="sandpi-mark-eye sandpi-mark-eye-left" />
        <span className="sandpi-mark-eye sandpi-mark-eye-right" />
      </span>
    </span>
  );
}

export function UserAvatar({
  viewer,
  className,
  label,
}: {
  viewer: SandpiUser;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={classNames("account-avatar", className)}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {viewer.avatarInitials}
    </span>
  );
}
