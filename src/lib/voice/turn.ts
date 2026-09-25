import { randomUUID } from "node:crypto";

import type { Case, Prisma } from "@/generated/prisma/client";
import { record } from "@/lib/agent/audit";
import { advanceRun, type RunOutcome } from "@/lib/agent/runtime";
import type { ActionType } from "@/lib/agent/types";
import type { Session } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { LeadPayloadSchema, scoreLead, type LeadPayload } from "@/lib/domain/lead";

import type { VoiceTurnAction, VoiceTurnBlock, VoiceTurnData } from "./types";

/**
 * One spoken turn, from a transcript to an answer.
 *
 * The browser does the listening; this does the deciding. Everything past the
 * transcript is the ordinary runtime - a Case, an AgentRun, advanceRun() - so a
 * lead that arrived by voice is gated by exactly the same policy engine as one
 * that arrived by webhook, and lands in the same approval queue. Voice is a
 * front door, not a second code path.
 *
 * It lives here rather than inside the route handler for two reasons. A Next
 * route module may only export HTTP verbs, so anything in one can be reached
 * exclusively over the network - which means the whole of this, the part worth
 * testing, could only be exercised through a session cookie. And the route's
 * own job is small enough to read at a glance once this is out of it.
 */

/** Long enough for a rambling enquiry, short enough that nobody pastes a book. */
export const MAX_TRANSCRIPT = 2_000;

/**
 * A case payload carries the whole spoken conversation, and the model reads it
 * verbatim on every resume. Bounded so a long demo cannot grow one case into a
 * prompt that costs more than the lead is worth.
 */
const MAX_CONVERSATION = 4_000;

/** Statuses where a run is still this case's live one. */
const LIVE: Prisma.EnumRunStatusFilter["in"] = ["PENDING", "RUNNING", "AWAITING_APPROVAL"];

/**
 * A failure the caller is responsible for and can be told about plainly.
 *
 * Anything else thrown out of here is ours, and the route turns it into a
 * reference rather than a description - a Prisma error quotes table and column
 * names, and this response is rendered in a browser.
 */
export class VoiceTurnError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VoiceTurnError";
    this.status = status;
  }
}

export async function takeVoiceTurn(args: {
  session: Session;
  /** Null on the first turn - a case is opened from what was said. */
  caseId: string | null;
  transcript: string;
  now?: Date;
}): Promise<VoiceTurnData> {
  const { session, caseId } = args;
  const { tenant, user } = session;
  const now = args.now ?? new Date();
  const started = Date.now();

  const transcript = collapse(args.transcript);
  if (!transcript) throw new VoiceTurnError("Nothing was said.", 400);
  if (transcript.length > MAX_TRANSCRIPT) {
    throw new VoiceTurnError(
      `That is longer than ${MAX_TRANSCRIPT} characters. Say it in a sentence or two.`,
      400,
    );
  }

  // Every read and write below is scoped to this tenant. A caseId arriving from
  // a browser is an id somebody typed until it has been matched against one.
  const existing = caseId
    ? await db.case.findFirst({ where: { id: caseId, tenantId: tenant.id } })
    : null;
  if (caseId && !existing) throw new VoiceTurnError("No such case in this workspace.", 404);

  const kase = existing
    ? await continueCase(existing, transcript, now)
    : await openCase(session, transcript, now);

  await record({
    tenantId: tenant.id,
    entity: "case",
    entityId: kase.id,
    event: existing ? "voice_turn" : "opened_by_voice",
    actor: `user:${user.id}`,
    data: { transcript, qualification: qualify(kase) },
  });

  const live = await db.agentRun.findFirst({
    where: { caseId: kase.id, tenantId: tenant.id, status: { in: LIVE } },
    orderBy: { startedAt: "desc" },
  });

  // A parked run is not resumed by talking at it. The action it stopped on is
  // sitting in the approval queue with a human's name on it, and re-entering
  // the model here would either re-propose the same thing or talk the run past
  // the very decision it stopped for. Say where it is instead.
  if (live?.status === "AWAITING_APPROVAL") {
    const parked = await awaitingAction(tenant.id, live.awaitingActionId);
    return {
      caseId: kase.id,
      subject: kase.subject,
      runId: live.id,
      runStatus: "AWAITING_APPROVAL",
      reply: parked
        ? `I heard you, but I am still holding. I proposed ${readableAction(parked.type)} and it needs a person to sign it before anything reaches the customer. Approve or reject it and I will carry on.`
        : "I am holding on a proposal that still needs a person to sign it.",
      awaitingAction: parked,
      blocked: [],
      latencyMs: Date.now() - started,
      steps: live.stepCount,
    };
  }

  const run =
    live ??
    (await db.agentRun.create({
      data: {
        tenantId: tenant.id,
        caseId: kase.id,
        // Common random numbers. A voice run is an AGENT-arm run like any
        // other, so it gets a seed an eval could reuse against the control arm.
        seed: randomUUID(),
      },
    }));

  // Where this turn's steps begin. Anything below this index belongs to an
  // earlier sentence in the same conversation and has already been reported.
  const from = run.stepCount;

  const outcome = await advanceRun(run.id);
  const [spoken, blocked, steps] = await Promise.all([
    narrate(outcome, tenant.id),
    policyBlocksSince(outcome.runId, from),
    stepCount(outcome.runId),
  ]);

  return {
    caseId: kase.id,
    subject: kase.subject,
    runId: outcome.runId,
    runStatus: outcome.status,
    reply: spoken.reply,
    awaitingAction: spoken.awaitingAction,
    blocked,
    latencyMs: Date.now() - started,
    steps,
  };
}

