import { Inbox as InboxIcon } from "lucide-react";

import { LeadRow, type InboxCase } from "@/components/inbox/lead-row";
import { EmptyState } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

/**
 * The enquiry table.
 *
 * The header lives here rather than in the page because its column visibility
 * has to stay in lockstep with LeadRow's. Two files agreeing on which
 * breakpoint hides "Source" is a defect waiting for the next edit; one file is
 * not.
 */

export interface LeadTableProps {
  cases: InboxCase[];
  /** Policy.maxAttemptsPerCase - the denominator the guardrail enforces. */
  attemptBudget: number | null;
  /** Captured once by the page so every row agrees on "how long ago". */
  now: Date;
}

export function LeadTable({ cases, attemptBudget, now }: LeadTableProps) {
  if (cases.length === 0) return <LeadTableEmpty />;

  return (
    <Table>
      <THead>
        <TR>
          <TH>Lead</TH>
          <TH className="hidden sm:table-cell">Source</TH>
          <TH className="hidden sm:table-cell">Tier</TH>
          <TH numeric className="hidden sm:table-cell">
            Attempts
          </TH>
          <TH>Run</TH>
          <TH numeric className="hidden sm:table-cell">
            Last activity
          </TH>
        </TR>
      </THead>
      <TBody>
        {cases.map((kase, i) => (
          <LeadRow
            key={kase.id}
            index={i}
            kase={kase}
            attemptBudget={attemptBudget}
            now={now}
          />
        ))}
      </TBody>
    </Table>
  );
}

/**
 * Nothing has come in yet. Not a failure - an inbox with no enquiries in it is
 * the ordinary state of a small business at 4pm, and the panel below this is
 * the one thing that changes it.
 */
export function LeadTableEmpty() {
  return (
    <EmptyState
      icon={InboxIcon}
      title="No enquiries yet"
      description="Nothing has reached this workspace. Send one in with the panel below, or POST a lead to /api/leads/ingest."
    />
  );
}

/**
 * Keeps the table's real geometry while the rows are still in flight.
 *
 * The cells carry the same visibility rules as the real ones rather than
 * SkeletonRows' uniform grid, because a placeholder that collapses to a
 * different column count than the thing it stands in for makes the table jump
 * sideways at the moment the data lands.
 */
export function LeadTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Lead</TH>
          <TH className="hidden sm:table-cell">Source</TH>
          <TH className="hidden sm:table-cell">Tier</TH>
          <TH numeric className="hidden sm:table-cell">
            Attempts
          </TH>
          <TH>Run</TH>
          <TH numeric className="hidden sm:table-cell">
            Last activity
          </TH>
        </TR>
      </THead>
      <TBody>
        {Array.from({ length: rows }, (_, r) => (
          <TR key={r} className="hover:bg-transparent">
            <TD className="py-2.5">
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48 max-w-full" />
                <Skeleton className="h-3 w-24 sm:hidden" />
              </div>
            </TD>
            <TD className="hidden sm:table-cell">
              <Skeleton className="h-3 w-16" />
            </TD>
            <TD className="hidden sm:table-cell">
              <Skeleton className="h-4 w-12" />
            </TD>
            <TD numeric className="hidden sm:table-cell">
              <Skeleton className="ml-auto h-3 w-8" />
            </TD>
            <TD>
              <Skeleton className="h-4 w-20" />
            </TD>
            <TD numeric className="hidden sm:table-cell">
              <Skeleton className="ml-auto h-3 w-10" />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
