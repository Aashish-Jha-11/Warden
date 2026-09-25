import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Status chips.
 *
 * This product is a status machine - an action is proposed, gated, signed and
 * fired - so a badge is not decoration here, it is the primary readout. Every
 * screen renders one, which is why the colour decision lives in this file
 * exactly once and every caller just hands over the raw enum value:
 *
 *   <Badge status={action.status} />
 *   <Badge status={run.status} />
 *
 * Unknown strings degrade to a neutral chip with a prettified label rather
 * than throwing, because a badge is never worth crashing a page over.
 */

export type BadgeTone =
  | "pending"
  | "proposed"
  | "running"
  | "approved"
  | "executed"
  | "blocked"
  | "rejected"
  | "failed"
  | "neutral"
  | "accent"
  | "quiet";

type ToneClasses = { text: string; chip: string; pip: string };

/**
 * Written out as whole literal class strings rather than composed at runtime,
 * because Tailwind's scanner reads source text and will not emit a class that
 * only exists after a template interpolation.
 */
export const TONE: Record<BadgeTone, ToneClasses> = {
  pending: {
    text: "text-state-pending",
    chip: "bg-state-pending/14 text-state-pending border-state-pending/30",
    pip: "bg-state-pending",
  },
  proposed: {
    text: "text-state-proposed",
    chip: "bg-state-proposed/14 text-state-proposed border-state-proposed/30",
    pip: "bg-state-proposed",
  },
  running: {
    text: "text-state-running",
    chip: "bg-state-running/14 text-state-running border-state-running/30",
    pip: "bg-state-running",
  },
  approved: {
    text: "text-state-approved",
    chip: "bg-state-approved/14 text-state-approved border-state-approved/30",
    pip: "bg-state-approved",
  },
  executed: {
    text: "text-state-executed",
    chip: "bg-state-executed/14 text-state-executed border-state-executed/30",
    pip: "bg-state-executed",
  },
  blocked: {
    text: "text-state-blocked",
    chip: "bg-state-blocked/14 text-state-blocked border-state-blocked/30",
    pip: "bg-state-blocked",
  },
  rejected: {
    text: "text-state-rejected",
    chip: "bg-state-rejected/14 text-state-rejected border-state-rejected/30",
    pip: "bg-state-rejected",
  },
  failed: {
    text: "text-state-failed",
    chip: "bg-state-failed/14 text-state-failed border-state-failed/30",
    pip: "bg-state-failed",
  },
  neutral: {
    text: "text-fg",
    chip: "bg-raised text-fg border-subtle",
    pip: "bg-muted",
  },
  accent: {
    text: "text-accent-soft",
    chip: "bg-accent/14 text-accent-soft border-accent/30",
    pip: "bg-accent-soft",
  },
  quiet: {
    text: "text-faint",
    chip: "bg-transparent text-faint border-subtle",
    pip: "bg-faint",
  },
};

const TONE_BY_STATUS: Record<string, BadgeTone> = {
  // ActionStatus
  PROPOSED: "proposed",
  BLOCKED: "blocked",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXECUTED: "executed",
  FAILED: "failed",
  // RunStatus / EvalStatus
  PENDING: "pending",
  RUNNING: "running",
  AWAITING_APPROVAL: "proposed",
  COMPLETED: "executed",
  BLOCKED_BY_POLICY: "blocked",
  // CaseStatus
  OPEN: "pending",
  IN_PROGRESS: "running",
  RESOLVED: "executed",
  ABANDONED: "rejected",
  // StepKind - the run trace renders one of these per row
  MODEL_CALL: "accent",
  TOOL_CALL: "neutral",
  TOOL_RESULT: "quiet",
  POLICY_CHECK: "blocked",
  ACTION_PROPOSED: "proposed",
  ACTION_EXECUTED: "executed",
  AWAIT_APPROVAL: "proposed",
  TERMINAL: "pending",
  // RunArm
  AGENT: "accent",
  CONTROL: "quiet",
  // policy check outcomes
  PASS: "executed",
  PASSED: "executed",
  ALLOWED: "executed",
  FAIL: "failed",
  // lead tiers, as a heat ramp rather than a status
  HOT: "proposed",
  WARM: "neutral",
  COLD: "quiet",
  // roles
  OWNER: "accent",
  OPERATOR: "neutral",
  VIEWER: "quiet",
};

/**
 * Shortened where the enum name is longer than the column it lands in.
 * "Needs approval" rather than "Awaiting approval" because the operator
 * reading it is the approval being awaited.
 */
const LABEL_BY_STATUS: Record<string, string> = {
  AWAITING_APPROVAL: "Needs approval",
  BLOCKED_BY_POLICY: "Blocked",
  AWAIT_APPROVAL: "Awaiting",
  ACTION_PROPOSED: "Proposed",
  ACTION_EXECUTED: "Executed",
  TERMINAL: "Done",
  IN_PROGRESS: "In progress",
};

/** RUNNING is the only state that is about the system rather than an outcome. */
const PULSING: ReadonlySet<BadgeTone> = new Set<BadgeTone>(["running"]);

function normalise(status: string | null | undefined): string {
  return (status ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function statusTone(status: string | null | undefined): BadgeTone {
  return TONE_BY_STATUS[normalise(status)] ?? "neutral";
}

export function statusLabel(status: string | null | undefined): string {
  const key = normalise(status);
  if (!key) return "Unknown";
  if (LABEL_BY_STATUS[key]) return LABEL_BY_STATUS[key];
  const words = key.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Any enum value from the schema - ActionStatus, RunStatus, StepKind, tier. */
  status?: string | null;
  /** Force a tone for things the status map does not know about. */
  tone?: BadgeTone;
  /** Override the derived label. */
  label?: ReactNode;
  size?: "sm" | "md";
  /** The leading dot. Off for chips that are labels rather than states. */
  pip?: boolean;
}

export function Badge({
  status,
  tone,
  label,
  size = "sm",
  pip = true,
  className,
  ...props
}: BadgeProps) {
  const resolved = tone ?? statusTone(status);
  const styles = TONE[resolved];

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-sm border font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-1.5 text-2xs" : "h-6 px-2 text-xs",
        styles.chip,
        className,
      )}
      {...props}
    >
      {pip ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            styles.pip,
            PULSING.has(resolved) && "animate-pip",
          )}
        />
      ) : null}
      {label ?? statusLabel(status)}
    </span>
  );
}

export interface StatusPipProps extends HTMLAttributes<HTMLSpanElement> {
  status?: string | null;
  tone?: BadgeTone;
}

/** The dot on its own, for timeline rails and anywhere a chip is too loud. */
export function StatusPip({ status, tone, className, ...props }: StatusPipProps) {
  const resolved = tone ?? statusTone(status);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        TONE[resolved].pip,
        PULSING.has(resolved) && "animate-pip",
        className,
      )}
      {...props}
    />
  );
}