// ---------------------------------------------------------------- the case

async function openCase(session: Session, transcript: string, now: Date): Promise<Case> {
  const payload: LeadPayload = {
    // The schema has no "voice" source, and this is the closest true thing: an
    // Indian SMB's inbound voice enquiry behaves like its WhatsApp one - a
    // person talking in their own words, expecting an answer in minutes.
    source: "whatsapp",
    message: transcript,
    service: null,
    // Empty means not stated, and that is deliberate. An invented city does not
    // stay in a database - it lands verbatim in a customer's message through
    // the {{city}} slot, which templates.ts refuses to send for exactly that
    // reason. Nothing spoken here reliably yields one.
    city: "",
    arrivedAt: now.toISOString(),
    // Unlike city, these two never reach a recipient. They feed scoreLead, so a
    // guess costs a few points of priority rather than someone's trust.
    urgency: URGENT.test(transcript) ? "ready" : "comparing",
    budgetSignal: "none",
  };

  return db.case.create({
    data: {
      tenantId: session.tenant.id,
      subject: subjectFrom(transcript),
      // A run starts inside this same request, so OPEN would be stale before
      // the response was written.
      status: "IN_PROGRESS",
      payload: payload as unknown as Prisma.InputJsonValue,
      lastInboundAt: now,
    },
  });
}

/**
 * Folds a follow-up utterance into the case.
 *
 * `lastInboundAt` is what earns the reactive-reply exemption in policy.ts - the
 * contact window exists to stop us interrupting people, not to stop us
 * answering them, and somebody who is mid-sentence is plainly not being
 * interrupted.
 *
 * The words go into `payload.message` because runtime.ts rebuilds the model's
 * context from the case payload and the committed step log, and nothing else.
 * A second sentence stored anywhere else is a sentence the agent never hears.
 */
async function continueCase(kase: Case, transcript: string, now: Date): Promise<Case> {
  // Case.payload is Json and this case may have been opened by something other
  // than voice, so it is whatever that writer put there - including a string or
  // an array. Anything that is not an object is replaced rather than spread.
  const payload = isJsonObject(kase.payload) ? kase.payload : {};
  const previous = typeof payload.message === "string" ? payload.message : "";
  const joined = previous ? `${previous}\n${transcript}` : transcript;
  const message =
    joined.length <= MAX_CONVERSATION ? joined : joined.slice(joined.length - MAX_CONVERSATION);

  return db.case.update({
    where: { id: kase.id },
    data: {
      payload: { ...payload, message } as Prisma.InputJsonValue,
      lastInboundAt: now,
      status: kase.status === "OPEN" ? "IN_PROGRESS" : kase.status,
    },
  });
}

/**
 * Scoring is deterministic and lives outside the model, so it means something
 * in an append-only log months later.
 *
 * Parsed rather than cast: scoreLead indexes lookup tables by urgency, source
 * and budget signal, and a payload written by some other ingest path with a
 * field missing would score NaN and record it as fact.
 */
