/**
 * pnpm replay [--tenant demo]
 *
 * The claims verifier.
 *
 * Every ProposedAction row carries the policy verdict that was in force when it
 * was written. This walks all of them, calls evaluatePolicy() again from stored
 * state, and reports anything that no longer comes out the same. That is what
 * turns the audit log from a list of things we say happened into something a
 * disputed action can be answered with months later - and it is the difference
 * between "we log everything" and "our logs are checkable".
 *
 * Exits non-zero on any divergence, so it can gate CI. Exit 1 means the log does
 * not reproduce; exit 3 means it cannot be checked because the rows it was
 * derived from were edited afterwards. See `exitCodeFor`.
 *
 * THE SUBTLE PART: policy verdicts are time-dependent. The contact window reads
 * the recipient's local clock and the reactive-reply exemption reads minutes
 * since their last message, so replaying a 3am decision against *now* would
 * report a divergence for every overnight action in the database and the tool
 * would be worthless. Each action is therefore replayed with its own
 * `proposedAt` as the clock, which evaluatePolicy() accepts as `now`.
 */
import "dotenv/config";

import { idempotencyKey } from "@/lib/agent/idempotency";
import { evaluatePolicy } from "@/lib/agent/policy";
import { CONTACT_ACTIONS, type ActionType, type CheckResult, type Proposal } from "@/lib/agent/types";
import { db } from "@/lib/db";

import type { Case, Policy } from "@/generated/prisma/client";

/**
 * The rule that wrote Case.attemptCount, imported rather than restated.
 *
 * It used to be a literal here, because runtime.ts (which increments the
 * counter) and policy.ts (which reads it) disagreed about send_templated_reply
 * and this script had to copy the writer. They now share one set, so this
 * imports it: a local copy would be a third definition free to drift again,
 * and a replay that reconstructs the counter by the wrong rule reports
 * divergences that are its own fault.
 */
const ATTEMPT_INCREMENTING: ReadonlySet<string> = CONTACT_ACTIONS;

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(66));
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
const short = (id: string) => id.slice(0, 8);

type Verdict = {
  allowed: boolean;
  blockedBy: string | null;
  requiresApproval: boolean;
};

type Divergence = {
  action: ActionRow;
  recorded: Verdict;
  replayed: Verdict;
  detail: string | null;
  cause: string | null;
};

type KeyMismatch = {
  action: ActionRow;
  rederived: string;
  attempt: number;
};

type Unverifiable = { action: ActionRow; why: string };

async function loadActions(tenantId: string | null) {
  return db.proposedAction.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { proposedAt: "asc" },
    include: {
      run: { select: { id: true, caseId: true } },
      approval: { select: { id: true, decision: true } },
    },
  });
}
type ActionRow = Awaited<ReturnType<typeof loadActions>>[number];

