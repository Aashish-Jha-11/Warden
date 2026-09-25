import Link from "next/link";
import { Clock, Inbox, ShieldCheck, Timer } from "lucide-react";

import { StatBar, StatTile } from "@/components/ui/stat";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The readout an operator scans in three seconds.
 *
 * "Awaiting approval" is emphasised and linked, because it is the only cell
 * that can require them to do something. The rest are context.
 *
 * "Blocked by policy" is deliberately NOT an alarm. It is the guardrail
 * working, and the violet treatment says so - red would train an operator to
 * read correct behaviour as breakage.
 */

export interface InboxStatsProps {
  leadsToday: number;
  /**
   * Proposals sitting in the queue right now. Counted from the same rows
   * /approvals lists, never from run status - a stat that says "3 waiting"
   * above a queue showing two is worse than no stat at all.
   */
  awaitingApproval: number;
  /** Every time the guardrail refused the agent, since this workspace opened. */
  blockedAllTime: number;
  /** How many of those were today, so the figure above can be placed in time. */
  blockedToday: number;
  /** Null when nothing has gone out yet. Renders a dash, never a zero. */
  medianFirstResponseSeconds: number | null;
  /** The clock "today" was cut at, named so the count can be argued with. */
  dayClock: string;
}

export function InboxStats({
  leadsToday,
  awaitingApproval,
  blockedAllTime,
  blockedToday,
  medianFirstResponseSeconds,
  dayClock,
}: InboxStatsProps) {
  const waiting = awaitingApproval > 0;

  return (
    <StatBar>
      <StatTile
        index={0}
        icon={Inbox}
        label="Leads today"
        value={leadsToday}
        sublabel={dayClock}
      />

      {/*
        The link is an overlay inside the cell rather than a wrapper around it.
        `display: contents` on a wrapper would drop the element's box, and
        StatBar separates its cells with `divide-x` - a border painted on a
        box that does not exist is a hairline that silently disappears exactly
        when the queue is non-empty. The wrapper is rendered either way so the
        grid geometry cannot shift between the two states.
      */}
      <div className="group relative">
        <StatTile
          index={1}
          emphasis={waiting}
          tone={waiting ? "proposed" : "default"}
          icon={Clock}
          label="Awaiting approval"
          value={awaitingApproval}
          sublabel={
            waiting ? "Runs stopped, waiting on you" : "Nothing is waiting on you"
          }
          className={
            waiting
              ? "h-full transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:bg-raised"
              : "h-full"
          }
        />
        {waiting ? (
          <Link
            href="/approvals"
            className="absolute inset-0 rounded-sm"
            aria-label={`Open the approval queue: ${awaitingApproval} ${
              awaitingApproval === 1 ? "action" : "actions"
            } waiting on you`}
          />
        ) : null}
      </div>

      <StatTile
        index={2}
        tone="blocked"
        icon={ShieldCheck}
        label="Stopped by policy"
        value={blockedAllTime}
        sublabel={blockedSublabel(blockedAllTime, blockedToday)}
      />

      <StatTile
        index={3}
        icon={Timer}
        label="Median first reply"
        value={formatDuration(medianFirstResponseSeconds)}
        sublabel={
          medianFirstResponseSeconds === null
            ? "No replies sent yet"
            : "Their message to our reply"
        }
      />
    </StatBar>
  );
}

/** Holds the strip's geometry while the counts are still in flight. */
export function InboxStatsSkeleton() {
  return (
    <StatBar>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex min-w-0 flex-col justify-between gap-3 p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className={i === 1 ? "h-10 w-20" : "h-7 w-14"} />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </StatBar>
  );
}

/**
 * The count is lifetime, not today. A demo five minutes old and a workspace
 * five months old both need this cell to mean "the guardrail is real", and a
 * today-scoped zero says the opposite of that on the morning of a demo. The
 * sublabel carries the time framing instead, so nothing is implied that the
 * number does not support.
 */
function blockedSublabel(allTime: number, today: number): string {
  if (allTime === 0) return "Nothing has needed stopping yet";
  if (today === 0) return "None today";
  if (today === allTime) return today === 1 ? "Today" : "All of them today";
  return `${today} of them today`;
}

/** A dash, never a zero - "no data" and "instant" are not the same answer. */
function formatDuration(seconds: number | null): string {
  if (seconds === null) return "–";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
