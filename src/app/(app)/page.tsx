import { Suspense } from "react";
import { TriangleAlert, Zap } from "lucide-react";

import { InboxStats, InboxStatsSkeleton } from "@/components/inbox/inbox-stats";
import { IngestDemo } from "@/components/inbox/ingest-demo";
import { LeadTable, LeadTableSkeleton } from "@/components/inbox/lead-table";
import type { InboxCase } from "@/components/inbox/lead-row";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The business day is cut in IST: this is an India product and the operator is here. */
const BUSINESS_TZ = "Asia/Kolkata";

/** Actions that actually reach a person - the ones a response time is measured from. */
const CONTACT_TYPES = ["send_templated_reply", "send_email", "send_sms", "place_call"];

/**
 * The audit event the runtime writes when policy refuses a proposal.
 *
 * It is the only durable record of a block. `ProposedAction` is written AFTER
 * the verdict, so an action policy refused never becomes a row at all and
 * counting `ProposedAction.status = BLOCKED` is counting a state the runtime
 * cannot produce - it returns 0 forever. See runtime.ts, the `!verdict.allowed`
 * branch: it records this event and continues without creating the action.
 */
const BLOCKED_EVENT = "action_blocked";

export default async function InboxPage() {
  const { tenant } = await requireUser();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-sm text-muted">
            Every enquiry that reached {tenant.name}, and what the agent did about it.
          </p>
        </div>

        <a
          href="#ingest"
          className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs text-muted transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-raised hover:text-fg"
        >
          <Zap aria-hidden className="size-3.5" />
          Send a lead in
        </a>
      </header>

      {/*
        Two boundaries, not one. The strip answers the question the operator
        opened the page for and is four cheap counts; the table is fifty rows
        with their runs joined on. Streaming them apart means the answer is on
        screen before the evidence for it has finished loading.
      */}
      <Suspense fallback={<InboxStatsSkeleton />}>
        <Stats tenantId={tenant.id} />
      </Suspense>

      <Suspense fallback={<LeadTableSkeleton />}>
        <Leads tenantId={tenant.id} />
      </Suspense>

      <IngestDemo tenantSlug={tenant.slug} />
    </div>
  );
}

// ---------------------------------------------------------------- panels

async function Stats({ tenantId }: { tenantId: string }) {
  // Captured once and threaded down, so every figure agrees on "today".
  const now = new Date();
  const dayStart = startOfDayIn(BUSINESS_TZ, now);

  let leadsToday: number;
  let awaitingApproval: number;
  let blockedAllTime: number;
  let blockedToday: number;
  let medianSeconds: number | null;

  try {
    [leadsToday, awaitingApproval, blockedAllTime, blockedToday, medianSeconds] =
      await Promise.all([
        db.case.count({ where: { tenantId, createdAt: { gte: dayStart } } }),
        // The same rows /approvals lists, filtered identically. Counting
        // AgentRun.status = AWAITING_APPROVAL instead would drift the moment a
        // parked run failed for any reason other than its proposal: the queue
        // would still hold the action and this cell would say nothing is
        // waiting, which is the one lie this screen cannot afford.
        db.proposedAction.count({
          where: { tenantId, status: "PROPOSED", run: { tenantId } },
        }),
        db.auditEvent.count({ where: { tenantId, event: BLOCKED_EVENT } }),
        db.auditEvent.count({
          where: { tenantId, event: BLOCKED_EVENT, createdAt: { gte: dayStart } },
        }),
        medianFirstResponseSeconds(tenantId),
      ]);
  } catch (cause) {
    console.error("[inbox] stat strip failed", cause);
    return (
      <Failed what="the readout">
        The counts could not be loaded. Nothing below is affected - the enquiries
        themselves are read separately.
      </Failed>
    );
  }

  return (
    <InboxStats
      leadsToday={leadsToday}
      awaitingApproval={awaitingApproval}
      blockedAllTime={blockedAllTime}
      blockedToday={blockedToday}
      medianFirstResponseSeconds={medianSeconds}
      dayClock={`since 00:00 ${shortZone(BUSINESS_TZ)}`}
    />
  );
}

