import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readPolicyChecks } from "@/components/approvals/policy-verdict";
import { LiveRefresh } from "@/components/run-trace/live-refresh";
import { RunHeader } from "@/components/run-trace/run-header";
import { Trace } from "@/components/run-trace/trace";
import type { TraceAction, TraceStep } from "@/components/run-trace/step-row";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { LeadPayloadSchema } from "@/lib/domain/lead";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Run trace",
};

/** Statuses where more steps are still expected, so the page keeps polling. */
const ACTIVE: ReadonlySet<string> = new Set(["PENDING", "RUNNING"]);

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenant } = await requireUser();

  // Tenant-scoped in the WHERE clause, not checked after loading. A findUnique
  // followed by an ownership test leaks existence through response timing and
  // is one refactor away from leaking the row itself.
  const run = await db.agentRun.findFirst({
    where: { id, tenantId: tenant.id },
    include: {
      case: true,
      steps: { orderBy: { index: "asc" } },
      // The write-ahead rows, joined so the trace can say who signed an action
      // and when. Without them an AWAIT_APPROVAL step goes on reading "waiting
      // on a human" long after a human decided.
      actions: {
        orderBy: { proposedAt: "asc" },
        include: {
          approval: {
            select: {
              decision: true,
              note: true,
              decidedAt: true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      },
    },
  });

  if (!run) notFound();

  const totals = run.steps.reduce(
    (acc, step) => {
      acc.modelMs += step.latencyMs ?? 0;
      acc.tokens += (step.promptTokens ?? 0) + (step.outputTokens ?? 0);
      if (step.model) acc.model = step.model;
      if (step.kind === "POLICY_CHECK") {
        if (isBlocked(step.content, step.detail)) acc.blocked += 1;
        else acc.allowed += 1;
      }
      return acc;
    },
    { modelMs: 0, tokens: 0, model: null as string | null, allowed: 0, blocked: 0 },
  );

  const actions: Record<string, TraceAction> = {};
  for (const action of run.actions) {
    actions[action.id] = {
      id: action.id,
      type: action.type,
      status: action.status,
      autoApproved: action.autoApproved,
      approval: action.approval
        ? {
            decision: action.approval.decision,
            note: action.approval.note,
            decidedAt: action.approval.decidedAt,
            by: action.approval.user?.name ?? action.approval.user?.email ?? null,
          }
        : null,
    };
  }

  const live = ACTIVE.has(run.status);
  const lead = LeadPayloadSchema.safeParse(run.case.payload);

  return (
    <div className="space-y-6">
      <LiveRefresh
        caseId={run.caseId}
        runId={run.id}
        status={run.status}
        stepCount={run.stepCount}
      />

      <RunHeader
        runId={run.id}
        subject={run.case.subject}
        inboundMessage={lead.success ? lead.data.message : null}
        source={lead.success ? lead.data.source : null}
        contactName={run.case.contactName}
        timezone={run.case.timezone}
        status={run.status}
        arm={run.arm}
        stepCount={run.steps.length}
        wallMs={elapsed(run.startedAt, run.completedAt, run.steps.at(-1)?.createdAt, live)}
        modelMs={totals.modelMs}
        totalTokens={totals.tokens}
        model={totals.model}
        policyAllowed={totals.allowed}
        policyBlocked={totals.blocked}
        awaiting={run.status === "AWAITING_APPROVAL"}
      />

      {/* The error is not repeated here. It belongs at the end of the rail,
          beside the step the run died on, where it says something a status
          badge cannot - and printing it twice on one screen says less. */}
      <Trace
        steps={run.steps as TraceStep[]}
        runStartedAt={run.startedAt}
        actions={actions}
        timezone={run.case.timezone}
        live={live}
        status={run.status}
        error={run.error}
      />
    </div>
  );
}

/**
 * A POLICY_CHECK row records its outcome twice - as `content` ("allowed" /
 * "blocked: <check>") and inside `detail.checks`. Either one alone is enough,
 * and a row written by an older shape of the runtime may only have one, so
 * this counts a block if either says so.
 */
function isBlocked(content: string | null, detail: unknown): boolean {
  if ((content ?? "").startsWith("blocked")) return true;
  return readPolicyChecks(detail).some((check) => !check.passed);
}

/**
 * Wall clock, as a stopwatch would have read it.
 *
 * A run parked on an approval has no completedAt and is not running either, so
 * without the last committed step it would print a dash - which is wrong: it
 * did take eleven seconds to get to the halt, and that is the number a viewer
 * is looking for.
 */
function elapsed(
  startedAt: Date,
  completedAt: Date | null,
  lastStepAt: Date | undefined,
  live: boolean,
): number | null {
  if (completedAt) return completedAt.getTime() - startedAt.getTime();
  if (live) return Date.now() - startedAt.getTime();
  return lastStepAt ? lastStepAt.getTime() - startedAt.getTime() : null;
}
