import type { Case, Policy } from "@/generated/prisma/client";
import {
  CONTACT_ACTIONS,
  IRREVERSIBLE_ACTIONS,
  TEMPLATED_ACTION,
  TEMPLATE_VARIABLE_ALLOWLIST,
  type ActionType,
  type CheckResult,
  type PolicyVerdict,
  type Proposal,
} from "./types";

/**
 * The guardrail engine.
 *
 * Everything here is evaluated against database rows, after the model has
 * spoken and before anything happens. The model has no input into this file
 * and cannot argue with it: a prompt injection that convinces the agent to
 * call an customer at 3am still gets stopped, because the window check reads
 * the clock rather than the conversation.
 *
 * Every check fails closed. If we cannot prove an action is permitted, it is
 * not permitted.
 */
export function evaluatePolicy(args: {
  proposal: Proposal;
  policy: Policy;
  kase: Case;
  actionsThisRun: number;
  now?: Date;
}): PolicyVerdict {
  const { proposal, policy, kase, actionsThisRun } = args;
  const now = args.now ?? new Date();
  const checks: CheckResult[] = [];

  const block = (name: string, detail: string): PolicyVerdict => {
    checks.push({ name, passed: false, detail });
    return { allowed: false, requiresApproval: false, blockedBy: name, checks };
  };
  const pass = (name: string, detail?: string) => {
    checks.push({ name, passed: true, detail });
  };

  // 1. Opt-out is absolute and outranks everything else, including an approval
  //    a human already gave. There is no override path in the code.
  if (kase.optedOut && isContactAction(proposal.type)) {
    return block("opt_out", "Contact permanently withdrawn by this recipient.");
  }
  pass("opt_out");

  // 2. Action must be on the tenant's allow-list.
  if (!policy.allowedActions.includes(proposal.type)) {
    return block(
      "action_allowed",
      `"${proposal.type}" is not enabled for this tenant.`,
    );
  }
  pass("action_allowed");

  // 3. Attempt budget, counted per case across all runs - not per run, or a
  //    crash-loop would reset it and hammer the recipient.
  if (isContactAction(proposal.type) && kase.attemptCount >= policy.maxAttemptsPerCase) {
    return block(
      "attempt_budget",
      `Case has used ${kase.attemptCount} of ${policy.maxAttemptsPerCase} contact attempts.`,
    );
  }
  pass("attempt_budget", `${kase.attemptCount}/${policy.maxAttemptsPerCase} used`);

  // 4. Per-run action ceiling. Stops a looping agent from draining a budget
  //    in one sitting even when the per-case budget still has room.
  if (actionsThisRun >= policy.maxActionsPerRun) {
    return block(
      "run_action_ceiling",
      `Run already took ${actionsThisRun} actions (max ${policy.maxActionsPerRun}).`,
    );
  }
  pass("run_action_ceiling", `${actionsThisRun}/${policy.maxActionsPerRun} used`);

  // 5. Contact window, evaluated in the RECIPIENT's timezone. Server time is
  //    irrelevant and using it is how these systems end up calling people at
  //    4am in another state.
  if (isContactAction(proposal.type)) {
    // A reply to an active conversation is exempt. The window exists to stop
    // us interrupting people, not to stop us answering them.
    const graceMs = policy.inboundReplyGraceMinutes * 60_000;
    const sinceInbound = kase.lastInboundAt
      ? now.getTime() - kase.lastInboundAt.getTime()
      : Number.POSITIVE_INFINITY;
    const reactive = graceMs > 0 && sinceInbound >= 0 && sinceInbound <= graceMs;

    if (reactive) {
      pass(
        "contact_window",
        `Reactive reply, ${Math.round(sinceInbound / 60_000)}min after their message.`,
      );
      return finish();
    }

    const local = localTimeIn(kase.timezone, now);
    if (!local) {
      return block("contact_window", `Unusable timezone "${kase.timezone}".`);
    }
    if (!policy.contactOnWeekends && local.isWeekend) {
      return block(
        "contact_window",
        `Local time is ${local.label}; weekend contact is off for this tenant.`,
      );
    }
    const { contactWindowStartHour: start, contactWindowEndHour: end } = policy;
    if (local.hour < start || local.hour >= end) {
      return block(
        "contact_window",
        `Local time is ${local.label}; window is ${start}:00-${end}:00.`,
      );
    }
    pass("contact_window", `Local time ${local.label}`);
  } else {
    pass("contact_window", "not a contact action");
  }

  // 6. Spend ceiling.
  if (proposal.valuePaise > policy.maxValuePerActionPaise) {
    return block(
      "value_ceiling",
      `${formatPaise(proposal.valuePaise)} exceeds the ${formatPaise(policy.maxValuePerActionPaise)} per-action limit.`,
    );
  }
  pass("value_ceiling");

  return finish();

  // ---- everything below is the shared tail, reached by both paths ---------
  function finish(): PolicyVerdict {
  // 7. Templated replies are the one fast path to a person, so the gate on
  //    them is tighter, not looser: the template must be one a human already
  //    signed, and the agent may only fill variables from a fixed list. Free
  //    text cannot reach a recipient through here.
  if (proposal.type === TEMPLATED_ACTION) {
    const templateId = String(proposal.args.templateId ?? "");
    if (!templateId) {
      return block("template_approved", "No templateId given.");
    }
    if (!policy.approvedTemplates.includes(templateId)) {
      return block(
        "template_approved",
        `Template "${templateId}" has not been approved for this tenant.`,
      );
    }

    const vars = proposal.args.variables;
    if (vars !== undefined && (typeof vars !== "object" || vars === null || Array.isArray(vars))) {
      return block("template_variables", "variables must be an object.");
    }
    const offered = Object.keys((vars ?? {}) as Record<string, unknown>);
    const disallowed = offered.filter((k) => !TEMPLATE_VARIABLE_ALLOWLIST.has(k));
    if (disallowed.length > 0) {
      return block(
        "template_variables",
        `Not substitutable: ${disallowed.join(", ")}.`,
      );
    }
    pass("template_approved", templateId);
    pass("template_variables", offered.length ? offered.join(", ") : "none");

    checks.push({
      name: "approval_required",
      passed: true,
      detail: "Pre-approved template - the wording was signed before this run.",
    });
    return { allowed: true, requiresApproval: false, checks };
  }
  pass("template_approved", "not a templated action");

  // Allowed. The remaining question is only whether a human has to sign it.
  //
  // Irreversible actions never auto-approve, even when a tenant has listed them
  // as auto-approvable. A configuration mistake should not be able to send mail
  // on its own.
  const irreversible = IRREVERSIBLE_ACTIONS.has(proposal.type);
  const tenantAutoApproves = policy.autoApproveActions.includes(proposal.type);
  const requiresApproval = irreversible || !tenantAutoApproves;

  checks.push({
    name: "approval_required",
    passed: true,
    detail: requiresApproval
      ? irreversible
        ? "Irreversible action - always needs a human."
        : "Not on the tenant's auto-approve list."
      : "Auto-approved by tenant policy.",
  });

  return { allowed: true, requiresApproval, checks };
  }
}

function isContactAction(type: ActionType | string): boolean {
  return CONTACT_ACTIONS.has(type as ActionType);
}

/** Returns null rather than throwing, so a bad timezone fails the check closed. */
function localTimeIn(
  timeZone: string,
  at: Date,
): { hour: number; isWeekend: boolean; label: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(at);

    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    // hour12:false yields "24" for midnight in some runtimes.
    const hour = Number(get("hour")) % 24;
    const weekday = get("weekday");
    if (Number.isNaN(hour) || !weekday) return null;

    return {
      hour,
      isWeekend: weekday === "Sat" || weekday === "Sun",
      label: `${weekday} ${String(hour).padStart(2, "0")}:${get("minute")} ${timeZone}`,
    };
  } catch {
    return null;
  }
}

function formatPaise(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2)}`;
}