async function Leads({ tenantId }: { tenantId: string }) {
  // Rows that each call new Date() disagree by the duration of the query, so
  // the clock is taken once here and handed down.
  const now = new Date();

  let policy: { maxAttemptsPerCase: number } | null;
  let cases: InboxCase[];

  try {
    [policy, cases] = await Promise.all([
      db.policy.findUnique({
        where: { tenantId },
        select: { maxAttemptsPerCase: true },
      }),
      db.case.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          subject: true,
          contactName: true,
          payload: true,
          attemptCount: true,
          createdAt: true,
          updatedAt: true,
          runs: {
            orderBy: { startedAt: "desc" },
            take: 1,
            select: { id: true, status: true, startedAt: true, completedAt: true },
          },
        },
      }),
    ]);
  } catch (cause) {
    console.error("[inbox] lead table failed", cause);
    return (
      <Failed what="the enquiries">
        The lead table could not be loaded. Reload the page; if it keeps
        happening the database is unreachable, not empty.
      </Failed>
    );
  }

  return (
    <LeadTable
      cases={cases}
      attemptBudget={policy?.maxAttemptsPerCase ?? null}
      now={now}
    />
  );
}

/**
 * A panel that could not load, said plainly and in place.
 *
 * Red, not violet: this is the one thing on the inbox that actually is broken.
 * The violet on this screen means policy refused to act, which is the system
 * working, and the two must never be confused for one another.
 */
function Failed({ what, children }: { what: string; children: React.ReactNode }) {
  return (
    <div className="enter-fade flex items-start gap-2.5 rounded-lg border border-state-failed/30 bg-state-failed/10 px-4 py-3.5">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-state-failed" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-state-failed">
          Could not load {what}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- queries

/**
 * Median, not mean, and computed in Postgres rather than by loading rows.
 *
 * A mean here is useless: one lead answered three days late after a holiday
 * drags the whole figure and hides that the other ninety-nine were answered in
 * under two minutes. The median is what an operator actually experiences.
 *
 * Measured from lastInboundAt - when the person wrote to us - rather than from
 * when the run started, because the wait that matters is theirs, not ours.
 *
 * Fails to null rather than throwing. It is the one hand-written SQL statement
 * on this screen and the only thing here that a Postgres upgrade could break
 * on its own; one dash in one cell is a far better outcome than an inbox that
 * will not render.
 */
async function medianFirstResponseSeconds(tenantId: string): Promise<number | null> {
  try {
    const rows = await db.$queryRaw<Array<{ median: number | string | null }>>`
      SELECT percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (x.first_contact - c.last_inbound_at))
             ) AS median
      FROM cases c
      JOIN LATERAL (
        SELECT MIN(pa.executed_at) AS first_contact
        FROM proposed_actions pa
        JOIN agent_runs r ON r.id = pa.run_id
        WHERE r.case_id = c.id
          AND pa.status = 'EXECUTED'
          AND pa.type = ANY(${CONTACT_TYPES})
      ) x ON TRUE
      WHERE c.tenant_id = ${tenantId}
        AND c.last_inbound_at IS NOT NULL
        AND x.first_contact IS NOT NULL
        AND x.first_contact >= c.last_inbound_at
    `;

    const median = rows[0]?.median;
    if (median === null || median === undefined) return null;
    // percentile_cont answers in double precision, but EXTRACT feeds it a
    // numeric and a driver is free to hand either one back as a string.
    const seconds = Number(median);
    return Number.isFinite(seconds) ? Math.round(seconds) : null;
  } catch (cause) {
    console.error("[inbox] median first response failed", cause);
    return null;
  }
}

// ---------------------------------------------------------------- clocks

/** Midnight today in the given zone, expressed as a real instant. */
function startOfDayIn(timeZone: string, at: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);

  // How far into the local day we are, subtracted from the instant. Avoids
  // reconstructing a Date from local parts, which would be read as server-local.
  const elapsedMs =
    ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return new Date(at.getTime() - elapsedMs);
}

function shortZone(timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  return name ?? timeZone;
}