async function main(): Promise<void> {
  const slug = flag("tenant", "");
  let tenantId: string | null = null;
  if (slug) {
    const tenant = await db.tenant.findUnique({ where: { slug } });
    if (!tenant) throw new Error(`No tenant with slug "${slug}".`);
    tenantId = tenant.id;
  }

  const actions = await loadActions(tenantId);
  if (actions.length === 0) {
    line();
    line("Warden replay - no proposed actions in the database. Nothing to verify.");
    line();
    return;
  }

  const policies = new Map<string, Policy>(
    (
      await db.policy.findMany({
        where: { tenantId: { in: [...new Set(actions.map((a) => a.tenantId))] } },
      })
    ).map((p) => [p.tenantId, p]),
  );
  const cases = new Map<string, Case>(
    (
      await db.case.findMany({
        where: { id: { in: [...new Set(actions.map((a) => a.run.caseId))] } },
      })
    ).map((c) => [c.id, c]),
  );

  // Attempt history per case. Case.attemptCount is a live counter that has
  // moved since these actions were proposed, so the value in force at each
  // proposal has to be rebuilt from the executions that preceded it.
  const executionsByCase = new Map<string, ActionRow[]>();
  for (const a of actions) {
    if (a.status !== "EXECUTED" || !a.executedAt || !ATTEMPT_INCREMENTING.has(a.type)) continue;
    const list = executionsByCase.get(a.run.caseId) ?? [];
    list.push(a);
    executionsByCase.set(a.run.caseId, list);
  }
  const executionsByRun = new Map<string, ActionRow[]>();
  for (const a of actions) {
    if (!a.executedAt) continue;
    const list = executionsByRun.get(a.runId) ?? [];
    list.push(a);
    executionsByRun.set(a.runId, list);
  }

  const divergences: Divergence[] = [];
  const keyMismatches: KeyMismatch[] = [];
  const unverifiable: Unverifiable[] = [];
  const unapproved: ActionRow[] = [];
  let reproduced = 0;

  for (const action of actions) {
    const policy = policies.get(action.tenantId);
    const kase = cases.get(action.run.caseId);
    if (!policy) {
      unverifiable.push({ action, why: "its tenant has no policy row - nothing to replay against" });
      continue;
    }
    if (!kase) {
      unverifiable.push({ action, why: "its case row is gone" });
      continue;
    }

    const proposalArgs = plainObject(action.args);
    if (!proposalArgs) {
      unverifiable.push({ action, why: "its stored args are not a JSON object" });
      continue;
    }
    const recorded = recordedVerdict(action);
    if (!recorded) {
      unverifiable.push({ action, why: "no policy verdict was recorded on the row" });
      continue;
    }

    // An executed action that needed a human and has no approval row attached
    // is the worst thing this tool can find, so it is checked whether or not
    // the verdict reproduces.
    if (action.status === "EXECUTED" && !action.autoApproved && !action.approval) {
      unapproved.push(action);
    }

    const attempt = attemptCountAt(kase, executionsByCase.get(kase.id) ?? [], action.proposedAt);
    const actionsThisRun = (executionsByRun.get(action.runId) ?? []).filter(
      (a) => a.executedAt !== null && a.executedAt < action.proposedAt,
    ).length;

    const proposal: Proposal = {
      // Replayed verbatim. A type the vocabulary no longer contains is not a
      // special case here: policy fails it on the allow-list check, which is
      // exactly what it would have done then.
      type: action.type as ActionType,
      args: proposalArgs,
      reason: action.reason,
      valuePaise: action.valuePaise,
    };

    const verdict = evaluatePolicy({
      proposal,
      policy,
      kase: { ...kase, attemptCount: attempt },
      actionsThisRun,
      // The whole point. See the note at the top of this file.
      now: action.proposedAt,
    });

    const replayed: Verdict = verdict.allowed
      ? { allowed: true, blockedBy: null, requiresApproval: verdict.requiresApproval }
      : { allowed: false, blockedBy: verdict.blockedBy, requiresApproval: false };

    if (sameVerdict(recorded, replayed)) {
      reproduced += 1;
    } else {
      divergences.push({
        action,
        recorded,
        replayed,
        detail: verdict.checks.find((c) => !c.passed)?.detail ?? null,
        cause: attributeTo(action.proposedAt, policy, kase),
      });
    }

    const rederived = idempotencyKey({
      tenantId: action.tenantId,
      caseId: action.run.caseId,
      type: action.type,
      args: proposalArgs,
      attempt,
    });
    if (rederived !== action.idempotencyKey) {
      keyMismatches.push({ action, rederived, attempt });
    }
  }

  report({
    actions,
    cases,
    tenants: new Set(actions.map((a) => a.tenantId)).size,
    reproduced,
    divergences,
    keyMismatches,
    unverifiable,
    unapproved,
    slug,
  });

  process.exitCode = exitCodeFor({ divergences, keyMismatches, unverifiable, unapproved });
}

/**
 * 0 clean, 1 the log does not reproduce, 3 nothing reproduces *because* the
 * rows it was derived from were edited afterwards.
 *
 * The third code exists because both of the other two are wrong for that case.
 * Passing would claim a verdict was verified when it was not. Exiting 1 is what
 * happened before, and it means somebody editing a contact window an hour
 * before a demo sees the claims verifier go red with nothing actually broken -
 * which is the fastest way to teach a room to ignore it. A separate code says
 * "this did not reproduce, and here is the innocent reason" without either
 * lying or crying wolf. CI still gates on 0.
 */
function exitCodeFor(r: {
  divergences: Divergence[];
  keyMismatches: unknown[];
  unverifiable: unknown[];
  unapproved: unknown[];
}): number {
  const hard = r.keyMismatches.length + r.unapproved.length + r.unverifiable.length;
  const unexplained = r.divergences.filter((d) => d.cause === null).length;

  if (hard === 0 && r.divergences.length === 0) return 0;
  if (hard === 0 && unexplained === 0) return 3;
  return 1;
}

