/**
 * pnpm demo:run [--fresh] [--scenario callback|reply|blocked] [--case <externalId>]
 *               [--tenant-slug demo] [--list]
 *
 * Drives one lead through the real runtime against the real database: policy
 * engine, model, write-ahead persistence, audit log and all. No HTTP server
 * and no browser, so a failure here is the runtime's and nothing else's.
 *
 * This is the on-camera driver. Two things follow from that.
 *
 * It has to WORK, on a laptop, on a hotel network, at whatever hour the
 * recording happens. Groq's free tier caps this model at a few thousand tokens
 * a minute and will refuse mid-run; because the loop is durable, a refusal is
 * survivable - the committed steps stay committed and the run is resumed
 * rather than restarted. That is handled here rather than announced.
 *
 * And it has to produce something worth watching. `--fresh` mints a lead that
 * has just landed, which puts it inside the reactive-reply grace window and so
 * takes the contact window out of play at any hour of the day; `--scenario`
 * picks which guardrail the trace is meant to demonstrate, and each one states
 * up front what it is built to make happen. The agent is not deterministic, so
 * a `--fresh` run that takes a different legitimate route is given another lead
 * of the same shape - at most FRESH_ATTEMPTS of them, each one that is passed
 * over named on screen with its trace id. Every run here is a real run against
 * the real model. Nothing fabricates a step, and nothing is quietly dropped.
 */
import "dotenv/config";

import { activeProvider, modelLabel } from "@/lib/agent/model";
import { advanceRun, type RunOutcome } from "@/lib/agent/runtime";
import { db } from "@/lib/db";

import type { Case, ProposedAction, RunStep, Tenant } from "@/generated/prisma/client";

/** Transport failures worth resuming a run through. Anything else is a finding. */
const RETRYABLE = /rate.?limit|429|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up/i;

/**
 * What a scenario is built to demonstrate, checked against the run afterwards.
 *
 * A status is not enough. The blocked scenario is interesting whether the agent
 * recovers by escalating (COMPLETED) or by proposing a callback
 * (AWAITING_APPROVAL) - what has to be in the trace is the refusal itself.
 */
type Target =
  | { kind: "parked" }
  | { kind: "delivered" }
  | { kind: "blocked"; by: string };

type Scenario = {
  name: string;
  /** What a viewer is supposed to see happen. Printed before the run starts. */
  expect: string;
  target: Target;
  contactName: string;
  timezone: string;
  /**
   * How long ago the enquiry landed. Inside Policy.inboundReplyGraceMinutes
   * the contact window does not apply, which is what makes a reply demoable at
   * three in the morning; outside it, the window is live and will block.
   */
  minutesAgo: number;
  /** Contact attempts already spent on this lead before the run starts. */
  attemptCount: number;
  subject: string;
  lead: {
    source: string;
    message: string;
    service: string | null;
    city: string;
    urgency: string;
    budgetSignal: string;
  };
};

const SCENARIOS: Record<string, Scenario> = {
  /**
   * The default, and the one the whole product is about.
   *
   * She has already been offered a slot and has said yes to it, which splits
   * the two halves of the thesis apart in a single trace: the SMS confirming
   * the offer goes out unattended because a human signed that wording months
   * ago, and then the agent tries to put a real call in a real diary - a
   * promise nobody signed - and the run stops dead waiting for a person.
   */
  callback: {
    name: "callback",
    expect:
      "she has already said yes to a time. Offering a slot is pre-approved wording; committing the business to one is not - so the run parks in AWAITING_APPROVAL",
    target: { kind: "parked" },
    contactName: "Asha",
    timezone: "Asia/Kolkata",
    minutesAgo: 3,
    // One attempt already spent: the callback offer she is replying to.
    attemptCount: 1,
    subject: "NEET repeater batch enquiry via missed call",
    lead: {
      source: "missed_call",
      message:
        "YES. kal 7:30pm chalega. please confirm the call is booked, main wait karunga.",
      service: "NEET repeater batch",
      city: "Indore",
      urgency: "ready",
      budgetSignal: "mid",
    },
  },

  reply: {
    name: "reply",
    expect:
      "a fresh enquiry, in hours. The agent answers from a template a human signed in advance, so nobody is asked and the run completes",
    target: { kind: "delivered" },
    contactName: "Meera",
    timezone: "Asia/Kolkata",
    minutesAgo: 2,
    attemptCount: 0,
    subject: "IELTS coaching enquiry via whatsapp",
    lead: {
      source: "whatsapp",
      message: "hi, weekend batch ki fees kitni hai? I work full time so weekdays are hard.",
      service: "IELTS coaching",
      city: "Pune",
      urgency: "ready",
      budgetSignal: "mid",
    },
  },

  blocked: {
    name: "blocked",
    // Los Angeles rather than a late hour in India, so this works during the
    // Indian working day - which is when a demo gets recorded. 09:00-20:00 in
    // her timezone is the middle of the Indian afternoon's night.
    expect:
      "the recipient is in California, where it is the middle of the night. Policy refuses the reply on the contact window and the agent has to find another way",
    target: { kind: "blocked", by: "contact_window" },
    contactName: "Priya",
    timezone: "America/Los_Angeles",
    // Deliberately outside the grace window: inside it the reply is exempt and
    // there is no block to show.
    minutesAgo: 185,
    attemptCount: 0,
    subject: "2BHK in Kharadi enquiry via website form",
    lead: {
      source: "website_form",
      message:
        "Hi, is the 2BHK in Kharadi still available? I am in California, so please WhatsApp me the details or call me in my morning.",
      service: "2BHK in Kharadi",
      city: "Pune",
      urgency: "comparing",
      budgetSignal: "high",
    },
  },
};

