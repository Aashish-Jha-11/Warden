import { Activity, OctagonX, ShieldAlert } from "lucide-react";

import { Badge, StatusPip } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { StepRow, type TraceAction, type TraceStep } from "./step-row";

export interface TraceProps {
  steps: TraceStep[];
  runStartedAt: Date;
  /** Write-ahead action rows, keyed by id, joined in by the page. */
  actions?: Record<string, TraceAction>;
  /** The recipient's timezone - the clock the contact-window check reads. */
  timezone: string;
  /** True while the run is still moving, which draws a live head on the rail. */
  live?: boolean;
  /** The run's own status and error, for outcomes that commit no TERMINAL step. */
  status?: string;
  error?: string | null;
}

/**
 * The run trace.
 *
 * Flat, not grouped into turns. Steps append to this list while a demo is
 * running, and any structure that has to be recomputed as rows arrive is
 * structure that will flicker on the recording.
 *
 * Two things are threaded through from here rather than looked up per row,
 * because a row cannot see its neighbours:
 *
 *   - the NEXT step, so a silent MODEL_CALL can say what the turn decided
 *     instead of rendering an empty row;
 *   - the action currently in play, so an ACTION_EXECUTED row can name what
 *     it executed - the executor's return value does not carry the action.
 */
export function Trace({
  steps,
  runStartedAt,
  actions = {},
  timezone,
  live = false,
  status,
  error,
}: TraceProps) {
  if (steps.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title={live ? "Starting up" : "No steps yet"}
        description={
          live
            ? "The run has been created and is about to take its first step. Rows appear here as they commit."
            : "This run has been created but has not taken its first step. It will appear here as it moves."
        }
      />
    );
  }

  const last = steps.length - 1;
  const lastStep = steps[last];
  const rows = resolve(steps, actions);

  // A FAILED run and a run that ran out of steps both stop without committing
  // a TERMINAL row, so the rail would otherwise just trail off at whatever the
  // agent happened to be doing. The end of the rail is where the eye already
  // is; the outcome belongs there as well as in the header.
  const closing =
    !live && lastStep && lastStep.kind !== "TERMINAL" && lastStep.kind !== "AWAIT_APPROVAL"
      ? closingFor(status, error)
      : null;

  return (
    <ol className="relative">
      {rows.map((row, i) => (
        <StepRow
          key={row.step.id}
          step={row.step}
          next={row.next}
          runStartedAt={runStartedAt}
          action={row.action}
          timezone={timezone}
          // The rail stops at the end of what exists, and at a halt - but not
          // while more steps are still coming, or a live run would read as
          // finished between polls.
          railStops={row.halted || (i === last && !live && !closing)}
        />
      ))}

      {live ? <LiveHead /> : null}
      {closing ? <Closing {...closing} /> : null}
    </ol>
  );
}

type Row = {
  step: TraceStep;
  next: TraceStep | null;
  action?: TraceAction;
  halted: boolean;
};

/**
 * Pairs every step with its neighbour and its action, in one forward pass.
 *
 * Done before the JSX rather than inside the map because the carried-forward
 * action is state that accumulates in order: an ACTION_EXECUTED row names what
 * it executed by remembering the ACTION_PROPOSED above it, and a mapper that
 * mutates a captured variable is a render-time side effect whose evaluation
 * order is not ours to assume.
 */
function resolve(steps: TraceStep[], actions: Record<string, TraceAction>): Row[] {
  const rows: Row[] = [];
  let current: TraceAction | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const detail = asRecord(step.detail);
    const actionId = typeof detail?.actionId === "string" ? detail.actionId : null;
    if (actionId) current = actions[actionId];

    const action = actionId ? actions[actionId] : current;
    rows.push({
      step,
      next: steps[i + 1] ?? null,
      action,
      halted: step.kind === "AWAIT_APPROVAL" && !action?.approval,
    });
  }

  return rows;
}

type ClosingRow = {
  tone: "failed" | "blocked";
  title: string;
  detail: string;
};

/**
 * Only the outcomes that commit no step of their own. COMPLETED always writes
 * a TERMINAL row and AWAITING_APPROVAL always writes an AWAIT_APPROVAL row, so
 * adding anything for those would be inventing a step that did not happen.
 */
function closingFor(status: string | undefined, error: string | null | undefined): ClosingRow | null {
  if (status === "FAILED") {
    return {
      tone: "failed",
      title: "The run failed here",
      detail:
        error ??
        "The loop threw before it could finish. Nothing further was proposed or sent.",
    };
  }
  if (status === "BLOCKED_BY_POLICY") {
    return {
      tone: "blocked",
      title: "Stopped by the step ceiling",
      detail:
        "The run reached the maximum number of steps tenant policy allows and was stopped. That is a budget, not a crash.",
    };
  }
  return null;
}

function Closing({ tone, title, detail }: ClosingRow) {
  const Icon = tone === "failed" ? OctagonX : ShieldAlert;

  return (
    <li className="enter-fade relative flex gap-3">
      <span
        className={cn(
          "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border",
          tone === "failed"
            ? "border-state-failed/45 bg-state-failed/14 text-state-failed"
            : "border-state-blocked/45 bg-state-blocked/14 text-state-blocked",
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        <Badge tone={tone} label={tone === "failed" ? "Failed" : "Blocked"} size="md" />
        <div
          className={cn(
            "rounded-md border px-3 py-2.5",
            tone === "failed"
              ? "border-state-failed/30 bg-state-failed/10"
              : "border-state-blocked/30 bg-state-blocked/10",
          )}
        >
          <p
            className={cn(
              "text-sm font-medium",
              tone === "failed" ? "text-state-failed" : "text-state-blocked",
            )}
          >
            {title}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">{detail}</p>
        </div>
      </div>
    </li>
  );
}

/**
 * The head of a running rail. Without it a live run looks identical to a
 * finished one between two polls, and the one thing a viewer needs to know
 * while watching is whether it is still going.
 */
function LiveHead() {
  return (
    <li className="relative flex gap-3">
      <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-state-running/35 bg-state-running/14">
        <StatusPip tone="running" />
      </span>
      <p className="flex min-h-6 items-center text-sm text-state-running">
        Working — the next step will appear here as it commits.
      </p>
    </li>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