// ---------------------------------------------------------------- rebuilding

/**
 * Case.attemptCount as it stood at `at`.
 *
 * The baseline is derived rather than assumed to be zero: a case seeded or
 * imported with prior contact history carries a counter that no execution in
 * this database accounts for, and subtracting the executions we can see is the
 * only way to recover what it started from.
 */
function attemptCountAt(kase: Case, executions: ActionRow[], at: Date): number {
  const baseline = Math.max(0, kase.attemptCount - executions.length);
  const before = executions.filter((a) => a.executedAt !== null && a.executedAt < at).length;
  return baseline + before;
}

/**
 * The verdict as it was written down.
 *
 * runtime.ts persists `{ checks }` and nothing else, so `allowed` and
 * `blockedBy` are recovered from the checks themselves - policy.ts blocks on
 * the first failing check and names the verdict after it. Explicit fields are
 * preferred when a writer supplies them, so this keeps working if the stored
 * shape ever gets richer.
 */
function recordedVerdict(action: ActionRow): Verdict | null {
  const raw = action.policyVerdict;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const checks: CheckResult[] = Array.isArray(obj.checks) ? (obj.checks as CheckResult[]) : [];

  const explicit = typeof obj.allowed === "boolean" ? obj.allowed : null;
  if (explicit === null && checks.length === 0) return null;

  const failed = checks.find((c) => c && c.passed === false);
  const allowed = explicit ?? !failed;
  if (!allowed) {
    return {
      allowed: false,
      blockedBy: typeof obj.blockedBy === "string" ? obj.blockedBy : (failed?.name ?? null),
      requiresApproval: false,
    };
  }
  return {
    allowed: true,
    blockedBy: null,
    // `autoApproved` is the column the runtime wrote from the same verdict, so
    // it is the authoritative record of whether a human was required.
    requiresApproval:
      typeof obj.requiresApproval === "boolean" ? obj.requiresApproval : !action.autoApproved,
  };
}

function sameVerdict(a: Verdict, b: Verdict): boolean {
  if (a.allowed !== b.allowed) return false;
  return a.allowed ? a.requiresApproval === b.requiresApproval : a.blockedBy === b.blockedBy;
}

/**
 * Warden versions neither Policy nor Case rows, so a divergence on an action
 * whose policy or case was edited afterwards is explained rather than proven
 * wrong. Saying which is which is the difference between a report someone acts
 * on and one they learn to ignore - but both still fail the run, because an
 * unverifiable claim is not a verified one.
 */
