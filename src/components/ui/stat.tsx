import { Minus, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The readout strip.
 *
 * Not four identical cards. An operator opens this to answer one question -
 * "is anything waiting for me?" - and four equal boxes make them read all four
 * to find out. So the strip is one surface divided by hairlines, and the cell
 * that answers the question is allowed to be louder than the rest.
 *
 * Numbers are mono, tabular and large enough to read from the far side of a
 * desk, because that is the actual usage scene.
 */

export type DeltaTone = "good" | "bad" | "neutral";

const DELTA: Record<DeltaTone, { className: string; Icon: LucideIcon }> = {
  good: { className: "text-state-executed", Icon: TrendingUp },
  bad: { className: "text-state-failed", Icon: TrendingDown },
  neutral: { className: "text-faint", Icon: Minus },
};

export function StatBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 overflow-hidden rounded-lg border border-subtle bg-surface",
        "divide-x divide-y divide-subtle sm:grid-cols-2 xl:grid-cols-4 xl:divide-y-0",
        className,
      )}
      {...props}
    />
  );
}

export interface StatTileProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  label: string;
  value: ReactNode;
  /** One line of context under the number - a denominator, a window, a caveat. */
  sublabel?: string;
  /** Pre-formatted, e.g. "+3.40 pts" or "1.149x". */
  delta?: string;
  /** Inferred from a leading + or - when omitted. */
  deltaTone?: DeltaTone;
  icon?: LucideIcon;
  /** The cell that answers why the operator opened the page. At most one. */
  emphasis?: boolean;
  /** Tints the number when the value itself is the alert. */
  tone?: "default" | "proposed" | "blocked";
  /** Stagger index for the entrance. */
  index?: number;
}

const VALUE_TONE = {
  default: "text-fg",
  proposed: "text-state-proposed",
  blocked: "text-state-blocked",
} as const;

export function StatTile({
  label,
  value,
  sublabel,
  delta,
  deltaTone,
  icon: Icon,
  emphasis = false,
  tone = "default",
  index = 0,
  className,
  ...props
}: StatTileProps) {
  const resolved = deltaTone ?? inferTone(delta);
  const { className: deltaClass, Icon: DeltaIcon } = DELTA[resolved];

  return (
    <div
      data-numeric
      style={{ "--i": index } as React.CSSProperties}
      className={cn(
        "enter-rise flex min-w-0 flex-col justify-between gap-3 p-4",
        emphasis && "bg-raised/40",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon aria-hidden className="size-3.5 shrink-0 text-faint" /> : null}
        <span className="truncate text-2xs font-medium tracking-wide text-faint uppercase">
          {label}
        </span>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span
          className={cn(
            "font-mono leading-none tabular-nums",
            // The emphasised cell is nearly twice the size of its neighbours.
            // That difference is the whole point of the strip.
            emphasis ? "text-5xl font-medium" : "text-3xl",
            VALUE_TONE[tone],
          )}
        >
          {value}
        </span>
        {delta ? (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-mono text-xs tabular-nums",
              deltaClass,
            )}
          >
            <DeltaIcon aria-hidden className="size-3" />
            {delta}
          </span>
        ) : null}
      </div>

      {sublabel ? (
        <p className="text-xs leading-snug text-muted">{sublabel}</p>
      ) : (
        // Holds the baseline so cells in a row align even when only some of
        // them carry a caption.
        <p aria-hidden className="text-xs leading-snug">
          &nbsp;
        </p>
      )}
    </div>
  );
}

function inferTone(delta: string | undefined): DeltaTone {
  if (!delta) return "neutral";
  const first = delta.trim().charAt(0);
  if (first === "+") return "good";
  if (first === "-" || first === "−") return "bad";
  return "neutral";
}
