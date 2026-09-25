import { z } from "zod";

import { record } from "@/lib/agent/audit";
import { advanceRun, executeAction } from "@/lib/agent/runtime";
import {
  badRequest,
  conflict,
  notFound,
  ok,
  parseBody,
  serverError,
  unauthorized,
} from "@/lib/api/respond";
import { getUserOrNull } from "@/lib/auth/session";
import { db } from "@/lib/db";

import type { ActionStatus, RunStatus } from "@/generated/prisma/client";

/**
 * The hinge the whole product turns on.
 *
 * A run parked itself here because policy said this action needs a person. This
 * is where the person answers, and it is the only place in the codebase where a
 * human decision becomes a side effect. Three things have to be true of it:
 *
 *   - the decision is recorded before the action fires, never after,
 *   - it can only be made once, even by two people clicking at the same moment,
 *   - the run resumes either way, because "no" is an answer the agent has to
 *     hear as much as "yes".
 */

const DecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().max(1000).optional(),
});

type Decided = { runStatus: RunStatus; actionStatus: ActionStatus; awaitingActionId: string | null };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getUserOrNull();
    if (!session) return unauthorized();

    const { id } = await params;
    const parsed = await parseBody(request, DecisionSchema);
    if (!parsed.ok) return badRequest(parsed.error);
    const { decision, note } = parsed.data;

    // Tenant-scoped in the lookup itself. An action id from another workspace
    // has to read as "no such action", not as "not yours" - a 403 confirms the
    // id is real, which is the leak the filter exists to prevent.
    const action = await db.proposedAction.findFirst({
      where: { id, tenantId: session.tenant.id },
      select: {
        id: true,
        type: true,
        status: true,
        runId: true,
        run: { select: { arm: true, caseId: true, status: true } },
      },
    });
    if (!action) return notFound("No such action in this workspace.");

    if (action.status !== "PROPOSED") {
      // Named, not generic. "Already EXECUTED" and "already REJECTED" send an
      // operator to completely different places, and a queue two people work
      // from produces this several times a day.
      return conflict(
        `This action is already ${action.status}. Only a PROPOSED action can be decided.`,
      );
    }

    const nextStatus: ActionStatus = decision === "APPROVED" ? "APPROVED" : "REJECTED";
    const decidedAt = new Date();

    const committed = await db.$transaction(async (tx) => {
      // Guarded on status, not just on id. Both of two operators clicking
      // Approve at the same instant passed the check above - this is where only
      // one of them can win, because the second one's WHERE no longer matches a
      // row. The signature, the status change and the audit entry land together
      // or not at all, so there is no state where an action is APPROVED with
      // nobody's name against it.
      const moved = await tx.proposedAction.updateMany({
        where: { id: action.id, status: "PROPOSED" },
        data: { status: nextStatus, decidedAt },
      });
      if (moved.count === 0) return false;

      // approvals.action_id is unique, so this is the backstop that holds even
      // if the guard above ever stops being enough: two signatures on one action
      // is a constraint violation and takes the transaction with it.
      await tx.approval.create({
        data: {
          actionId: action.id,
          userId: session.user.id,
          decision,
          note: note ?? null,
          decidedAt,
        },
      });

      await record(
        {
          tenantId: session.tenant.id,
          entity: "action",
          entityId: action.id,
          event: decision === "APPROVED" ? "approved" : "rejected",
          // The actor is the person, not the system. This row is the answer to
          // "who authorised this" months after the fact, and it is the only
          // place that answer is written down.
          actor: `user:${session.user.id}`,
          data: { type: action.type, note: note ?? null, arm: action.run.arm },
        },
        tx,
      );

      return true;
    });

    if (!committed) {
      return conflict("Someone else decided this action a moment ago.");
    }

    // Deliberately outside the transaction. executeAction() reaches a message
    // provider, and holding a pooled Postgres connection open across a call to
    // somebody else's network is how a serverless deployment exhausts the
    // pooler. The write-ahead row is what makes this ordering safe: the action
    // is already APPROVED and durable, so a crash between here and delivery
    // leaves a record saying "decided, never fired" rather than an ambiguity.
    let actionStatus: ActionStatus = nextStatus;
    if (decision === "APPROVED") {
      // CONTROL-arm runs measure the same decisions without the side effects, so
      // the arm decides dry-run here rather than anywhere the model can see it.
      const executed = await executeAction(
        action.id,
        session.tenant.id,
        action.run.caseId,
        action.run.arm === "CONTROL",
      );
      actionStatus = executed.ok ? "EXECUTED" : "FAILED";
    }

    return ok<Decided>({
      ...(await resume(action.runId, action.run.status)),
      actionStatus,
    });
  } catch (cause) {
    return serverError(cause);
  }
}

/**
 * Restart the parked run and report where it got to.
 *
 * Rejections advance too. A refusal the agent never hears is a queue that fills
 * up with the same proposal - the run has to go back in so it can read the
 * decision off the case history and choose something else, or decide there is
 * nothing else and stop.
 *
 * The catch is the point of this function. By the time it runs the decision is
 * already committed, so a failure in the loop afterwards must not be reported as
 * a failed decision: the operator would click again, get a 409, and have no way
 * to tell whether their approval took. Instead the run's real status is read
 * back and returned, and the loop failure stays a server-side problem that
 * POST /api/runs/{id}/advance can pick up later.
 */
async function resume(
  runId: string,
  before: RunStatus,
): Promise<Omit<Decided, "actionStatus">> {
  try {
    const outcome = await advanceRun(runId);
    return {
      runStatus: outcome.status,
      awaitingActionId: outcome.status === "AWAITING_APPROVAL" ? outcome.actionId : null,
    };
  } catch (cause) {
    console.error(`[decision] run ${runId} could not be advanced`, cause);
    const run = await db.agentRun
      .findUnique({ where: { id: runId }, select: { status: true, awaitingActionId: true } })
      .catch(() => null);
    return {
      runStatus: run?.status ?? before,
      awaitingActionId: run?.awaitingActionId ?? null,
    };
  }
}
