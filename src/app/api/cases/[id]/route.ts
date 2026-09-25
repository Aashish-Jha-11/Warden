import { notFound, ok, serverError, unauthorized } from "@/lib/api/respond";
import { getUserOrNull } from "@/lib/auth/session";
import { db } from "@/lib/db";

/**
 * Everything the run-trace UI needs for one case, in one round trip.
 *
 * This is a polled endpoint - it is read every couple of seconds while a run is
 * in flight - so it answers with the whole tree rather than making the client
 * fan out into a request per run and per action. The tree is bounded by policy:
 * maxRunSteps caps the steps, maxActionsPerRun caps the actions.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getUserOrNull();
    if (!session) return unauthorized();

    const { id } = await params;

    const found = await db.case.findFirst({
      where: { id, tenantId: session.tenant.id },
      include: {
        runs: {
          // Newest first: the run someone opened this page to watch is the one
          // that just started, and it should not be below three finished ones.
          orderBy: { startedAt: "desc" },
          include: {
            // By index, never by createdAt. Steps inside one loop iteration
            // commit within the same millisecond, and a timestamp sort would
            // shuffle a policy check in front of the proposal it checked.
            steps: { orderBy: { index: "asc" } },
            actions: {
              orderBy: { proposedAt: "asc" },
              include: {
                // Who signed it and what they said. Without this an approved
                // action in the trace is anonymous, which defeats the point of
                // having asked a human at all.
                approval: {
                  select: {
                    decision: true,
                    note: true,
                    decidedAt: true,
                    user: { select: { id: true, name: true, email: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!found) return notFound("No such case in this workspace.");

    const { runs, ...kase } = found;

    // Every action, not only the ones still PROPOSED. Filtering to PROPOSED
    // would make an action disappear from the trace at the moment it fired,
    // which is exactly when an operator is watching it. The approval queue
    // filters on status client-side; the trace needs the whole history.
    return ok(
      { case: kase, runs },
      {
        // A run trace that a browser or a proxy caches for even a few seconds
        // reads as a frozen UI, and the poll that would have corrected it is the
        // request being served from cache.
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (cause) {
    return serverError(cause);
  }
}
