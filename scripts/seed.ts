/**
 * pnpm seed [--reset] [--count 36] [--runs 8] [--seed warden-v1]
 *           [--tenant-slug demo] [--tpm 8000]
 *
 * Builds the demo workspace and then *works* it with the real runtime, so the
 * state a judge lands on is a system that has been running rather than a table
 * of untouched rows.
 *
 *   --reset   wipe this tenant's cases, runs and decision history first. The
 *             policy row and its provisioning audit entry survive, because
 *             those are the workspace's identity rather than its contents.
 *   --runs N  cap how many cast leads the agent actually works. 0 skips the
 *             model entirely, for a database-only re-seed on a bad network.
 *
 * Idempotent. Re-running it writes nothing that has not actually changed -
 * which matters more than it sounds, because `pnpm replay` reads
 * `Policy.updatedAt` and `Case.updatedAt` to work out whether a divergence is
 * corruption or just someone editing the tenant afterwards. A seed that
 * touched every row on every run would poison that signal. For the same reason
 * an existing case is never re-timed and a case that already has a run is
 * never re-run: both are history, and a seed does not get to rewrite history.
 *
 * THE HONESTY RULE. Traces come from advanceRun() against the live model
 * wherever one can be produced. Rows are constructed by hand only where a real
 * run cannot be made to happen on demand, and every constructed row is counted
 * separately in the summary and carries `constructed: true` in its audit
 * entry. A seed that quietly invents a trace the agent never produced would
 * make every other number in this product unbelievable.
 */
import "dotenv/config";

/**
 * Seeding is BATCH work and the demo is LIVE work, and they want different
 * providers.
 *
 * Groq's free tier caps gpt-oss-120b at 8,000 tokens per minute across the
 * whole organisation, while one agent run costs 1,500-6,000. Nine runs
 * back-to-back is not a workload that fits: five of nine failed on rate limit
 * the first time this seed was seriously exercised. Gemini's free tier is
 * request-rate limited rather than token limited, which is the shape this job
 * actually is.
 *
 * So unless the operator has said otherwise, batch seeding goes to Gemini and
 * the live demo keeps Groq, which is roughly twice as fast on camera. Set
 * WARDEN_PROVIDER explicitly to override.
 *
 * Done before any import that reads the provider, which is why it sits here
 * rather than inside main().
 */
if (!process.env.WARDEN_PROVIDER && process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  process.env.WARDEN_PROVIDER = "google";
  // WARDEN_MODEL is per-provider; a Groq model id would be meaningless here.
  if (process.env.WARDEN_MODEL?.includes("/")) delete process.env.WARDEN_MODEL;
}

import { record } from "@/lib/agent/audit";
import { idempotencyKey } from "@/lib/agent/idempotency";
import { evaluatePolicy } from "@/lib/agent/policy";
import { advanceRun } from "@/lib/agent/runtime";
import { rngFor } from "@/lib/agent/seed";
import type { Proposal } from "@/lib/agent/types";
import { DEFAULT_POLICY } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { scoreLead, type LeadPayload } from "@/lib/domain/lead";
import { generateLeads } from "@/lib/eval/fixtures";
import { renderTemplate } from "@/lib/templates";

import type { Case, Policy, Prisma, Tenant } from "@/generated/prisma/client";

const DEMO = {
  slug: "demo",
  name: "Sahyadri Services",
  // The fixture leads span coaching, dentistry, salons and property, so the
  // demo tenant is a services group rather than one shop. A case list where a
  // root canal enquiry arrives at a coaching institute reads as broken data.
  ownerEmail: "owner@sahyadri.test",
  operatorEmail: "operator@sahyadri.test",
} as const;

/** The business day is cut in IST, the same as the inbox cuts it. */
const BUSINESS_TZ = "Asia/Kolkata";

/**
 * Groq's free tier caps openai/gpt-oss-120b at 8000 tokens a minute across the
 * whole organisation, and one agent run costs between 1.5k and 6k of them.
 * Firing the cast off back to back therefore dies on a 429 around the third
 * lead. Override for a paid key with --tpm.
 */
const DEFAULT_TPM = 8000;

/** Transport failures worth resuming a run through. Anything else is a finding. */
const RETRYABLE = /rate.?limit|429|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up/i;

/**
 * The limit no amount of pacing can get around.
 *
 * `tokenPacer` below models tokens-per-MINUTE, and that is the cap this script
 * was written against. Groq also caps tokens per DAY - 200,000 on the free tier
 * for this model, which is about six full `--reset` seeds. Once that is gone a
 * sliding-minute pacer has nothing left to pace: every run fails, the retries
 * sit out their backoff, and eight leads take ten minutes to produce eight
 * FAILED rows. Naming it is the whole value here, because the fix is never
 * "wait a bit longer".
 */
const DAILY_LIMIT = /tokens per day|\bTPD\b/i;

/** How much of the daily budget is gone, when the provider says. */
function dailyLimitAdvice(error: string): string {
  const used = /Limit\s+(\d+),\s*Used\s+(\d+)/i.exec(error);
  const spent = used ? ` (${used[2]} of ${used[1]} used)` : "";
  return (
    `the provider's DAILY token budget is spent${spent} - not a transient` +
    " limit, so this is not being retried. Re-run with --runs 0 to rebuild the" +
    " workspace without the model, or use a key with a higher ceiling."
  );
}

/**
 * How long the provider itself asked us to wait.
 *
 * Groq's 429 carries the exact figure ("Please try again in 1m8.688s"), and
 * honouring it beats guessing in both directions: a fixed 20s retry into a
 * window that needs 70 more seconds burns an attempt and reports a failure
 * that was only ever a queue, and a fixed 45s wait on a 3s window idles for
 * nothing. Capped, because a number this side of the call is not to be trusted
 * with the whole run. Falls back to the old backoff when nothing is quoted.
 */