/** How many fresh leads of the same shape to try before showing what came out. */
const FRESH_ATTEMPTS = 3;

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(70));

async function main(): Promise<void> {
  if (has("list")) return listScenarios();

  const scenarioName = flag("scenario", "callback");
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(
      `No scenario "${scenarioName}". Known: ${Object.keys(SCENARIOS).join(", ")}. Try --list.`,
    );
  }

  // Fail here, with a sentence, rather than eleven seconds into a run.
  activeProvider();

  const tenant = await resolveTenant(flag("tenant-slug", ""));
  const fresh = has("fresh");

  // With --fresh the lead is ours to mint, so a run that took a different
  // legitimate route gets another lead of the same shape rather than a
  // shrug - up to FRESH_ATTEMPTS, and every attempt that is passed over is
  // named out loud with its trace id. The agent is not deterministic and this
  // driver is not going to pretend otherwise; what it will not do is hide that
  // the take you are watching is the second one.
  const attempts = fresh ? FRESH_ATTEMPTS : 1;
  let attempt = 0;
  let result: Attempt;

  for (;;) {
    attempt += 1;
    const kase = fresh
      ? await mintFreshCase(tenant, scenario)
      : await pickExistingCase(tenant, flag("case", ""));

    if (attempt === 1) header(tenant, kase, fresh ? scenario : null);

    result = await driveOnce(kase);

    if (!fresh || attempt >= attempts || meetsTarget(scenario.target, result)) break;

    line(
      `  ..  ${result.outcome.status} - ${missReason(scenario.target, result)}.` +
        ` Trace kept at /runs/${result.runId}; trying another lead of the same shape.`,
    );
  }

  printTrace(result.steps);
  printActions(result.actions);
  await printOutcome({ tenant, scenario: fresh ? scenario : null, attempt, result });
}

type Attempt = {
  runId: string;
  outcome: RunOutcome;
  steps: RunStep[];
  actions: ProposedAction[];
  elapsedMs: number;
};

async function driveOnce(kase: Case): Promise<Attempt> {
  const run = await db.agentRun.create({
    data: {
      tenantId: kase.tenantId,
      caseId: kase.id,
      arm: "AGENT",
      // Deterministic: the same case always produces the same run identity.
      seed: `demo:${kase.externalId ?? kase.id}`,
    },
  });

  const started = Date.now();
  const outcome = await advanceWithResume(run.id);
  const elapsedMs = Date.now() - started;

  return {
    runId: run.id,
    outcome,
    elapsedMs,
    steps: await db.runStep.findMany({ where: { runId: run.id }, orderBy: { index: "asc" } }),
    actions: await db.proposedAction.findMany({
      where: { runId: run.id },
      orderBy: { proposedAt: "asc" },
    }),
  };
}

function meetsTarget(target: Target, result: Attempt): boolean {
  switch (target.kind) {
    case "parked":
      return result.outcome.status === "AWAITING_APPROVAL";
    case "delivered":
      return result.actions.some(
        (a) => a.status === "EXECUTED" && a.type === "send_templated_reply",
      );
    case "blocked":
      return blockedChecks(result.steps).includes(target.by);
  }
}

function describeTarget(target: Target): string {
  switch (target.kind) {
    case "parked":
      return "a run that stops in AWAITING_APPROVAL";
    case "delivered":
      return "a pre-approved template actually delivered";
    case "blocked":
      return `policy refusing a proposal on ${target.by}`;
  }
}

