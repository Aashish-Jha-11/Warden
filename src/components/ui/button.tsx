import { Loader2, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  // The accent's only filled use. One per screen - the thing you came to do.
  primary:
    "bg-accent text-on-accent border border-accent hover:bg-accent-soft hover:border-accent-soft active:bg-accent",
  secondary:
    "bg-surface text-fg border border-strong hover:bg-raised active:bg-surface",
  ghost:
    "bg-transparent text-muted border border-transparent hover:bg-raised hover:text-fg",
  // Outlined rather than filled: rejecting a proposal is routine work here, not
  // a last resort, and a wall of red buttons stops meaning anything.
  danger:
    "bg-transparent text-state-failed border border-state-failed/40 hover:bg-state-failed/14 hover:border-state-failed/70",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-xs rounded-sm",
  md: "h-8 gap-2 px-3 text-sm rounded-md",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap font-medium",
    // Colour and transform are timed separately: colour settles over the
    // hover, the press lands immediately. One `transition: all` would force
    // them to share a duration and make the press feel late.
    "transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
    "pressable",
    "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
    "disabled:active:scale-100 aria-disabled:active:scale-100",
    SIZE[size],
    VARIANT[variant],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Swaps the leading icon for a spinner and blocks the click. */
  loading?: boolean;
  icon?: LucideIcon;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon: Icon,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  const Lead = loading ? Loader2 : Icon;

  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...props}
    >
      {/* The spinner replaces the icon instead of joining it, so the button
          keeps its width and a row of them does not reflow mid-approval. */}
      {Lead ? (
        <Lead
          aria-hidden
          className={cn(
            size === "sm" ? "size-3.5" : "size-4",
            loading && "animate-spin",
          )}
        />
      ) : null}
      {children}
    </button>
  );
}
