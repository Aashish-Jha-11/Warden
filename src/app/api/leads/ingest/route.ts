import { createHash, timingSafeEqual } from "node:crypto";

import { after } from "next/server";
import { z } from "zod";

import { record } from "@/lib/agent/audit";
import { advanceRun } from "@/lib/agent/runtime";
import { seedToInt } from "@/lib/agent/seed";
import {
  badRequest,
  notFound,
  ok,
  parseBody,
  serverError,
  unauthorized,
} from "@/lib/api/respond";
import { db } from "@/lib/db";
import {
  BudgetSignalSchema,
  LeadSourceSchema,
  UrgencySchema,
  type LeadPayload,
} from "@/lib/domain/lead";

import type { Prisma, RunStatus } from "@/generated/prisma/client";

/**
 * The front door. A form provider, a WhatsApp bridge or an ad platform posts an
 * enquiry here and a run starts against it.
 *
 * This is the only unauthenticated route in the product, which shapes every
 * decision in the file: the caller is a machine that retries on any non-2xx,
 * gives up after a handful of seconds, and will never read an error message a
 * human wrote for a human.
 */

/**
 * Optional shared secret. Unset, the endpoint is open - which is what a demo
 * and a `curl` need. Set, every request must carry it in `x-warden-secret`,
 * which is what the middleware means when it says this route authenticates
 * itself. Env-gated rather than mandatory so turning it on is a deploy setting
 * and not a code change.
 */
const INGEST_SECRET = process.env.WARDEN_INGEST_SECRET;

/** A run in one of these is already working this case; a second would duplicate it. */
const LIVE_RUN_STATUSES: RunStatus[] = ["PENDING", "RUNNING", "AWAITING_APPROVAL"];

const trimmed = (max: number) => z.string().trim().max(max);

const IngestSchema = z.object({
  tenantSlug: trimmed(64).min(1),
  source: LeadSourceSchema,
  message: trimmed(4000).min(1),
  // `nullish`, not `optional`: a CRM with no service on file sends `null` far
  // more often than it omits the key.
  service: trimmed(160).nullish(),
  city: trimmed(80).optional(),
  contactName: trimmed(120).optional(),
  contactPhone: trimmed(32).optional(),
  contactEmail: z.email().max(200).optional(),
  timezone: trimmed(64).optional(),
  urgency: UrgencySchema.optional(),
  budgetSignal: BudgetSignalSchema.optional(),
  externalId: trimmed(128).optional(),
});

type IngestBody = z.infer<typeof IngestSchema>;

export async function POST(request: Request) {
  try {
    if (!authentic(request)) {
      return unauthorized("This endpoint requires a valid x-warden-secret header.");
    }

    const parsed = await parseBody(request, IngestSchema);
    if (!parsed.ok) return badRequest(parsed.error);
    const body = parsed.data;

    const timezone = body.timezone ?? "Asia/Kolkata";
    // Rejected here rather than left to the policy engine. An unusable timezone
    // fails the contact-window check closed, so the lead would be accepted,
    // scored, and then silently never contacted - a failure visible only deep in
    // a run trace. The sender can fix a typo; they cannot fix a blocked action
    // they never see.
    if (!isUsableTimezone(timezone)) {
      return badRequest(`"${timezone}" is not an IANA timezone name, e.g. "Asia/Kolkata".`);
    }

    const tenant = await db.tenant.findUnique({
      where: { slug: body.tenantSlug },
      select: { id: true },
    });
    if (!tenant) return notFound(`No workspace with slug "${body.tenantSlug}".`);

    const now = new Date();
    const payload = payloadFrom(body, now);
    const externalId = body.externalId ?? derivedExternalId(tenant.id, body);

    const result = await db.$transaction(async (tx) => {
      // Upsert, not create. Lead webhooks retry on every timeout and on every
      // 5xx, so the same enquiry arrives three or six times; the compound unique
      // on (tenantId, externalId) is what makes those one lead instead of six.
      const kase = await tx.case.upsert({
        where: { tenantId_externalId: { tenantId: tenant.id, externalId } },
        create: {
          tenantId: tenant.id,
          externalId,
          subject: subjectFor(payload),
          contactName: body.contactName ?? null,
          contactEmail: body.contactEmail ?? null,
          contactPhone: body.contactPhone ?? null,
          timezone,
          payload: payload as unknown as Prisma.InputJsonValue,
          lastInboundAt: now,
        },
        update: {
          // Only the inbound clock moves. The payload carries `arrivedAt`, every
          // latency number in the product is measured from it, and a retry four
          // seconds later rewriting it would make our response time look better
          // than it was. The first arrival is the true one.
          //
          // Moving lastInboundAt is right either way: a retry is the same person
          // still waiting, and a genuine second message is the same person
          // talking again. Both should keep the reactive-reply exemption alive.
          lastInboundAt: now,
        },
      });

      // A retry that lost the race to create the case still gets this far, so
      // the case is not the only thing that needs de-duplicating - six webhooks
      // would otherwise start six loops racing each other over one lead.
      //
      // Best-effort by construction: two simultaneous retries can both read no
      // live run under read-committed. The guarantee that survives that race is
      // a layer down, on proposed_actions.idempotency_key, where a unique index
      // stops the second loop from writing the same action the first already
      // did. This check just means the common case never gets that far.
      const live = await tx.agentRun.findFirst({
        where: { caseId: kase.id, status: { in: LIVE_RUN_STATUSES } },
        orderBy: { startedAt: "desc" },
        select: { id: true },
      });

      const run =
        live ??
        (await tx.agentRun.create({
          data: {
            tenantId: tenant.id,
            caseId: kase.id,
            arm: "AGENT",
            // Derived from the case id and nothing else. No Math.random(), no
            // clock: determinism is what makes a run replayable, and it is what
            // lets the CONTROL arm draw the identical numbers for the identical
            // case so a measured lift is the decisions rather than the dice.
            seed: seedToInt(kase.id).toString(16).padStart(8, "0"),
          },
          select: { id: true },
        }));

      await record(
        {
          tenantId: tenant.id,
          entity: "case",
          entityId: kase.id,
          event: "lead_received",
          actor: "system",
          // `started: false` is the interesting row. A month later it is how you
          // tell "the provider sent this once" from "the provider sent it six
          // times and we answered once".
          data: {
            source: payload.source,
            externalId,
            runId: run.id,
            started: live === null,
          },
        },
        tx,
      );

      return { caseId: kase.id, runId: run.id, started: live === null };
    });

    if (result.started) {
      // The sender gets its 202 now; the loop keeps running behind it.
      //
      // after() rather than a floating promise: a floating promise is killed the
      // moment a serverless invocation is frozen after its response, which is
      // exactly when this work would still be going. after() is the supported
      // way to keep the invocation alive past the response.
      //
      // Honestly, this is still the weak link. Nothing here survives a deploy, a
      // crash, or an instance being reclaimed mid-loop - a run stranded that way
      // sits in RUNNING with nobody advancing it. In production this becomes a
      // durable queue: enqueue the run id, let a worker lease it, retry on
      // failure. The schema is already shaped for that - the run row is written
      // before the loop starts, so a worker can pick up anything left behind and
      // POST /api/runs/{id}/advance already resumes one by hand.
      after(async () => {
        try {
          await advanceRun(result.runId);
        } catch (cause) {
          // Never rethrown. An unhandled rejection out here takes the process
          // down and every other request with it, over one lead.
          console.error(`[ingest] run ${result.runId} did not complete`, cause);
        }
      });
    }

    // 202, not 201: the lead is recorded, the work it triggered is not done.
    return ok(result, { status: 202 });
  } catch (cause) {
    return serverError(cause);
  }
}