function qualify(kase: Case): { score: number; tier: string } | null {
  const payload = LeadPayloadSchema.safeParse(kase.payload);
  if (!payload.success) return null;
  const { score, tier } = scoreLead(payload.data);
  return { score, tier };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- the guardrail

/**
 * Re-reads what policy refused during this turn out of the committed steps.
 *
 * Derived rather than returned from the loop on purpose. `advanceRun` reports
 * where a run stopped, and a blocked proposal does not stop a run - the agent
 * is told why and picks something else, which is the behaviour worth showing.
 * The only durable record of that is the step log, and reading it back means
 * the console shows what was actually written down rather than what this
 * process happened to observe.
 */
async function policyBlocksSince(runId: string, fromIndex: number): Promise<VoiceTurnBlock[]> {
  const steps = await db.runStep.findMany({
    where: { runId, index: { gte: fromIndex }, kind: { in: ["TOOL_CALL", "POLICY_CHECK"] } },
    orderBy: { index: "asc" },
    select: { kind: true, toolName: true, toolArgs: true, content: true, detail: true },
  });

  const blocks: VoiceTurnBlock[] = [];
  let proposed: string | null = null;

  for (const step of steps) {
    if (step.kind === "TOOL_CALL") {
      // The proposal is committed one step before the verdict on it, so the
      // most recent one is what any following check was checking.
      proposed =
        step.toolName === "propose_action" && isJsonObject(step.toolArgs)
          ? stringOrNull(step.toolArgs.type)
          : proposed;
      continue;
    }

    if (!step.content?.startsWith("blocked:")) continue;
    const failed = failingCheck(step.detail);
    blocks.push({
      check: failed?.name ?? step.content.slice("blocked:".length).trim(),
      detail: failed?.detail ?? "Policy refused this action.",
      actionType: proposed,
    });
  }

  return blocks;
}

/** `{ checks: CheckResult[] }` as runtime.ts writes it, guarded the whole way down. */
function failingCheck(detail: unknown): { name: string; detail: string } | null {
  if (!isJsonObject(detail) || !Array.isArray(detail.checks)) return null;

  for (const entry of detail.checks) {
    if (!isJsonObject(entry) || entry.passed !== false) continue;
    const name = stringOrNull(entry.name);
    if (!name) continue;
    return { name, detail: stringOrNull(entry.detail) ?? "Policy refused this action." };
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function stepCount(runId: string): Promise<number> {
  const run = await db.agentRun.findUnique({ where: { id: runId }, select: { stepCount: true } });
  return run?.stepCount ?? 0;
}

// ---------------------------------------------------------------- the reply

async function narrate(
  outcome: RunOutcome,
  tenantId: string,
): Promise<{ reply: string; awaitingAction: VoiceTurnAction | null }> {
  switch (outcome.status) {
    case "AWAITING_APPROVAL": {
      const action = await awaitingAction(tenantId, outcome.actionId);
      if (!action) {
        return {
          reply: "I have stopped on a proposal that needs a person to sign it.",
          awaitingAction: null,
        };
      }
      return {
        reply: [
          `I want to ${readableAction(action.type)}, and I have stopped there.`,
          `My reason: ${speakable(action.reason)}`,
          "It is in the approval queue now. Nothing reaches the customer until somebody signs it.",
        ].join(" "),
        awaitingAction: action,
      };
    }

    case "BLOCKED_BY_POLICY":
      return {
        reply: `Policy stopped me: ${readableCheck(outcome.blockedBy)}. Nothing was sent, and I am not going to argue with it.`,
        awaitingAction: null,
      };

    case "FAILED":
      return {
        reply: `That run failed before anything happened: ${speakable(outcome.error)}. Nothing reached the customer.`,
        awaitingAction: null,
      };

    case "COMPLETED": {
      const summary = speakable(outcome.summary);
      return {
        reply: summary || "I am done with that one. Nothing further was warranted.",
        awaitingAction: null,
      };
    }
  }
}

async function awaitingAction(
  tenantId: string,
  actionId: string | null,
): Promise<VoiceTurnAction | null> {
  if (!actionId) return null;
  const action = await db.proposedAction.findFirst({
    where: { id: actionId, tenantId },
    select: { id: true, type: true, status: true, reason: true, valuePaise: true },
  });
  return action ?? null;
}

/** Said out loud, so each one is a verb phrase rather than an enum. */
const ACTION_PHRASES: Record<ActionType, string> = {
  send_templated_reply: "send the pre-approved reply",
  send_email: "send an email",
  send_sms: "send an SMS",
  place_call: "call them",
  schedule_callback: "schedule a callback",
  update_case: "update the case",
  escalate_to_human: "hand this to a person",
  close_case: "close the case",
};

export function readableAction(type: string): string {
  return ACTION_PHRASES[type as ActionType] ?? `run ${type.replace(/_/g, " ")}`;
}

/** The check names policy.ts blocks on, in the words the operator would use. */
const CHECK_PHRASES: Record<string, string> = {
  opt_out: "this person has opted out of contact, and there is no override",
  action_allowed: "that action is not enabled for this workspace",
  attempt_budget: "this case has used up its contact attempts",
  run_action_ceiling: "this run hit its action ceiling",
  contact_window: "it is outside the contact window in their timezone",
  value_ceiling: "it costs more than the per-action limit allows",
  template_approved: "that template has not been approved here",
  template_variables: "it tried to fill a variable that is not substitutable",
  max_run_steps: "the run reached its step budget",
};

function readableCheck(name: string): string {
  return CHECK_PHRASES[name] ?? name.replace(/_/g, " ");
}

// ---------------------------------------------------------------- text

const URGENT = /\b(today|tonight|right now|urgent|urgently|asap|immediately|abhi|turant|jaldi)\b/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The reply is spoken as well as shown. A synthesiser reads punctuation it does
 * not recognise out loud - "asterisk asterisk done" - so the markdown a model
 * reaches for by habit comes off before it reaches anyone's speakers.
 */
function speakable(text: string): string {
  const clean = collapse(text.replace(/[*_`#>|]+/g, " "));
  if (clean.length <= 600) return clean;
  const cut = clean.slice(0, 600);
  const boundary = cut.lastIndexOf(". ");
  return boundary > 200 ? cut.slice(0, boundary + 1) : `${cut.trimEnd()}…`;
}

/** The case list shows this, so it is one line and it is their words. */
function subjectFrom(transcript: string): string {
  if (transcript.length <= 72) return transcript;
  const cut = transcript.slice(0, 71);
  const atWord = cut.replace(/\s+\S*$/, "");
  return `${atWord.length > 20 ? atWord : cut}…`;
}
