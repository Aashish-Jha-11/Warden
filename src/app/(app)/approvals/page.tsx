import { ArrowLeft, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";
import { Suspense } from "react";

import { ApprovalCard, type QueuedAction } from "@/components/approvals/approval-card";
import { QueueItem } from "@/components/approvals/queue-item";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty";
import { Mono } from "@/components/ui/mono";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";

import { ActionStatus } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Approvals",
  description:
    "Actions the agent proposed and policy allowed, held until a person signs them.",
};

/**
 * The approval queue.
 *
 * Every other screen in Warden describes the claim that the agent cannot act
 * on its own. This is the screen where that claim is checkable: each row is an
 * action that already exists in the database, already passed every policy
 * check, and still has not happened - because nobody has signed it.
 *
 * Server-rendered with no polling. A decision is a POST followed by
 * router.refresh(), so what an operator sees is what the runtime is actually
 * gated on rather than a client cache that has drifted from it. The cost is
 * that a queue left open goes stale; the alternative is a screen that can show
 * an action as pending after it has already fired, which on this screen is the
 * worse failure by a distance.
 */
export default async function ApprovalsPage() {
  const { tenant } = await requireUser();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Approvals</h1>
        <p className="mt-1 text-sm text-muted">
          The agent proposed each of these and policy allowed it. Until you
          decide, none of them happen.
        </p>
      </header>

      <Suspense fallback={<QueueSkeleton />}>
        <Queue tenantId={tenant.id} />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------- queue

async function Queue({ tenantId }: { tenantId: string }) {
  let queue: QueuedAction[];

  try {
    queue = await db.proposedAction.findMany({
      where: {
        tenantId,
        status: ActionStatus.PROPOSED,
        // Both copies of the tenant id have to agree. ProposedAction denormalises
        // it from its run, and a denormalised column is precisely the thing that
        // drifts; requiring the join to match as well means a drifted row renders
        // nowhere instead of rendering under the wrong workspace.
        run: { tenantId },
      },
      // Newest first, against the usual instinct for a work queue. Inbound lead
      // response is a freshness business - the proposal that just landed concerns
      // someone who is still holding their phone, and a reply they get in two
      // minutes is worth more than one an older lead gets in twenty.
      orderBy: { proposedAt: "desc" },
      include: { run: { include: { case: true } } },
    });
  } catch (cause) {
    console.error("[approvals] queue failed", cause);
    return (
      <div className="enter-fade flex items-start gap-2.5 rounded-lg border border-state-failed/30 bg-state-failed/10 px-4 py-3.5">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-state-failed" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-state-failed">
            Could not load the queue
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Nothing has been approved or rejected as a result, and nothing has
            been sent. Reload the page; if it keeps happening the database is
            unreachable, not empty.
          </p>
        </div>
      </div>
    );
  }

  if (queue.length === 0) return <QueueEmpty />;

  // One clock for the whole page. Each card prints how long its action has been
  // waiting, and cards that each read the time themselves would disagree with
  // one another by however long the query above took.
  const now = new Date();
  // Newest first, so the last row is the one that has waited longest.
  const oldest = queue[queue.length - 1].proposedAt;

  return (
    <div className="space-y-3">
      <div className="enter-fade flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge
          status={ActionStatus.PROPOSED}
          size="md"
          // text-inherit so the count keeps the chip's amber. Mono's own tones
          // all name a text colour, and any of them would repaint it.
          label={
            <>
              <Mono className="text-inherit">{queue.length}</Mono> waiting
            </>
          }
        />
        <span className="text-xs text-muted">
          oldest has waited{" "}
          <Mono tone="muted">{waitedFor(oldest, now)}</Mono>
        </span>
      </div>

      {/* No list gap: each item carries its own bottom padding so the space it
          occupies collapses with it when a decision takes it out. */}
      <ul>
        {queue.map((action, i) => (
          <QueueItem key={action.id}>
            <ApprovalCard action={action} now={now} index={i} />
          </QueueItem>
        ))}
      </ul>
    </div>
  );
}

/**
 * An empty queue is the good outcome, and the copy has to say which kind of
 * empty it is. A blank panel reads as a page that failed; this one states the
 * invariant the screen exists to prove.
 */
function QueueEmpty() {
  return (
    <Card className="enter-rise">
      <EmptyState
        icon={ShieldCheck}
        title="Nothing is waiting on you"
        description="The agent is idle or acting inside policy. Anything it proposes that needs a person stops here first - and nothing reaches a customer until you have signed it."
        action={
          <Link href="/" className={buttonClasses("secondary", "sm")}>
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to the inbox
          </Link>
        }
      />
    </Card>
  );
}

/** Holds one card's worth of geometry while the queue is in flight. */
function QueueSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-40" />
      <Card>
        <div className="flex items-start justify-between gap-4 border-b border-subtle px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-3 w-40 max-w-full" />
          </div>
          <Skeleton className="h-5 w-20 shrink-0" />
        </div>
        <div className="space-y-4 px-4 py-3.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Card>
    </div>
  );
}

/** Rounded down, because "waited 2h" must never overstate how fresh this is. */
function waitedFor(since: Date, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - since.getTime()) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