function attributeTo(proposedAt: Date, policy: Policy, kase: Case): string | null {
  const edits: string[] = [];
  if (policy.updatedAt > proposedAt) edits.push(`tenant policy edited ${iso(policy.updatedAt)}`);
  if (kase.updatedAt > proposedAt) edits.push(`case edited ${iso(kase.updatedAt)}`);
  return edits.length > 0 ? `${edits.join(", ")} - after this action was proposed` : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------- reporting

function describe(v: Verdict): string {
  if (!v.allowed) return `blocked by ${v.blockedBy ?? "an unnamed check"}`;
  return v.requiresApproval ? "allowed, needed a human" : "allowed, no approval needed";
}

function caseLabel(action: ActionRow, cases: Map<string, Case>): string {
  const kase = cases.get(action.run.caseId);
  if (!kase) return action.run.caseId;
  return `${kase.externalId ?? short(kase.id)} "${kase.subject}"`;
}

function report(r: {
  actions: ActionRow[];
  cases: Map<string, Case>;
  tenants: number;
  reproduced: number;
  divergences: Divergence[];
  keyMismatches: KeyMismatch[];
  unverifiable: Unverifiable[];
  unapproved: ActionRow[];
  slug: string;
}): void {
  const scope = r.slug ? `tenant "${r.slug}"` : `${r.tenants} tenant${r.tenants === 1 ? "" : "s"}`;
  const stat = (label: string, n: number) => line(`  ${label.padEnd(26)} ${String(n).padStart(5)}`);

  line();
  line(`Warden replay - ${r.actions.length} proposed actions across ${scope}`);
  line("Each verdict was re-derived by calling evaluatePolicy() again with the");
  line("action's own proposedAt as the clock, never the current time.");
  rule();
  stat("actions replayed", r.actions.length);
  stat("verdicts reproduced", r.reproduced);
  stat("verdicts diverged", r.divergences.length);
  stat("idempotency mismatches", r.keyMismatches.length);
  stat("executed without approval", r.unapproved.length);
  stat("could not be replayed", r.unverifiable.length);
  rule();

  if (r.divergences.length > 0) {
    // Unexplained first: those are the ones that mean the log is wrong rather
    // than merely stale.
    const ordered = [...r.divergences].sort(
      (a, b) => Number(a.cause !== null) - Number(b.cause !== null),
    );
    line("Verdicts that no longer reproduce");
    ordered.forEach((d, i) => {
      line(`  [${i + 1}] ${short(d.action.id)}  ${d.action.type}  ${d.action.status}`);
      line(`      case      ${caseLabel(d.action, r.cases)}`);
      line(`      proposed  ${iso(d.action.proposedAt)}`);
      line(`      recorded  ${describe(d.recorded)}`);
      line(`      replayed  ${describe(d.replayed)}`);
      if (d.detail) line(`                ${d.detail}`);
      line(
        d.cause
          ? `      cause     ${d.cause}`
          : "      cause     UNEXPLAINED - neither the policy nor the case has changed since.",
      );
    });
    rule();
  }

  if (r.keyMismatches.length > 0) {
    line("Idempotency keys that no longer re-derive");
    line("  (tenantId, caseId, type, args, attempt) no longer hashes to the stored key,");
    line("  so the duplicate-suppression guarantee does not hold for these rows.");
    r.keyMismatches.forEach((m, i) => {
      line(`  [${i + 1}] ${short(m.action.id)}  ${m.action.type}`);
      line(`      stored      ${m.action.idempotencyKey}`);
      line(`      re-derived  ${m.rederived}`);
      line(`      inputs      case=${short(m.action.run.caseId)} attempt=${m.attempt}`);
    });
    rule();
  }

  if (r.unapproved.length > 0) {
    line("Executed without a recorded approval");
    line("  These were not auto-approved and carry no Approval row. Either a human");
    line("  signed them somewhere that was never written down, or nobody did.");
    r.unapproved.forEach((a, i) => {
      line(
        `  [${i + 1}] ${short(a.id)}  ${a.type}  executed ${a.executedAt ? iso(a.executedAt) : "?"}`,
      );
    });
    rule();
  }

  if (r.unverifiable.length > 0) {
    line("Could not be replayed");
    r.unverifiable.forEach((u, i) => {
      line(`  [${i + 1}] ${short(u.action.id)}  ${u.action.type}  - ${u.why}`);
    });
    rule();
  }

  const failures =
    r.divergences.length + r.keyMismatches.length + r.unapproved.length + r.unverifiable.length;
  if (failures === 0) {
    line(`PASS - all ${r.reproduced} recorded verdicts reproduce from stored state.`);
  } else {
    const unexplained = r.divergences.filter((d) => d.cause === null).length;
    const hard = r.keyMismatches.length + r.unapproved.length + r.unverifiable.length;
    // Named differently because they are different findings. "the log is wrong"
    // and "the log cannot be checked because its inputs moved" both need acting
    // on, and only the first one means the guardrails did not do what we say.
    line(
      hard === 0 && unexplained === 0
        ? `UNVERIFIED - ${r.divergences.length} divergence${r.divergences.length === 1 ? "" : "s"},` +
            " every one attributable to an edit made after the fact. Nothing" +
            " contradicts the log; nothing confirms it either."
        : `FAIL - ${r.divergences.length} divergence${r.divergences.length === 1 ? "" : "s"}` +
            ` (${unexplained} unexplained), ${r.keyMismatches.length} key mismatch${r.keyMismatches.length === 1 ? "" : "es"},` +
            ` ${r.unapproved.length} unapproved execution${r.unapproved.length === 1 ? "" : "s"},` +
            ` ${r.unverifiable.length} unreplayable.`,
    );
  }
  line();
}

main()
  .catch((err: unknown) => {
    console.error(`\nreplay failed: ${err instanceof Error ? err.message : String(err)}\n`);
    // Distinct from 1: the tool could not run at all, which is not the same
    // finding as "the log does not reproduce".
    process.exitCode = 2;
  })
  .finally(() => db.$disconnect());