function retryAfterMs(error: string, attempt: number): number {
  const quoted = /try again in\s*(?:(\d+)m)?\s*([\d.]+)s/i.exec(error);
  if (!quoted) return 20_000 + attempt * 25_000;

  const seconds = Number(quoted[1] ?? 0) * 60 + Number(quoted[2] ?? 0);
  if (!Number.isFinite(seconds)) return 20_000 + attempt * 25_000;
  // A second of slack: the window is measured on their clock, not ours.
  return Math.min(120_000, Math.max(2_000, Math.round(seconds * 1000) + 1_000));
}

// ---------------------------------------------------------------- the cast

/**
 * Eight leads chosen so that every guardrail in policy.ts is visible in a real
 * trace, and so the inbox reads as an evening's work rather than a fixture
 * dump. The agent is turned loose on all of them: `beat` names the rule each
 * lead puts under test, never the route the agent will take to get there - it
 * picks that itself, and the summary reports what it actually did.
 *
 * Order matters twice. The inbox is newest-first, so this is the order a judge
 * reads the top of the list in; and the leads that end in a delivered reply are
 * first, because they are also the ones whose arrival times are minutes rather
 * than hours old. See the note on `minutesAgo`.
 *
 * Voice follows src/lib/eval/fixtures.ts: Hinglish, one-word enquiries, and
 * the occasional person who writes three sentences and expects three back.
 */
type CastLead = {
  externalId: string;
  contactName: string;
  /** The recipient's timezone. The contact window is read in it, never ours. */
  timezone: string;
  /**
   * How long before this seed ran the enquiry landed.
   *
   * Minutes, not hours, for every lead the agent will end up answering. The
   * inbox's median-first-response is measured from `lastInboundAt` to the first
   * delivered reply, so seeding a three-hour-old enquiry and answering it now
   * would record a three-hour response time that measures the age of the
   * backlog and says nothing about the agent - which in production answers a
   * lead as the ingest webhook lands it. The leads that get blocked are older,
   * because none of them produces a reply to time.
   */
  minutesAgo: number;
  /** Contact attempts already on the clock when we imported this lead. */
  attemptCount?: number;
  optedOut?: boolean;
  /** What this lead is in the cast to demonstrate. Printed in the summary. */
  beat: string;
  lead: Omit<LeadPayload, "arrivedAt">;
};