function missReason(target: Target, result: Attempt): string {
  switch (target.kind) {
    case "parked":
      return "nothing it proposed needed a person";
    case "delivered":
      return "no template reply went out";
    case "blocked": {
      const got = blockedChecks(result.steps);
      return got.length > 0
        ? `policy refused ${got.join(", ")} rather than ${target.by}`
        : `policy refused nothing, so there is no ${target.by} block to show`;
    }
  }
}

// ---------------------------------------------------------------- setup

function listScenarios(): void {
  line();
  line("pnpm demo:run --fresh --scenario <name>");
  rule();
  for (const s of Object.values(SCENARIOS)) {
    line(`  ${s.name.padEnd(10)} ${s.expect}`);
    line(`  ${" ".repeat(10)} "${s.lead.message}"`);
    line(
      `  ${" ".repeat(10)} ${s.contactName}, ${s.timezone}, landed ${s.minutesAgo} min ago,` +
        ` ${s.attemptCount} attempt${s.attemptCount === 1 ? "" : "s"} already spent`,
    );
    line(`  ${" ".repeat(10)} looks for: ${describeTarget(s.target)}`);
    line();
  }
  line(`Up to ${FRESH_ATTEMPTS} fresh leads are tried per scenario; passed-over traces are named.`);
  line("Without --fresh it runs the newest seeded lead that has no run yet.");
  line();
}

async function resolveTenant(slug: string): Promise<Tenant> {
  if (slug) {
    const found = await db.tenant.findUnique({ where: { slug } });
    if (!found) throw new Error(`No tenant with slug "${slug}".`);
    return found;
  }
  const demo = await db.tenant.findUnique({ where: { slug: "demo" } });
  if (demo) return demo;

  const first = await db.tenant.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) throw new Error("No tenants in the database. Run `pnpm seed` first.");
  return first;
}

/**
 * A lead that landed moments ago.
 *
 * `lastInboundAt` is what the reactive-reply exemption reads, so setting it to
 * now is not a trick to get past the guardrail - it is the guardrail's own
 * rule: a window exists to stop us interrupting people, not to stop us
 * answering them. This is the same path the live ingest panel takes.
 */
async function mintFreshCase(tenant: Tenant, scenario: Scenario): Promise<Case> {
  const now = new Date();
  const arrivedAt = new Date(now.getTime() - scenario.minutesAgo * 60_000);
  // Millisecond-resolution, because two attempts of the same scenario can land
  // inside one second and (tenantId, externalId) is unique.
  const stamp = now.getTime().toString(36);

  return db.case.create({
    data: {
      tenantId: tenant.id,
      externalId: `demo-${scenario.name}-${stamp}`,
      subject: scenario.subject,
      contactName: scenario.contactName,
      contactEmail: `demo-${scenario.name}@leads.invalid`,
      contactPhone: "+91-00000-00042",
      timezone: scenario.timezone,
      lastInboundAt: arrivedAt,
      createdAt: arrivedAt,
      attemptCount: scenario.attemptCount,
      payload: {
        ...scenario.lead,
        arrivedAt: arrivedAt.toISOString(),
        // The agent is handed Case.payload verbatim and has no other way to
        // learn whose business it is answering for. Without this it invents a
        // company name and puts it in a customer's message.
        businessName: tenant.name,
      },
    },
  });
}

async function pickExistingCase(tenant: Tenant, externalId: string): Promise<Case> {
  if (externalId) {
    const found = await db.case.findUnique({
      where: { tenantId_externalId: { tenantId: tenant.id, externalId } },
    });
    if (!found) throw new Error(`No case "${externalId}" in tenant "${tenant.slug}".`);
    return found;
  }

  // An unworked lead first: running the agent over a case that already has a
  // trace produces a second, duller one and tells a viewer nothing.
  const unworked = await db.case.findFirst({
    where: { tenantId: tenant.id, runs: { none: {} } },
    orderBy: { createdAt: "desc" },
  });
  if (unworked) return unworked;

  const any = await db.case.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: "desc" },
  });
  if (!any) throw new Error("No cases in this tenant. Run `pnpm seed` first.");
  return any;
}

function header(tenant: Tenant, kase: Case, scenario: Scenario | null): void {
  line();
  line(`model     ${modelLabel()}`);
  line(`tenant    ${tenant.name} (${tenant.slug})`);
  line(`case      ${kase.subject}`);
  line(`contact   ${kase.contactName ?? "-"}  ${kase.timezone}  local ${localTime(kase.timezone)}`);
  line(`enquiry   "${messageOf(kase.payload)}"`);
  line(`inbound   ${kase.lastInboundAt ? `${minutesSince(kase.lastInboundAt)} min ago` : "never"}`);
  line(`attempts  ${kase.attemptCount}${kase.optedOut ? "   OPTED OUT" : ""}`);
  if (scenario) line(`expect    ${scenario.expect}`);
  rule();
}

