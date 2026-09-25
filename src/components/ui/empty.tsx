import type { HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon;
  title: string;
  /** One line. An empty queue is good news here - say which, and why. */
  description?: string;
  action?: ReactNode;
}

/**
 * Every table and list in this console needs one of these, because empty is
 * the normal state of most of them: an approvals queue at zero means the agent
 * is inside policy, not that the page failed to load. A blank rectangle cannot
 * tell those apart; this can.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-14 text-center",
        className,
      )}
      {...props}
    >
      {Icon ? (
        <div className="mb-1 flex size-9 items-center justify-center rounded-md border border-subtle bg-raised">
          <Icon aria-hidden className="size-4 text-faint" />
        </div>
      ) : null}
      <p className="text-base font-medium text-fg">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm leading-relaxed text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