const CAST: readonly CastLead[] = [
  {
    externalId: "cast-asha-ielts",
    contactName: "Asha",
    timezone: "Asia/Kolkata",
    minutesAgo: 2,
    beat: "the ordinary path - a fresh enquiry answered from wording a human already signed",
    lead: {
      source: "whatsapp",
      message: "hi, weekend batch ki fees kitni hai? I work full time so weekdays are hard.",
      service: "IELTS coaching",
      city: "Pune",
      urgency: "ready",
      budgetSignal: "mid",
    },
  },
  {
    externalId: "cast-rohit-neet",
    contactName: "Rohit",
    timezone: "Asia/Kolkata",
    minutesAgo: 3,
    beat:
      "asks to be phoned - offering a slot from a signed template is fine, committing the business to one is not",
    lead: {
      source: "missed_call",
      message:
        "abhi call kiya tha, koi uthaya nahi. please call me back after 7pm today, NEET repeater batch ke liye.",
      service: "NEET repeater batch",
      city: "Indore",
      urgency: "ready",
      budgetSignal: "mid",
    },
  },
  {
    externalId: "cast-sneha-rootcanal",
    contactName: "Sneha",
    timezone: "Asia/Kolkata",
    minutesAgo: 5,
    beat: "named a service but no timeline - one qualifying question is cheaper than a wasted call",
    lead: {
      source: "whatsapp",
      message:
        "dentist ne bola root canal karna padega. kitna kharcha aayega? shop pe rehti hoon, can someone call me tomorrow morning?",
      service: "root canal",
      city: "Nagpur",
      urgency: "comparing",
      budgetSignal: "low",
    },
  },
  {
    externalId: "cast-vikram-neet",
    contactName: "Vikram",
    timezone: "Asia/Kolkata",
    minutesAgo: 7,
    beat: "a parent who wrote three sentences and expects three back",
    lead: {
      source: "website_form",
      message:
        "My daughter is in class 12 and we are looking at the repeater batch for next year. What is the schedule, what does the fee cover, and is there a hostel tie-up? We are in Jaipur.",
      service: "NEET repeater batch",
      city: "Jaipur",
      urgency: "comparing",
      budgetSignal: "high",
    },
  },
  {
    externalId: "cast-imran-price",
    contactName: "Imran",
    timezone: "Asia/Kolkata",
    minutesAgo: 14,
    beat: "one word and no service named - there is nothing here a template can fill honestly",
    lead: {
      source: "justdial",
      message: "price?",
      service: null,
      city: "Surat",
      urgency: "browsing",
      budgetSignal: "none",
    },
  },
  {
    externalId: "cast-fatima-bridal",
    contactName: "Fatima",
    timezone: "Asia/Kolkata",
    // Imported at the ceiling. The per-case attempt budget is what stops a keen
    // agent turning a warm lead into a nuisance, and it can only be shown on a
    // lead that has already been chased.
    attemptCount: 3,
    minutesAgo: 96,
    beat:
      "chased three times already - the attempt budget is spent, and giving up on her is a decision a person makes",
    lead: {
      source: "instagram",
      message:
        "Saw your reel. Bridal makeup for a 14 Feb wedding, budget around 25k. Still waiting to hear back from someone.",
      service: "bridal makeup",
      city: "Bengaluru",
      urgency: "ready",
      budgetSignal: "mid",
    },
  },
  {
    externalId: "cast-meera-kharadi",
    contactName: "Meera",
    timezone: "America/Los_Angeles",
    // Deliberately outside inboundReplyGraceMinutes. Inside it the reactive
    // exemption carries the reply straight past the window and the block this
    // lead exists to produce never happens.
    minutesAgo: 190,
    beat:
      "an NRI enquiry - 09:00-20:00 is read in HER timezone, where it is the middle of the night",
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
  {
    externalId: "cast-arjun-gst",
    contactName: "Arjun",
    timezone: "Asia/Kolkata",
    // Enquired, then sent STOP. Opt-out outranks every other check in
    // policy.ts, including an approval a human already gave, and there is no
    // override path in the code - which is only worth claiming if the demo
    // contains somebody who has actually opted out.
    optedOut: true,
    minutesAgo: 214,
    beat: "replied STOP after enquiring - opt-out outranks every other check, with no override",
    lead: {
      source: "google_ads",
      message: "GST filing ke liye monthly rates kya hain? Proprietorship firm hai.",
      service: "GST filing",
      city: "Pune",
      urgency: "comparing",
      budgetSignal: "low",
    },
  },
];

// ---------------------------------------------------------------- flags

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const int = (name: string, fallback: number, min: number): number => {
  const raw = flag(name, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} must be an integer >= ${min}, got "${raw}".`);
  }
  return n;
};

const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(70));
const pad2 = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------- main

type RunReport = {
  externalId: string;
  beat: string;
  origin: "agent" | "constructed";
  status: string;
  steps: number;
  actions: number;
  proposed: number;
  blocks: string[];
  seconds: number;
  tokens: number;
  note?: string;
};

async function main(): Promise<void> {
  const count = int("count", 36, CAST.length);
  const runBudget = int("runs", CAST.length, 0);
  const tpm = int("tpm", DEFAULT_TPM, 1);
  const masterSeed = flag("seed", "warden-v1");
  const targetSlug = flag("tenant-slug", "");
  const reset = has("reset");

  const now = new Date();

  const tenant = await resolveTenant(targetSlug);
  const policyAction = await syncPolicy(tenant);
  await syncUsers(tenant);
  const wiped = reset ? await resetTenant(tenant) : null;

  const policy = await db.policy.findUniqueOrThrow({ where: { tenantId: tenant.id } });

  const { created, updated, unchanged } = await syncCases({
    tenant,
    now,
    count,
    masterSeed,
  });

  const reports = await workTheCast({ tenant, runBudget, tpm });
  const toppedUp = await topUpApprovalQueue({ tenant, policy });

  await summarise({
    tenant,
    policy,
    now,
    masterSeed,
    wiped,
    policyAction,
    cases: { created, updated, unchanged },
    reports: [...reports, ...toppedUp],
    runBudget,
  });
}

// ---------------------------------------------------------------- tenant

async function resolveTenant(targetSlug: string): Promise<Tenant> {
  const slug = targetSlug || DEMO.slug;
  const existing = await db.tenant.findUnique({ where: { slug } });
  if (existing) return existing;

  // --tenant-slug means "put these cases in that tenant". Creating one on a
  // typo would silently seed a tenant nobody is looking at, so it fails.
  if (targetSlug) {
    throw new Error(
      `No tenant with slug "${targetSlug}". Run without --tenant-slug to create the demo tenant.`,
    );
  }
  return db.tenant.create({ data: { name: DEMO.name, slug: DEMO.slug } });
}

/**
 * The demo tenant runs on DEFAULT_POLICY itself, not on a copy of it.
 *
 * A demo workspace that behaves differently from a workspace someone creates
 * by signing in is a lie told to whoever is watching the demo, and two
 * hand-maintained copies of a policy diverge the first time one is edited.
 * Importing the constant makes that divergence impossible rather than
 * unlikely. See the note above DEFAULT_POLICY for why the auto-approve list
 * contains what it contains.
 */
async function syncPolicy(tenant: Tenant): Promise<"created" | "updated" | "already current"> {
  const existing = await db.policy.findUnique({ where: { tenantId: tenant.id } });
  if (!existing) {
    await db.policy.create({ data: { tenantId: tenant.id, ...DEFAULT_POLICY } });
    return "created";
  }
  if (!policyDiffers(existing, DEFAULT_POLICY)) return "already current";

  await db.policy.update({ where: { tenantId: tenant.id }, data: DEFAULT_POLICY });
  return "updated";
}

async function syncUsers(tenant: Tenant): Promise<void> {
  for (const [email, name, role] of [
    [DEMO.ownerEmail, "Demo Owner", "OWNER"],
    [DEMO.operatorEmail, "Demo Operator", "OPERATOR"],
  ] as const) {
    await db.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      create: { tenantId: tenant.id, email, name, role },
      update: { name, role },
    });
  }
}

type Wiped = { cases: number; audit: number };

/**
 * Everything this tenant has done, gone. Cases cascade to runs, steps, actions
 * and approvals, so the only thing that needs deleting by hand is the audit
 * log - and only the operational part of it. The `policy / provisioned` entry
 * is how this workspace came to have the guardrails it has, which is true
 * whether or not the cases under it survive.
 */
async function resetTenant(tenant: Tenant): Promise<Wiped> {
  const cases = await db.case.deleteMany({ where: { tenantId: tenant.id } });
  const audit = await db.auditEvent.deleteMany({
    where: { tenantId: tenant.id, entity: { in: ["run", "action", "case"] } },
  });
  return { cases: cases.count, audit: audit.count };
}

// ---------------------------------------------------------------- cases

type CaseFields = {
  subject: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  timezone: string;
  /** Plain object, not InputJsonValue, so an existing row's arrival can be merged in. */
  payload: Record<string, unknown>;
};

type Planned = CaseFields & {
  externalId: string;
  arrivedAt: Date;
  attemptCount: number;
  optedOut: boolean;
};

async function syncCases(input: {
  tenant: Tenant;
  now: Date;
  count: number;
  masterSeed: string;
}): Promise<{ created: number; updated: number; unchanged: number }> {
  const planned = planCases(input);

  const existing = await db.case.findMany({
    where: { tenantId: input.tenant.id, externalId: { in: planned.map((p) => p.externalId) } },
  });
  const byExternalId = new Map(existing.map((c) => [c.externalId, c]));

  const toCreate: Prisma.CaseCreateManyInput[] = [];
  let updated = 0;
  let unchanged = 0;

  for (const plan of planned) {
    const { externalId, arrivedAt, attemptCount, optedOut, ...fields } = plan;
    const current = byExternalId.get(externalId);

    if (!current) {
      toCreate.push({
        tenantId: input.tenant.id,
        externalId,
        ...fields,
        payload: fields.payload as Prisma.InputJsonValue,
        attemptCount,
        optedOut,
        // The enquiry landing IS the inbound message, so the reactive-reply
        // exemption has something real to fire on, and the inbox's "leads
        // today" and median-first-response figures have a real clock to read.
        lastInboundAt: arrivedAt,
        createdAt: arrivedAt,
      });
      continue;
    }

    // Timing, attemptCount, status and optedOut are left alone on an existing
    // row: they are either history or work the system did after seeding, and
    // a re-seed that rewrote them would move the ground under every action
    // already replayed against them.
    //
    // `payload.arrivedAt` is part of that timing even though it travels inside
    // a column that otherwise is refreshed. It is the clock every policy
    // verdict on this case was read against; recomputing it relative to a new
    // `now` would also make every re-run report every case as changed, which
    // is exactly the signal `pnpm replay` uses to tell corruption apart from an
    // edit somebody made on purpose.
    const desired: CaseFields = {
      ...fields,
      payload: { ...fields.payload, arrivedAt: arrivedAtOf(current.payload, arrivedAt) },
    };

    if (caseDiffers(current, desired)) {
      await db.case.update({
        where: { id: current.id },
        data: { ...desired, payload: desired.payload as Prisma.InputJsonValue },
      });
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  if (toCreate.length > 0) {
    await db.case.createMany({ data: toCreate, skipDuplicates: true });
  }

  return { created: toCreate.length, updated, unchanged };
}

/**
 * The cast arrives today; the rest is imported history.
 *
 * An SMB that switched this on this morning has a week of enquiries behind it
 * that nobody ran an agent over, and today's, which the agent worked. That is
 * both the honest reading of these rows and the one that makes the inbox
 * legible at a glance: everything with a run is from today, everything without
 * one predates the agent.
 */
function planCases(input: {
  tenant: Tenant;
  now: Date;
  count: number;
  masterSeed: string;
}): Planned[] {
  const { tenant, now, count, masterSeed } = input;
  const planned: Planned[] = [];

  const minutesAgo = compressIntoToday(
    CAST.map((c) => c.minutesAgo),
    now,
  );

  for (const [i, member] of CAST.entries()) {
    const arrivedAt = new Date(now.getTime() - minutesAgo[i] * 60_000);
    const lead: LeadPayload = { ...member.lead, arrivedAt: arrivedAt.toISOString() };
    planned.push({
      externalId: member.externalId,
      arrivedAt,
      attemptCount: member.attemptCount ?? 0,
      optedOut: member.optedOut ?? false,
      ...caseFields(member.externalId, member.contactName, member.timezone, lead, tenant),
    });
  }

  // Volume, from the project's own deterministic generator so the demo inbox
  // and the eval are reading the same idea of what an enquiry looks like.
  const fixtures = generateLeads(count - CAST.length, masterSeed);
  const rnd = rngFor(`${masterSeed}:history`);
  const dayStart = startOfDayIn(BUSINESS_TZ, now);

  for (const fixture of fixtures) {
    // The fixture's hour-of-day carries the real 18:00-21:00 enquiry peak, so
    // only the DAY is moved - dropping them all on one date would flatten the
    // one thing about the timing that is true.
    const daysBack = 1 + Math.floor(rnd() * 5);
    const ist = istClock(new Date(fixture.payload.arrivedAt));
    const arrivedAt = new Date(
      dayStart.getTime() - daysBack * 86_400_000 + (ist.hour * 60 + ist.minute) * 60_000,
    );
    const lead: LeadPayload = { ...fixture.payload, arrivedAt: arrivedAt.toISOString() };

    planned.push({
      externalId: fixture.externalId,
      arrivedAt,
      // Imported leads carry contact history no execution in this database
      // accounts for. replay.ts reconstructs the baseline by subtracting the
      // executions it can see, which is exactly this case.
      attemptCount: rnd() < 0.7 ? 0 : 1 + Math.floor(rnd() * 2),
      optedOut: false,
      ...caseFields(fixture.externalId, fixture.contactName, fixture.timezone, lead, tenant),
    });
  }

  return planned;
}

function caseFields(
  externalId: string,
  contactName: string,
  timezone: string,
  lead: LeadPayload,
  tenant: Tenant,
): CaseFields {
  return {
    subject: subjectFor(lead),
    contactName,
    // Reserved TLDs, not decoration: .invalid can never resolve, and the phone
    // numbers carry a leading zero in the subscriber block, which no Indian
    // mobile number does. A provider wired up by mistake during a demo has
    // nowhere to deliver.
    contactEmail: `${externalId}@leads.invalid`,
    contactPhone: `+91-00000-${String(hash(externalId) % 100_000).padStart(5, "0")}`,
    timezone,
    // businessName is not part of LeadPayloadSchema and is stripped by every
    // reader that parses it. It is here for one reader that does not: the
    // agent, which gets Case.payload verbatim in its opening message and
    // otherwise has no way to know whose business it is answering for - and
    // fills {{business_name}} with an invented company when it cannot.
    payload: { ...lead, businessName: tenant.name },
  };
}

/**
 * Keeps the cast inside today, in IST, however early the seed is run.
 *
 * "Leads today" is the first number on the inbox, and a seed run at 06:00 with
 * arrivals spread over four hours would push half the cast into yesterday and
 * quietly halve it. Scaling the offsets to the part of the day that has
 * actually happened keeps the spread proportional and the count honest.
 */
function compressIntoToday(offsets: readonly number[], now: Date): number[] {
  const elapsedMinutes = (now.getTime() - startOfDayIn(BUSINESS_TZ, now).getTime()) / 60_000;
  const room = elapsedMinutes - 2;
  const widest = Math.max(...offsets);
  if (widest <= room) return [...offsets];

  // Below an hour into the IST day there is nothing to compress into: squeezing
  // a four-hour spread into forty minutes would pull the NRI lead inside the
  // 30-minute reactive grace, and the contact-window block it exists to produce
  // would silently stop happening. A seed run at 00:30 has almost no "today"
  // and should say so rather than manufacture one.
  if (room < 60) return [...offsets];

  return offsets.map((m) => Math.max(1, Math.round((m * room) / widest)));
}

function subjectFor(lead: LeadPayload): string {
  const via = lead.source.replace(/_/g, " ");
  if (lead.service) return `${lead.service} enquiry via ${via}`;
  // Nothing was named, so the message itself is the only handle a human has on
  // this case. Better a scrappy subject than forty rows reading "New enquiry".
  const msg =
    lead.message.length > 56 ? `${lead.message.slice(0, 55).trimEnd()}...` : lead.message;
  return `"${msg}" via ${via}`;
}

// ---------------------------------------------------------------- real runs

/**
 * Turns the agent loose on the cast, one lead at a time.
 *
 * Sequential and paced on purpose. These are the traces the whole demo rests
 * on, and a 429 halfway through the cast leaves a half-worked inbox that is
 * worse than an empty one.
 */
async function workTheCast(input: {
  tenant: Tenant;
  runBudget: number;
  tpm: number;
}): Promise<RunReport[]> {
  const { tenant, runBudget, tpm } = input;
  if (runBudget === 0) return [];

  const cases = await db.case.findMany({
    where: { tenantId: tenant.id, externalId: { in: CAST.map((c) => c.externalId) } },
    include: { _count: { select: { runs: true } } },
  });
  const byExternalId = new Map(cases.map((c) => [c.externalId, c]));

  const pacer = tokenPacer(tpm);
  const reports: RunReport[] = [];
  let worked = 0;

  line();
  line(`Working the cast with the live model (${runBudget} max, paced to ${tpm} tok/min)`);
  rule();

  for (const member of CAST) {
    if (worked >= runBudget) break;

    const kase = byExternalId.get(member.externalId);
    if (!kase) continue;
    // Already worked by an earlier seed. Re-running would spend a model call
    // to produce a second trace nobody asked for, and would move this case's
    // `updatedAt` past the actions already recorded against it.
    if (kase._count.runs > 0) {
      line(`  ${member.externalId.padEnd(22)} skipped - already has a run`);
      continue;
    }

    worked += 1;
    await pacer.waitForHeadroom();

    const report = await workOne(tenant, kase, member.beat);
    pacer.spent(report.tokens);
    reports.push(report);

    line(
      `  ${member.externalId.padEnd(22)} ${report.status.padEnd(18)}` +
        ` ${String(report.steps).padStart(2)} steps` +
        ` ${String(report.actions).padStart(2)} actions` +
        ` ${String(report.proposed).padStart(2)} waiting` +
        ` ${report.seconds.toFixed(1).padStart(5)}s` +
        ` ${String(report.tokens).padStart(5)} tok` +
        (report.blocks.length ? `  blocked: ${report.blocks.join(", ")}` : ""),
    );
    if (report.note) line(`  ${" ".repeat(22)} ${report.note}`);
  }

  return reports;
}

async function workOne(tenant: Tenant, kase: Case, beat: string): Promise<RunReport> {
  const run = await db.agentRun.create({
    data: {
      tenantId: tenant.id,
      caseId: kase.id,
      arm: "AGENT",
      // Not random: the same case always produces the same run identity, which
      // is what lets a trace be talked about after the fact.
      seed: `seed:${kase.externalId ?? kase.id}`,
    },
  });

  const started = Date.now();
  let outcome = await advanceRun(run.id);
  let note: string | undefined;

  // The durable loop earns its keep here. A rate limit is not a failed
  // decision, it is a failed round trip, and every step already taken is
  // committed - so the run is put back in flight and picks up where it
  // stopped instead of spending the model on work it has already done.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (outcome.status !== "FAILED" || !RETRYABLE.test(outcome.error)) break;

    // A spent DAILY budget is not a transient outage and retrying into it only
    // burns the clock. Say so once, plainly, and stop - the message names the
    // one thing that actually helps.
    if (DAILY_LIMIT.test(outcome.error)) {
      line(`  ${" ".repeat(22)} ${dailyLimitAdvice(outcome.error)}`);
      break;
    }

    const waitMs = retryAfterMs(outcome.error, attempt);
    line(
      `  ${" ".repeat(22)} provider refused (${firstLine(outcome.error)})` +
        ` - resuming in ${Math.round(waitMs / 1000)}s`,
    );
    await sleep(waitMs);

    // advanceRun() refuses to touch a FAILED run, which is right for the API
    // and wrong for an operator retrying a transient outage. Clearing the
    // status is the retry; the committed steps are untouched, so the model
    // resumes from the history rather than redoing it.
    await db.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING", error: null } });
    outcome = await advanceRun(run.id);
    note =
      outcome.status === "FAILED"
        ? `resume failed: ${firstLine(outcome.error)}`
        : "resumed after a provider rate limit";
  }

  if (outcome.status === "FAILED") note = note ?? firstLine(outcome.error);

  return readBack({
    runId: run.id,
    externalId: kase.externalId ?? kase.id,
    beat,
    origin: "agent",
    seconds: (Date.now() - started) / 1000,
    note,
  });
}

async function readBack(input: {
  runId: string;
  externalId: string;
  beat: string;
  origin: "agent" | "constructed";
  seconds: number;
  note?: string;
}): Promise<RunReport> {
  const run = await db.agentRun.findUniqueOrThrow({
    where: { id: input.runId },
    include: { steps: { orderBy: { index: "asc" } }, actions: true },
  });

  const blocks = run.steps
    .filter((s) => s.kind === "POLICY_CHECK" && s.content?.startsWith("blocked: "))
    .map((s) => s.content!.slice("blocked: ".length));

  return {
    externalId: input.externalId,
    beat: input.beat,
    origin: input.origin,
    status: run.status,
    steps: run.steps.length,
    actions: run.actions.length,
    proposed: run.actions.filter((a) => a.status === "PROPOSED").length,
    blocks,
    seconds: input.seconds,
    tokens: run.steps.reduce((a, s) => a + (s.promptTokens ?? 0) + (s.outputTokens ?? 0), 0),
    note: input.note,
  };
}

/**
 * A sliding minute of token spend, measured from the committed RunStep rows
 * rather than estimated, so the wait is as short as it can honestly be.
 */
function tokenPacer(limitPerMinute: number) {
  const window: Array<{ at: number; tokens: number }> = [];
  const observed: number[] = [];
  // Measured over this cast: a run costs 1.5k-6k tokens and averages around
  // 3.5k. Reserving the worst case would idle a full minute after every run
  // and turn an eight-lead seed into eight minutes; reserving the running mean
  // keeps two runs a minute moving and leaves the retry in workOne() to cover
  // the occasional run that comes in long.
  const reserve = (): number => {
    if (observed.length === 0) return 3_500;
    const mean = observed.reduce((a, b) => a + b, 0) / observed.length;
    return Math.min(limitPerMinute, Math.max(2_500, Math.round(mean * 1.15)));
  };

  const usedInLastMinute = (): number => {
    const cutoff = Date.now() - 60_000;
    while (window.length > 0 && window[0].at < cutoff) window.shift();
    return window.reduce((a, w) => a + w.tokens, 0);
  };

  return {
    spent(tokens: number): void {
      if (tokens <= 0) return;
      window.push({ at: Date.now(), tokens });
      observed.push(tokens);
    },
    async waitForHeadroom(): Promise<void> {
      while (window.length > 0 && usedInLastMinute() + reserve() > limitPerMinute) {
        const waitMs = Math.max(1_000, window[0].at + 60_000 - Date.now() + 500);
        await sleep(waitMs);
      }
    },
  };
}

// ---------------------------------------------------------------- top-up

/**
 * The queue must not be empty, and the agent does not take instructions.
 *
 * /approvals is the screen this product's entire claim rests on, so two
 * proposals waiting on a human is a hard requirement of the demo state - but
 * what the agent proposes is the agent's decision, and on a given afternoon it
 * may answer every lead from a template and park nothing. When that happens
 * this builds the missing rows by hand, from the same callback the lead asked
 * for in writing, and says so in the summary. The verdict on a constructed row
 * is produced by calling evaluatePolicy() for real, and the idempotency key by
 * calling idempotencyKey() for real, so `pnpm replay` verifies these exactly as
 * strictly as it verifies a row the runtime wrote. What it does NOT carry is a
 * MODEL_CALL step: no model was asked, so no model call is claimed.
 */
async function topUpApprovalQueue(input: {
  tenant: Tenant;
  policy: Policy;
}): Promise<RunReport[]> {
  const { tenant, policy } = input;

  const depth = await db.proposedAction.count({
    where: { tenantId: tenant.id, status: "PROPOSED", run: { tenantId: tenant.id } },
  });
  const shortfall = 2 - depth;
  if (shortfall <= 0) return [];

  // The two leads that asked for a call in so many words. Constructing a
  // callback for anyone else would be putting a promise in the agent's mouth.
  const candidates = ["cast-rohit-neet", "cast-sneha-rootcanal"];
  const built: RunReport[] = [];

  for (const externalId of candidates) {
    if (built.length >= shortfall) break;

    const kase = await db.case.findUnique({
      where: { tenantId_externalId: { tenantId: tenant.id, externalId } },
    });
    if (!kase) continue;
    const parked = await db.proposedAction.count({
      where: { tenantId: tenant.id, status: "PROPOSED", run: { caseId: kase.id } },
    });
    if (parked > 0) continue;

    const report = await constructParkedCallback(tenant, policy, kase);
    if (report) built.push(report);
  }

  return built;
}

async function constructParkedCallback(
  tenant: Tenant,
  policy: Policy,
  kase: Case,
): Promise<RunReport | null> {
  const proposedAt = new Date();
  const proposal: Proposal = {
    type: "schedule_callback",
    args: {
      at: nextMorningIn(kase.timezone, proposedAt),
      phone: kase.contactPhone ?? "",
      topic: kase.subject,
    },
    reason: `${kase.contactName ?? "This lead"} asked to be called rather than messaged, so a person has to commit to the time.`,
    valuePaise: 0,
  };

  const verdict = evaluatePolicy({
    proposal,
    policy,
    kase,
    actionsThisRun: 0,
    now: proposedAt,
  });
  // The gate is the point. If policy would wave this through there is nothing
  // to put in the queue, and silently inserting a PROPOSED row anyway would be
  // the seed lying about what the engine decided.
  if (!verdict.allowed || !verdict.requiresApproval) return null;

  const key = idempotencyKey({
    tenantId: tenant.id,
    caseId: kase.id,
    type: proposal.type,
    args: proposal.args,
    attempt: kase.attemptCount,
  });
  if (await db.proposedAction.findUnique({ where: { idempotencyKey: key } })) return null;

  const run = await db.agentRun.create({
    data: {
      tenantId: tenant.id,
      caseId: kase.id,
      arm: "AGENT",
      seed: `seed:constructed:${kase.externalId ?? kase.id}`,
      startedAt: proposedAt,
    },
  });

  const action = await db.proposedAction.create({
    data: {
      runId: run.id,
      tenantId: tenant.id,
      type: proposal.type,
      args: proposal.args as Prisma.InputJsonValue,
      reason: proposal.reason,
      valuePaise: proposal.valuePaise,
      idempotencyKey: key,
      status: "PROPOSED",
      autoApproved: false,
      policyVerdict: { checks: verdict.checks } as Prisma.InputJsonValue,
      proposedAt,
    },
  });

  // The same step shapes runtime.ts writes, minus MODEL_CALL - see the note on
  // topUpApprovalQueue for why that omission is the honest part.
  const steps: Array<Prisma.RunStepCreateManyInput> = [
    {
      runId: run.id,
      index: 0,
      kind: "TOOL_CALL",
      toolName: "propose_action",
      toolArgs: proposal as unknown as Prisma.InputJsonValue,
      createdAt: proposedAt,
    },
    {
      runId: run.id,
      index: 1,
      kind: "POLICY_CHECK",
      content: "allowed",
      detail: { checks: verdict.checks } as Prisma.InputJsonValue,
      createdAt: proposedAt,
    },
    {
      runId: run.id,
      index: 2,
      kind: "ACTION_PROPOSED",
      content: `${proposal.type}: ${proposal.reason}`,
      detail: { actionId: action.id, requiresApproval: true, constructed: true },
      createdAt: proposedAt,
    },
    {
      runId: run.id,
      index: 3,
      kind: "AWAIT_APPROVAL",
      content: `Waiting on a human for ${proposal.type}.`,
      detail: { actionId: action.id },
      createdAt: proposedAt,
    },
  ];
  await db.runStep.createMany({ data: steps });

  await db.agentRun.update({
    where: { id: run.id },
    data: { status: "AWAITING_APPROVAL", awaitingActionId: action.id, stepCount: steps.length },
  });

  await record({
    tenantId: tenant.id,
    entity: "action",
    entityId: action.id,
    event: "proposed",
    actor: "system",
    data: { type: proposal.type, autoApproved: false, constructed: true, by: "scripts/seed.ts" },
  });

  return {
    externalId: kase.externalId ?? kase.id,
    beat: "constructed so the approval queue is never empty",
    origin: "constructed",
    status: "AWAITING_APPROVAL",
    steps: steps.length,
    actions: 1,
    proposed: 1,
    blocks: [],
    seconds: 0,
    tokens: 0,
    note: "built by the seed, not by the model - no MODEL_CALL step, audit says constructed",
  };
}

/**
 * 10:00 tomorrow in the recipient's own timezone, as an ISO instant.
 *
 * On the minute, because this string is what an operator reads on the approval
 * card before committing somebody to make the call - and "10:00:33" reads as a
 * machine's rounding error rather than a time a person chose.
 */
function nextMorningIn(timeZone: string, from: Date): string {
  const local = istLikeClock(timeZone, from);
  const minutesToMidnight = (24 - local.hour) * 60 - local.minute;
  const at = new Date(from.getTime() + (minutesToMidnight + 10 * 60) * 60_000);
  at.setUTCSeconds(0, 0);
  return at.toISOString();
}

// ---------------------------------------------------------------- summary

async function summarise(input: {
  tenant: Tenant;
  policy: Policy;
  now: Date;
  masterSeed: string;
  wiped: Wiped | null;
  policyAction: string;
  cases: { created: number; updated: number; unchanged: number };
  reports: RunReport[];
  runBudget: number;
}): Promise<void> {
  const { tenant, policy, now, reports } = input;

  const dayStart = startOfDayIn(BUSINESS_TZ, now);
  const [cases, leadsToday, queueDepth, blocked, runsByStatus, contacted] = await Promise.all([
    db.case.findMany({ where: { tenantId: tenant.id }, select: { payload: true } }),
    db.case.count({ where: { tenantId: tenant.id, createdAt: { gte: dayStart } } }),
    db.proposedAction.count({
      where: { tenantId: tenant.id, status: "PROPOSED", run: { tenantId: tenant.id } },
    }),
    db.auditEvent.count({ where: { tenantId: tenant.id, event: "action_blocked" } }),
    db.agentRun.groupBy({ by: ["status"], where: { tenantId: tenant.id }, _count: true }),
    db.proposedAction.count({
      where: { tenantId: tenant.id, status: "EXECUTED", type: "send_templated_reply" },
    }),
  ]);
  const median = await medianFirstResponseSeconds(tenant.id);

  const tiers = { hot: 0, warm: 0, cold: 0 };
  for (const row of cases) {
    const lead = row.payload as unknown as LeadPayload;
    if (lead?.urgency) tiers[scoreLead(lead).tier] += 1;
  }

  line();
  line(`Warden seed - "${tenant.name}" (${tenant.slug})`);
  line(`${cases.length} leads from seed "${input.masterSeed}"`);
  rule();
  if (input.wiped) {
    line(`  reset    ${input.wiped.cases} cases and ${input.wiped.audit} audit rows deleted`);
  }
  line(`  policy   ${input.policyAction} - shared with src/lib/auth/session.ts`);
  line(`  users    ${DEMO.ownerEmail} OWNER, ${DEMO.operatorEmail} OPERATOR`);
  line(
    `  cases    ${input.cases.created} created, ${input.cases.updated} updated,` +
      ` ${input.cases.unchanged} already current`,
  );
  rule();

  line("The gate");
  line(
    `  auto-approved       ${policy.autoApproveActions.join(", ")} - these reach nobody outside our database`,
  );
  line(
    `  waits for a person  ${policy.allowedActions
      .filter((a) => !policy.autoApproveActions.includes(a))
      .filter((a) => a !== "send_templated_reply")
      .join(", ")}`,
  );
  line("  send_templated_reply  goes without asking, because a human signed the wording itself");
  line(`  not allowed at all    place_call - outbound telephony needs DLT registration we do not hold`);
  rule();

  line("Policy in force");
  line(
    `  contact window      ${pad2(policy.contactWindowStartHour)}:00-${pad2(policy.contactWindowEndHour)}:00` +
      ` in the RECIPIENT's timezone, weekends ${policy.contactOnWeekends ? "on" : "off"}`,
  );
  line(
    `  reactive grace      ${policy.inboundReplyGraceMinutes} min - a reply inside this is exempt from the window`,
  );
  line(`  attempts per case   ${policy.maxAttemptsPerCase}`);
  line(`  approved templates  ${policy.approvedTemplates.length}: ${policy.approvedTemplates.join(", ")}`);
  rule();

  line("Lead mix");
  line(`  hot ${tiers.hot}   warm ${tiers.warm}   cold ${tiers.cold}`);
  line(`  ${leadsToday} arrived today (since 00:00 IST); the rest is imported history`);
  rule();

  if (reports.length > 0) {
    const real = reports.filter((r) => r.origin === "agent");
    const made = reports.filter((r) => r.origin === "constructed");

    line("Traces");
    for (const r of reports) {
      const mark = r.origin === "agent" ? "agent" : "SEED ";
      line(`  [${mark}] ${r.externalId.padEnd(22)} ${r.status}`);
      line(`          ${r.beat}`);
      if (r.blocks.length > 0) line(`          policy blocked: ${r.blocks.join(", ")}`);
      if (r.note) line(`          ${r.note}`);
    }
    line();
    line(
      `  ${real.length} produced by the live model against the real policy engine,` +
        ` ${made.length} constructed by this script.`,
    );
    if (made.length > 0) {
      line("  Constructed rows carry constructed:true in the audit log and no MODEL_CALL step.");
    }
    rule();
  } else if (input.runBudget === 0) {
    line("Traces");
    line("  --runs 0: the model was not called. No runs were produced or constructed.");
    rule();
  } else {
    line("Traces");
    line("  Every cast lead already has a run, so nothing was re-run and no model call was");
    line("  spent. Use --reset to rebuild this workspace's history from scratch.");
    rule();
  }

  line("Run states");
  for (const g of runsByStatus.sort((a, b) => b._count - a._count)) {
    line(`  ${g.status.padEnd(20)} ${String(g._count).padStart(4)}`);
  }
  rule();

  line("What a judge lands on");
  line(`  APPROVAL QUEUE DEPTH: ${queueDepth}`);
  line(`  actions policy refused      ${blocked}  (audit events - a refused action never becomes a row)`);
  line(`  templated replies delivered ${contacted}`);
  line(
    `  median first reply          ${median === null ? "-" : `${median}s (${(median / 60).toFixed(1)} min)`}` +
      "  from their message to ours",
  );
  if (queueDepth === 0) {
    line();
    line("  WARNING: /approvals will render its empty state. Re-run with --reset.");
  }
  line();

  // One end-to-end proof that the wording a judge will see actually renders,
  // rather than trusting that it would.
  const sample = renderTemplate("first_reply_v1", {
    name: "Asha",
    service: "IELTS coaching",
    business_name: tenant.name,
  });
  line(sample.ok ? `first_reply_v1 renders: "${sample.text}"` : `first_reply_v1 FAILED: ${sample.error}`);
  line();
}