// ---------------------------------------------------------------- the run

/**
 * The run, plus the one recovery an unattended demo actually needs.
 *
 * A provider rate limit is a failed round trip, not a failed decision. Every
 * step taken before it is already committed, so the run goes back in flight
 * and continues from where it stopped - which is the entire reason the loop in
 * runtime.ts is hand-written instead of the AI SDK's in-memory one.
 */
async function advanceWithResume(runId: string): Promise<RunOutcome> {
  let outcome = await advanceRun(runId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (outcome.status !== "FAILED" || !RETRYABLE.test(outcome.error)) break;

    const waitMs = 15_000 + attempt * 20_000;
    const done = await db.runStep.count({ where: { runId } });
    line(
      `  ..  provider refused: ${firstLine(outcome.error)}` +
        `\n  ..  ${done} steps are already committed - resuming the run in ${Math.round(waitMs / 1000)}s`,
    );
    await sleep(waitMs);

    // advanceRun() will not touch a FAILED run, which is right for the API and
    // wrong for an operator retrying an outage. The steps are untouched, so
    // the model picks up the history rather than redoing the work.
    await db.agentRun.update({ where: { id: runId }, data: { status: "RUNNING", error: null } });
    outcome = await advanceRun(runId);
  }

  return outcome;
}

// ---------------------------------------------------------------- output

function printTrace(steps: RunStep[]): void {
  line("TRACE");
  for (const step of steps) {
    const meta = step.latencyMs !== null ? `${String(step.latencyMs).padStart(5)}ms` : " ".repeat(7);
    line(`  ${String(step.index).padStart(2)}  ${meta}  ${step.kind.padEnd(16)} ${headlineOf(step)}`);
    for (const detail of detailsOf(step)) line(`      ${" ".repeat(7)}  ${" ".repeat(16)} ${detail}`);
  }
  rule();
}

/** One line per step: what a viewer needs to follow it without pausing. */
function headlineOf(step: RunStep): string {
  switch (step.kind) {
    case "MODEL_CALL": {
      const tokens = `${step.promptTokens ?? 0} in / ${step.outputTokens ?? 0} out`;
      return step.content ? `${tokens}  ${oneLine(step.content, 60)}` : tokens;
    }
    case "TOOL_CALL":
      return `${step.toolName ?? "?"}  ${argSummary(step.toolArgs)}`;
    case "POLICY_CHECK":
      return step.content ?? "";
    default:
      return oneLine(step.content ?? "", 92);
  }
}

/**
 * The second line, and the one the demo is really about: when policy refuses
 * something, the refusal is only convincing if it says which rule and why.
 */
function detailsOf(step: RunStep): string[] {
  if (step.kind !== "POLICY_CHECK") return [];

  const checks = readChecks(step.detail);
  const failed = checks.find((c) => !c.passed);
  if (failed) return [`${failed.name}: ${failed.detail ?? "refused"}`];

  // Allowed: show the checks that actually carry a number, not the roll call.
  return checks
    .filter((c) => c.detail && c.detail !== "not a contact action" && c.detail !== "not a templated action")
    .map((c) => `${c.name}: ${c.detail}`);
}

function printActions(actions: ProposedAction[]): void {
  line("ACTIONS");
  if (actions.length === 0) {
    line("  none - every proposal this run made was refused by policy before it became a row");
    rule();
    return;
  }

  for (const action of actions) {
    const gate = action.autoApproved ? "auto-approved" : "needs a human";
    line(`  ${action.type}  ${action.status}  (${gate})`);
    line(`    reason   ${action.reason}`);
    line(`    args     ${oneLine(JSON.stringify(action.args), 96)}`);
    line(`    idem     ${action.idempotencyKey}`);
    const sent = sentText(action.result);
    if (sent) line(`    sent     "${sent}"`);
    if (action.error) line(`    error    ${action.error}`);
  }
  rule();
}

