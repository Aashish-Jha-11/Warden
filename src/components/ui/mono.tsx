"use client";

import { Check, Copy } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Inline monospace for machine-generated text: ids, idempotency keys, seeds,
 * timestamps, latencies, counts.
 *
 * Sized in em rather than a fixed step, because monospace at the same pixel
 * size as the surrounding sans reads noticeably larger; 0.95em puts the two
 * back on the same optical line wherever this lands.
 *
 * The truncation elides the MIDDLE. A uuid's distinguishing bytes are at both
 * ends, and a list of ids cut off at the tail is a list of identical strings.
 */

const TONE = {
  default: "text-fg",
  muted: "text-muted",
  faint: "text-faint",
} as const;

export interface MonoProps
  extends Omit<HTMLAttributes<HTMLElement>, "children" | "onCopy"> {
  children?: ReactNode;
  /** Required when children is not a plain string and truncate or copy is on. */
  value?: string;
  /** Total characters to show, ellipsis included. Off when omitted. */
  truncate?: number;
  /** Turns the span into a button that copies the full value. */
  copy?: boolean;
  tone?: keyof typeof TONE;
}

export function Mono({
  children,
  value,
  truncate,
  copy = false,
  tone = "default",
  className,
  title,
  ...props
}: MonoProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const text = value ?? (typeof children === "string" ? children : "");
  const shown =
    truncate && text.length > truncate ? elideMiddle(text, truncate) : (children ?? text);

  const onCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access is denied outside a secure context. Nothing to
      // recover here and nothing worth interrupting the operator over.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  }, [text]);

  const base = cn(
    "font-mono text-[0.95em] tabular-nums",
    TONE[tone],
    className,
  );

  if (!copy) {
    return (
      <span className={base} title={title ?? (truncate ? text : undefined)} {...props}>
        {shown}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      title={title ?? text}
      aria-label={copied ? "Copied" : "Copy " + text}
      className={cn(
        base,
        "group inline-flex max-w-full items-center gap-1 rounded-xs px-1 -mx-1 align-baseline",
        "pressable cursor-pointer transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "hover:bg-raised hover:text-fg",
        copied && "text-state-executed",
      )}
      {...props}
    >
      <span className="truncate">{shown}</span>
      {copied ? (
        <Check aria-hidden className="size-3 shrink-0" />
      ) : (
        <Copy
          aria-hidden
          className="size-3 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
}

function elideMiddle(text: string, total: number): string {
  if (total < 4) return text.slice(0, total);
  // Weighted to the head: a prefix carries more recognition than a suffix.
  const head = Math.ceil((total - 1) * 0.6);
  const tail = total - 1 - head;
  return text.slice(0, head) + "…" + (tail > 0 ? text.slice(-tail) : "");
}