/** Mirrors the inbox's figure exactly, so the seed cannot report a different one. */
async function medianFirstResponseSeconds(tenantId: string): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ median: number | null }>>`
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
        AND pa.type = ANY(ARRAY['send_templated_reply','send_email','send_sms','place_call'])
    ) x ON TRUE
    WHERE c.tenant_id = ${tenantId}
      AND c.last_inbound_at IS NOT NULL
      AND x.first_contact IS NOT NULL
      AND x.first_contact >= c.last_inbound_at
  `;
  const median = rows[0]?.median;
  return median === null || median === undefined ? null : Math.round(Number(median));
}

// ---------------------------------------------------------------- helpers

type DesiredPolicy = Omit<Policy, "id" | "tenantId" | "createdAt" | "updatedAt">;

function policyDiffers(current: Policy, desired: Partial<DesiredPolicy>): boolean {
  return (Object.keys(desired) as Array<keyof DesiredPolicy>).some((key) => {
    const a: unknown = current[key];
    const b: unknown = desired[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      return [...a].sort().join(" ") !== [...b].sort().join(" ");
    }
    return a !== b;
  });
}

/** The arrival already on the row, or the planned one if it never had a usable one. */
function arrivedAtOf(payload: unknown, fallback: Date): string {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const stored = (payload as { arrivedAt?: unknown }).arrivedAt;
    if (typeof stored === "string" && !Number.isNaN(Date.parse(stored))) return stored;
  }
  return fallback.toISOString();
}

function caseDiffers(current: Record<string, unknown>, fields: Record<string, unknown>): boolean {
  return Object.entries(fields).some(([key, want]) => {
    const have = current[key];
    if (want instanceof Date) return !(have instanceof Date) || have.getTime() !== want.getTime();
    // Postgres jsonb does not preserve key order, so the payload has to be
    // compared canonically or every re-run would look like a change.
    if (want !== null && typeof want === "object") return stableJson(have) !== stableJson(want);
    return have !== want;
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Midnight today in the given zone, expressed as a real instant. */
function startOfDayIn(timeZone: string, at: Date): Date {
  const { hour, minute, second } = istLikeClock(timeZone, at);
  return new Date(at.getTime() - ((hour * 3600 + minute * 60 + second) * 1000));
}

function istLikeClock(
  timeZone: string,
  at: Date,
): { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // hour12:false yields "24" for midnight in some runtimes.
  return { hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

function istClock(at: Date): { hour: number; minute: number } {
  return istLikeClock(BUSINESS_TZ, at);
}

/** Stable across machines, so the same externalId always gets the same number. */
function hash(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function firstLine(message: string): string {
  const one = message.split("\n")[0]?.trim() ?? message;
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((err: unknown) => {
    console.error(`\nseed failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