async function printOutcome(input: {
  tenant: Tenant;
  /** Null when an existing seeded lead was run - there is no beat to grade. */
  scenario: Scenario | null;
  attempt: number;
  result: Attempt;
}): Promise<void> {
  const { tenant, scenario, result } = input;
  const { outcome, steps } = result;

  const tokens = steps.reduce((a, s) => a + (s.promptTokens ?? 0) + (s.outputTokens ?? 0), 0);
  const blocked = blockedChecks(steps);
  const [audit, queueDepth] = await Promise.all([
    // Run-level and action-level entries both. The runtime keys a proposal's
    // audit row to the action, not the run, so counting only the run reports
    // zero for a parked run - which is the run that generated the most history.
    db.auditEvent.count({
      where: { entityId: { in: [result.runId, ...result.actions.map((a) => a.id)] } },
    }),
    db.proposedAction.count({
      where: { tenantId: tenant.id, status: "PROPOSED", run: { tenantId: tenant.id } },
    }),
  ]);

  line(`outcome   ${outcome.status}`);
  line(
    `steps     ${steps.length}   ${(result.elapsedMs / 1000).toFixed(1)}s wall   ` +
      `${tokens} tokens   ${audit} audit rows`,
  );
  if (blocked.length > 0) {
    line(
      `blocked   ${blocked.length} proposal${blocked.length === 1 ? "" : "s"} refused by policy: ` +
        blocked.join(", "),
    );
  }
  line(`trace     /runs/${result.runId}`);
  line(`queue     APPROVAL QUEUE DEPTH: ${queueDepth}`);
  if (input.attempt > 1) line(`attempts  ${input.attempt} leads of this shape - earlier traces are kept`);
  rule();

  // What the run means, in the terms a viewer was promised before it started.
  switch (outcome.status) {
    case "AWAITING_APPROVAL":
      line("The run has stopped and will not move again until a person decides.");
      line("Open /approvals: that action is sitting there with the policy verdict that let it");
      line("get that far, and nothing reaches the customer until somebody signs it.");
      break;
    case "COMPLETED":
      if (blocked.length > 0) {
        line(`Completed. Policy refused ${blocked.join(", ")} on the way and the agent had to find`);
        line("another route - the refusal is in the trace above, in the agent's own record.");
      } else if (result.actions.some((a) => a.type === "send_templated_reply" && a.status === "EXECUTED")) {
        line("Completed unattended, and that is the point: the only thing that reached her was");
        line("wording a human signed before this run existed. Free text would have stopped.");
      } else {
        line("Completed without contacting anyone. Nothing the agent did committed the business");
        line("to anything, so nothing needed a signature.");
      }
      break;
    case "BLOCKED_BY_POLICY":
      line(`Stopped by the step ceiling (${outcome.blockedBy}). A budget, not a crash.`);
      break;
    case "FAILED":
      line(`The run failed: ${outcome.error}`);
      line("Every step it did take is still committed - re-run to resume from there.");
      process.exitCode = 1;
      break;
  }

  if (scenario && outcome.status !== "FAILED" && !meetsTarget(scenario.target, result)) {
    line();
    line(
      `Note: this is not the beat "${scenario.name}" was built for -` +
        ` ${missReason(scenario.target, result)}.`,
    );
    line("Nothing is wrong; the agent chose a different legitimate route. Run it again, or");
    line(`try --scenario ${Object.keys(SCENARIOS).filter((n) => n !== scenario.name).join(" / --scenario ")}.`);
  }
  line();
}

// ---------------------------------------------------------------- helpers

type Check = { name: string; passed: boolean; detail?: string };

/**
 * Which policy checks refused a proposal in this run, in order.
 *
 * Read off the POLICY_CHECK steps rather than off proposed_actions, because a
 * refused proposal never becomes an action row at all - runtime.ts writes the
 * row only once the verdict allows it, which is the write-ahead ordering the
 * whole design rests on. The step log is the only record a block leaves.
 */
function blockedChecks(steps: RunStep[]): string[] {
  return steps
    .filter((s) => s.kind === "POLICY_CHECK" && s.content?.startsWith("blocked: "))
    .map((s) => s.content!.slice("blocked: ".length));
}

function readChecks(detail: unknown): Check[] {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return [];
  const checks = (detail as { checks?: unknown }).checks;
  return Array.isArray(checks) ? (checks as Check[]) : [];
}

function argSummary(argsJson: unknown): string {
  if (argsJson === null || typeof argsJson !== "object") return "";
  const obj = argsJson as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : null;
  if (!type) return oneLine(JSON.stringify(obj), 70);

  const inner = obj.args as Record<string, unknown> | undefined;
  const template = inner && typeof inner.templateId === "string" ? ` ${inner.templateId}` : "";
  return `${type}${template}`;
}

function sentText(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" ? oneLine(text, 300) : null;
}

function messageOf(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "-";
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? message : "-";
}

function localTime(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return "?";
  }
}

function minutesSince(at: Date): number {
  return Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000));
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function firstLine(message: string): string {
  return oneLine(message.split("\n")[0] ?? message, 110);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((err: unknown) => {
    console.error(`\ndemo:run failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
