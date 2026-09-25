import { advanceRun } from "@/lib/agent/runtime";
import { conflict, notFound, ok, serverError, unauthorized } from "@/lib/api/respond";
import { getUserOrNull } from "@/lib/auth/session";
import { db } from "@/lib/db";

/**
 * Drive one run forward and return where it stopped.
 *
 * The loop is durable, so this is safe to call on a run that is part way
 * through: advanceRun() rebuilds the conversation from committed steps rather
 * than from memory. That makes this both the console's "run it" button and the
 * manual recovery path for a run the webhook's background work abandoned.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getUserOrNull();
    // The middleware turns away anonymous /api traffic already. This is not
    // redundant with it: middleware verifies a token locally and knows nothing
    // about tenants, and a route that trusted it would be a route that silently
    // opts out of scoping the day the matcher changes.
    if (!session) return unauthorized();

    const { id } = await params;

    // The tenant is part of the lookup, not a check after it. Reading the row
    // first and comparing tenantId afterwards is the same bug one careless
    // refactor later, and the failure mode is a cross-tenant read.
    const run = await db.agentRun.findFirst({
      where: { id, tenantId: session.tenant.id },
      select: { id: true, status: true, awaitingActionId: true },
    });
    if (!run) return notFound("No such run in this workspace.");

    if (run.status === "AWAITING_APPROVAL") {
      // Advancing here would set the run RUNNING and send the model back in
      // while a human still owes a decision on the action that parked it - the
      // proposal would sit in the queue forever with nothing left waiting on it.
      // The way forward from this state is the decision endpoint, which advances
      // the run itself once someone has actually signed or refused.
      return conflict(
        run.awaitingActionId
          ? `This run is waiting on a decision for action ${run.awaitingActionId}.`
          : "This run is waiting on a human decision.",
      );
    }

    // advanceRun() reports a failed run as a FAILED outcome rather than by
    // throwing, so a run that breaks is a 200 describing the break. A caller
    // that cannot tell "the run failed" from "the request failed" cannot show
    // the difference to an operator either.
    return ok(await advanceRun(run.id));
  } catch (cause) {
    return serverError(cause);
  }
}
