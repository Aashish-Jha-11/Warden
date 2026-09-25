import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Mono } from "@/components/ui/mono";
import { TD, TR } from "@/components/ui/table";
import { LeadPayloadSchema, scoreLead } from "@/lib/domain/lead";
import { cn } from "@/lib/utils";

/**
 * One inbound enquiry, as a row.
 *
 * The two things an operator triages on are who wrote in and what they said,
 * so those share the first cell and everything else is a narrow readout beside
 * them. The tier comes from scoreLead() rather than anything decided here -
 * the control arm scores with the identical function, and a second rule living
 * in a component would quietly invalidate every number on /eval.
 *
 * The whole row is a link to the run trace. A lead nobody can open is a lead
 * nobody can audit, which is the opposite of what this console is for.
 *
 * Below `sm` the four narrow columns are gone and their facts move into the
 * first cell. Six columns cannot fit 400px without a sideways scroll, and the
 * usage scene this product was written for is one thumb on a phone at 9pm -
 * so the phone gets the two columns that decide anything (who, and what the
 * run is doing) and reads the rest as a meta line.
 */

/** Past this the enquiry shoves every other column off a laptop screen. */
const MESSAGE_BUDGET = 72;

/** Stagger index ceiling. 14 * 55ms lands the last row inside 800ms; an
    uncapped index would make row 50 of a full inbox arrive 2.7s late. */
const STAGGER_CAP = 14;

export type InboxCase = {
  id: string;
  subject: string;
  contactName: string | null;
  payload: unknown;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** Newest first, at most one - the run the row links to. */
  runs: ReadonlyArray<{
    id: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
  }>;
};

export interface LeadRowProps {
  /** Stagger index for the entrance. */
  index?: number;
  kase: InboxCase;
  /** Policy.maxAttemptsPerCase, the denominator the guardrail enforces. */
  attemptBudget: number | null;
  /** Captured once by the page, so every row agrees on "how long ago". */
  now: Date;
}

export function LeadRow({ kase, attemptBudget, now, index = 0 }: LeadRowProps) {
  const parsed = LeadPayloadSchema.safeParse(kase.payload);
  const lead = parsed.success ? parsed.data : null;

  // A payload that has drifted from the schema still usually carries the
  // message, and the message is the only thing that makes a row identifiable.
  const message = lead?.message ?? readMessage(kase.payload) ?? kase.subject;
  const qualification = lead ? scoreLead(lead) : null;

  const run = kase.runs[0] ?? null;
  const contactName = kase.contactName?.trim() || "Unnamed contact";
  const exhausted = attemptBudget !== null && kase.attemptCount >= attemptBudget;
  const lastActivity = latestOf(kase.updatedAt, run?.completedAt, run?.startedAt);
  const attempts = `${kase.attemptCount}/${attemptBudget ?? "?"}`;
  const attemptsTitle =
    attemptBudget === null
      ? undefined
      : `${kase.attemptCount} of ${attemptBudget} contact attempts used`;

  return (
    <TR
      style={{ "--i": Math.min(index, STAGGER_CAP) } as React.CSSProperties}
      className="enter-rise relative focus-within:bg-raised"
    >
      <TD className="min-w-0 py-2.5 sm:min-w-48 lg:min-w-56">
        <div className="flex flex-col gap-0.5">
          <span className="text-base leading-tight font-medium break-words text-fg">
            {run ? (
              // Stretched over the row by the pseudo-element rather than by
              // wrapping every cell, which no table markup allows.
              <Link
                href={`/runs/${run.id}`}
                aria-label={`Open the run for ${contactName}`}
                className="rounded-xs after:absolute after:inset-0 after:content-['']"
              >
                {contactName}
              </Link>
            ) : (
              contactName
            )}
          </span>
          <span className="line-clamp-2 text-xs leading-snug text-muted" title={message}>
            {truncate(message, MESSAGE_BUDGET)}
          </span>

          {/* The narrow columns, folded in where they do not fit beside. */}
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 sm:hidden">
            {qualification ? (
              <Badge status={qualification.tier} />
            ) : (
              <Badge tone="quiet" pip={false} label="Unscored" />
            )}
            {lead ? (
              <Mono tone="faint" className="text-2xs">
                {lead.source}
              </Mono>
            ) : null}
            <span aria-hidden className="text-faint">
              ·
            </span>
            <Mono
              tone="faint"
              className={cn("text-2xs", exhausted && "text-state-blocked")}
              title={attemptsTitle}
            >
              {attempts}
            </Mono>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <Mono tone="faint" className="text-2xs">
              {since(lastActivity, now)}
            </Mono>
          </span>
        </div>
      </TD>

      <TD className="hidden sm:table-cell">
        {lead ? (
          <Mono tone="muted">{lead.source}</Mono>
        ) : (
          <span className="text-faint">&mdash;</span>
        )}
      </TD>

      <TD className="hidden sm:table-cell">
        {qualification ? (
          <Badge status={qualification.tier} />
        ) : (
          // Not a tier and not a zero: scoreLead never saw this payload.
          <Badge tone="quiet" pip={false} label="Unscored" />
        )}
      </TD>

      <TD numeric className="hidden sm:table-cell">
        <Mono
          tone="muted"
          // Violet is this system's colour for "policy stopped it", and a case
          // at its ceiling is one the attempt_budget check will block next.
          className={cn(exhausted && "text-state-blocked")}
          title={attemptsTitle}
        >
          {attempts}
        </Mono>
      </TD>

      <TD>
        {run ? (
          <Badge status={run.status} />
        ) : (
          <Badge tone="quiet" pip={false} label="No run yet" />
        )}
      </TD>

      <TD numeric className="hidden sm:table-cell">
        <Mono tone="faint">{since(lastActivity, now)}</Mono>
      </TD>
    </TR>
  );
}

// ---------------------------------------------------------------- helpers

/** Cuts on a word boundary where there is one nearby, so the tail is readable. */
function truncate(text: string, budget: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= budget) return flat;

  const cut = flat.slice(0, budget - 1);
  const space = cut.lastIndexOf(" ");
  const head = space > budget * 0.6 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,.;:-]+$/, "")}…`;
}

/** Rounded down, so a row never claims to be fresher than it is. */
function since(at: Date, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function latestOf(...dates: Array<Date | null | undefined>): Date {
  let latest = new Date(0);
  for (const date of dates) {
    if (date && date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function readMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const message = (payload as Record<string, unknown>).message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}
