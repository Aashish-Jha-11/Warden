import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * Loading placeholder.
 *
 * The shimmer is a gradient sweeping across a shared background-position, not
 * a per-box opacity pulse, so a screenful of them reads as one surface loading
 * rather than twenty things blinking out of step.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("shimmer h-4 w-full rounded-sm", className)}
      {...props}
    />
  );
}

export interface SkeletonTextProps extends HTMLAttributes<HTMLDivElement> {
  lines?: number;
}

export function SkeletonText({ lines = 3, className, ...props }: SkeletonTextProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {Array.from({ length: lines }, (_, i) => (
        // The last line stops short, which is what a paragraph actually does.
        <Skeleton key={i} className={i === lines - 1 ? "h-3.5 w-2/5" : "h-3.5"} />
      ))}
    </div>
  );
}

export interface SkeletonRowsProps {
  rows?: number;
  cols?: number;
}

/** Drop straight inside <TBody> so a loading table keeps its real geometry. */
export function SkeletonRows({ rows = 5, cols = 4 }: SkeletonRowsProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-3 py-3">
              <Skeleton className={c === 0 ? "h-3.5 w-3/5" : "h-3.5 w-4/5"} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
