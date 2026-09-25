import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * A panel. Border and a lighter ground do the separating - there is no shadow
 * in the system except on things that genuinely float.
 *
 * CardHeader / CardContent / CardFooter each own their padding so a card can
 * hold a full-bleed table by simply not using CardContent.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-subtle bg-surface",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-subtle px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-base leading-tight font-semibold text-fg", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1 text-xs text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3.5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mt-auto flex items-center justify-end gap-2 border-t border-subtle px-4 py-2.5",
        className,
      )}
      {...props}
    />
  );
}
