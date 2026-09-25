import { z } from "zod";

import { badRequest, notFound, ok, parseBody, serverError, unauthorized } from "@/lib/api/respond";
import { getUserOrNull } from "@/lib/auth/session";
import { MAX_TRANSCRIPT, takeVoiceTurn, VoiceTurnError } from "@/lib/voice/turn";
import type { VoiceTurnData } from "@/lib/voice/types";

/**
 * One spoken turn.
 *
 * Auth, shape, and mapping a failure onto a status code. The turn itself is in
 * `@/lib/voice/turn` - a route module can only export HTTP verbs, so anything
 * left in here is reachable exclusively through a session cookie and cannot be
 * driven from a script.
 */

/** A run can take several model calls; the platform default cuts that short. */
export const maxDuration = 60;

const BodySchema = z.object({
  caseId: z.string().min(1).max(64).optional(),
  transcript: z.string().min(1).max(MAX_TRANSCRIPT),
});

export async function POST(request: Request) {
  try {
    const session = await getUserOrNull();
    if (!session) return unauthorized("Sign in before talking to the agent.");

    const parsed = await parseBody(request, BodySchema);
    if (!parsed.ok) return badRequest(parsed.error);

    const data = await takeVoiceTurn({
      session,
      caseId: parsed.data.caseId ?? null,
      transcript: parsed.data.transcript,
    });

    return ok<VoiceTurnData>(data, {
      // A turn is a write and its answer describes a run that is still moving.
      // Nothing about it may be replayed from a cache.
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    // Anything the caller can act on says so itself. Everything else is ours,
    // and serverError() answers with a reference rather than a Prisma message.
    if (cause instanceof VoiceTurnError) {
      return cause.status === 404 ? notFound(cause.message) : badRequest(cause.message);
    }
    return serverError(cause);
  }
}