/**
 * Fixed-length compare on a digest rather than on the secrets themselves, so
 * neither a length difference nor an early mismatch is measurable.
 */
function authentic(request: Request): boolean {
  if (!INGEST_SECRET) return true;
  const offered = request.headers.get("x-warden-secret") ?? "";
  return timingSafeEqual(sha256(offered), sha256(INGEST_SECRET));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function payloadFrom(body: IngestBody, arrivedAt: Date): LeadPayload {
  return {
    source: body.source,
    message: body.message,
    service: body.service ?? null,
    // Stored empty rather than invented. renderTemplate() already reads "" as
    // absent and refuses to send a template whose city slot cannot be filled,
    // which is the behaviour we want: no message goes out reading "the right
    // details for IELTS coaching in ".
    city: body.city ?? "",
    arrivedAt: arrivedAt.toISOString(),
    // The enum has no "unknown" member, so silence has to land on one of three
    // real states. `comparing` is the one that moves scoreLead() least (+5 of a
    // -15..+25 range) - a sender who told us nothing should not be scored as
    // though they had.
    urgency: body.urgency ?? "comparing",
    // `none` is not a guess here, it is the literal truth: the field is a
    // signal strength and no signal arrived. Its -10 is the calibrated cost of
    // that, and it is the same cost a sender who wrote `"none"` explicitly pays.
    budgetSignal: body.budgetSignal ?? "none",
  };
}

/**
 * Matches subjectFor() in scripts/seed.ts, so a lead that arrives over the wire
 * and a lead the seeder wrote read the same in the case list.
 */
function subjectFor(lead: LeadPayload): string {
  const via = lead.source.replace(/_/g, " ");
  if (lead.service) return `${lead.service} enquiry via ${via}`;
  const msg =
    lead.message.length > 56 ? `${lead.message.slice(0, 55).trimEnd()}...` : lead.message;
  return `"${msg}" via ${via}`;
}

/**
 * A sender with no id of its own still needs one, because the uniqueness that
 * stops a retry storm is a database constraint on (tenantId, externalId) and
 * Postgres treats every NULL as distinct - a nullable externalId de-duplicates
 * nothing.
 *
 * So it is derived from what identifies the enquiry: who it is from, where it
 * came from, and what it says. A retry re-sends those bytes exactly and
 * collapses onto the same case. The cost is the other direction: the same
 * person sending the same words again later is read as the same lead rather
 * than a new one. That is the right way round to be wrong - an extra run on one
 * case is recoverable, six cases for one customer is not - and a sender that
 * wants the other behaviour sends its own externalId.
 */
function derivedExternalId(tenantId: string, body: IngestBody): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        tenantId,
        body.source,
        body.contactPhone ?? "",
        body.contactEmail ?? "",
        body.contactName ?? "",
        body.message,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  // Prefixed so it is obvious in the console that we minted this and the source
  // system has no such id to look up.
  return `wh_${digest}`;
}

/** Same try/catch shape policy.ts uses, and for the same reason: Intl throws. */
function isUsableTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}
