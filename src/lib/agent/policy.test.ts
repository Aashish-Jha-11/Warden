import { describe, expect, it } from "vitest";
import type { Case, Policy } from "@/generated/prisma/client";
import { evaluatePolicy } from "./policy";
import type { Proposal } from "./types";

// A Wednesday, 09:30 UTC. Chosen so the same instant lands inside business
// hours in one timezone and outside it in another - see the timezone test.
const WED_0930_UTC = new Date("2026-09-23T09:30:00Z");
const SAT_0930_UTC = new Date("2026-09-26T09:30:00Z");

function policy(over: Partial<Policy> = {}): Policy {
  return {
    id: "p1",
    tenantId: "t1",
    maxAttemptsPerCase: 3,
    maxActionsPerRun: 8,
    maxRunSteps: 24,
    contactWindowStartHour: 9,
    contactWindowEndHour: 20,
    contactOnWeekends: false,
    // Off by default in tests so the window tests stay about the window.
    inboundReplyGraceMinutes: 0,
    allowedActions: [
      "send_templated_reply",
      "send_email",
      "send_sms",
      "update_case",
      "close_case",
    ],
    autoApproveActions: ["update_case", "send_email"],
    approvedTemplates: ["first_reply_v1", "callback_offer_v1"],
    maxValuePerActionPaise: 50_000,
    createdAt: WED_0930_UTC,
    updatedAt: WED_0930_UTC,
    ...over,
  };
}

function kase(over: Partial<Case> = {}): Case {
  return {
    id: "c1",
    tenantId: "t1",
    externalId: null,
    subject: "Test case",
    status: "OPEN",
    contactName: "A",
    contactEmail: "a@example.com",
    contactPhone: null,
    timezone: "Asia/Kolkata",
    payload: {},
    attemptCount: 0,
    optedOut: false,
    lastInboundAt: null,
    createdAt: WED_0930_UTC,
    updatedAt: WED_0930_UTC,
    ...over,
  };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return { type: "send_email", args: { to: "a@example.com" }, reason: "r", valuePaise: 0, ...over };
}

const run = (args: {
  proposal?: Partial<Proposal>;
  policy?: Partial<Policy>;
  kase?: Partial<Case>;
  actionsThisRun?: number;
  now?: Date;
}) =>
  evaluatePolicy({
    proposal: proposal(args.proposal),
    policy: policy(args.policy),
    kase: kase(args.kase),
    actionsThisRun: args.actionsThisRun ?? 0,
    now: args.now ?? WED_0930_UTC,
  });

describe("opt-out", () => {
  it("blocks contact even when every other check would pass", () => {
    const v = run({ kase: { optedOut: true } });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.blockedBy).toBe("opt_out");
  });

  it("does not block actions that never reach the person", () => {
    const v = run({ kase: { optedOut: true }, proposal: { type: "update_case" } });
    expect(v.allowed).toBe(true);
  });
});

describe("allow-list", () => {
  it("blocks an action the tenant has not enabled", () => {
    const v = run({ proposal: { type: "place_call" } });
    expect(v.allowed === false && v.blockedBy).toBe("action_allowed");
  });
});

describe("attempt budget", () => {
  it("blocks once the per-case budget is spent", () => {
    const v = run({ kase: { attemptCount: 3 }, policy: { maxAttemptsPerCase: 3 } });
    expect(v.allowed === false && v.blockedBy).toBe("attempt_budget");
  });

  it("counts per case, so a non-contact action is unaffected", () => {
    const v = run({ kase: { attemptCount: 9 }, proposal: { type: "update_case" } });
    expect(v.allowed).toBe(true);
  });
});

describe("contact window", () => {
  it("allows contact inside the recipient's local business hours", () => {
    // 09:30 UTC -> 15:00 IST, inside 09:00-20:00
    expect(run({ kase: { timezone: "Asia/Kolkata" } }).allowed).toBe(true);
  });

  it("is evaluated in the recipient's timezone, not the server's", () => {
    // Same instant. 15:00 in Kolkata, 02:30 in Los Angeles.
    const ist = run({ kase: { timezone: "Asia/Kolkata" } });
    const pst = run({ kase: { timezone: "America/Los_Angeles" } });

    expect(ist.allowed).toBe(true);
    expect(pst.allowed).toBe(false);
    expect(pst.allowed === false && pst.blockedBy).toBe("contact_window");
  });

  it("blocks weekends unless the tenant opted in", () => {
    const off = run({ now: SAT_0930_UTC });
    expect(off.allowed === false && off.blockedBy).toBe("contact_window");

    const on = run({ now: SAT_0930_UTC, policy: { contactOnWeekends: true } });
    expect(on.allowed).toBe(true);
  });

  it("fails closed on an unusable timezone rather than guessing", () => {
    const v = run({ kase: { timezone: "Mars/Olympus_Mons" } });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.blockedBy).toBe("contact_window");
  });
});

describe("reactive reply exemption", () => {
  // The finding that produced this rule: waiting for business hours made the
  // agent lose to a plain autoresponder on overnight leads. Answering someone
  // who just messaged you is not the thing a contact window is for.
  const graced = (over: { lastInboundAt: Date | null; grace?: number; tz?: string }) =>
    run({
      policy: { inboundReplyGraceMinutes: over.grace ?? 30 },
      kase: { lastInboundAt: over.lastInboundAt, timezone: over.tz ?? "America/Los_Angeles" },
    });

  it("allows an out-of-hours reply when they messaged moments ago", () => {
    // 02:30 local in Los Angeles - far outside 09:00-20:00.
    const justNow = new Date(WED_0930_UTC.getTime() - 2 * 60_000);
    const v = graced({ lastInboundAt: justNow });
    expect(v.allowed).toBe(true);
  });

  it("stops exempting once the conversation has gone cold", () => {
    const hoursAgo = new Date(WED_0930_UTC.getTime() - 6 * 60 * 60_000);
    const v = graced({ lastInboundAt: hoursAgo });
    expect(v.allowed === false && v.blockedBy).toBe("contact_window");
  });

  it("does not exempt a case that never had an inbound message", () => {
    const v = graced({ lastInboundAt: null });
    expect(v.allowed === false && v.blockedBy).toBe("contact_window");
  });

  it("can be switched off entirely with grace=0", () => {
    const justNow = new Date(WED_0930_UTC.getTime() - 2 * 60_000);
    const v = graced({ lastInboundAt: justNow, grace: 0 });
    expect(v.allowed === false && v.blockedBy).toBe("contact_window");
  });

  it("is not a bypass for opt-out", () => {
    const justNow = new Date(WED_0930_UTC.getTime() - 2 * 60_000);
    const v = run({
      policy: { inboundReplyGraceMinutes: 30 },
      kase: { lastInboundAt: justNow, optedOut: true, timezone: "America/Los_Angeles" },
    });
    expect(v.allowed === false && v.blockedBy).toBe("opt_out");
  });

  it("is not a bypass for the attempt budget", () => {
    const justNow = new Date(WED_0930_UTC.getTime() - 2 * 60_000);
    const v = run({
      policy: { inboundReplyGraceMinutes: 30, maxAttemptsPerCase: 2 },
      kase: { lastInboundAt: justNow, attemptCount: 2, timezone: "America/Los_Angeles" },
    });
    expect(v.allowed === false && v.blockedBy).toBe("attempt_budget");
  });

  it("is not a bypass for the spend ceiling", () => {
    // A reactive templated reply goes out with nobody reading it first, and
    // valuePaise is a number the model picks. The window is waived here; the
    // ceiling never is.
    const justNow = new Date(WED_0930_UTC.getTime() - 2 * 60_000);
    const v = run({
      proposal: {
        type: "send_templated_reply",
        args: { templateId: "first_reply_v1" },
        valuePaise: 60_000,
      },
      policy: { inboundReplyGraceMinutes: 30, maxValuePerActionPaise: 50_000 },
      kase: { lastInboundAt: justNow, timezone: "America/Los_Angeles" },
    });
    expect(v.allowed === false && v.blockedBy).toBe("value_ceiling");
  });
});

describe("ceilings", () => {
  it("blocks an action worth more than the per-action limit", () => {
    const v = run({
      proposal: { type: "update_case", valuePaise: 60_000 },
      policy: { maxValuePerActionPaise: 50_000 },
    });
    expect(v.allowed === false && v.blockedBy).toBe("value_ceiling");
  });

  it("blocks once a single run has taken too many actions", () => {
    const v = run({ actionsThisRun: 8, policy: { maxActionsPerRun: 8 } });
    expect(v.allowed === false && v.blockedBy).toBe("run_action_ceiling");
  });
});

describe("pre-approved templates", () => {
  const templated = (args: Record<string, unknown>) =>
    run({ proposal: { type: "send_templated_reply", args } });

  it("sends an approved template without stopping for a human", () => {
    const v = templated({
      templateId: "first_reply_v1",
      variables: { name: "Asha", service: "IELTS coaching" },
    });
    expect(v.allowed).toBe(true);
    expect(v.requiresApproval).toBe(false);
  });

  it("blocks a template nobody approved", () => {
    const v = templated({ templateId: "improvised_v9", variables: {} });
    expect(v.allowed === false && v.blockedBy).toBe("template_approved");
  });

  it("blocks a missing templateId rather than defaulting to one", () => {
    const v = templated({ variables: {} });
    expect(v.allowed === false && v.blockedBy).toBe("template_approved");
  });

  it("refuses variables outside the allowlist, so free text cannot ride along", () => {
    const v = templated({
      templateId: "first_reply_v1",
      variables: { name: "Asha", discount_offer: "40% off, today only" },
    });
    expect(v.allowed === false && v.blockedBy).toBe("template_variables");
  });

  it("still obeys the contact window - pre-approval is not a bypass", () => {
    const v = run({
      proposal: { type: "send_templated_reply", args: { templateId: "first_reply_v1" } },
      kase: { timezone: "America/Los_Angeles" },
    });
    expect(v.allowed === false && v.blockedBy).toBe("contact_window");
  });

  it("still obeys opt-out", () => {
    const v = run({
      proposal: { type: "send_templated_reply", args: { templateId: "first_reply_v1" } },
      kase: { optedOut: true },
    });
    expect(v.allowed === false && v.blockedBy).toBe("opt_out");
  });
});

describe("approval", () => {
  it("never auto-approves an irreversible action, even if the tenant listed it", () => {
    // send_email IS on autoApproveActions above - and still needs a human,
    // because a misconfiguration must not be able to send mail on its own.
    const v = run({ proposal: { type: "send_email" } });
    expect(v.allowed).toBe(true);
    expect(v.requiresApproval).toBe(true);
  });

  it("auto-approves a reversible action the tenant listed", () => {
    const v = run({ proposal: { type: "update_case" } });
    expect(v.allowed).toBe(true);
    expect(v.requiresApproval).toBe(false);
  });

  it("requires approval for a reversible action the tenant did not list", () => {
    const v = run({ proposal: { type: "close_case" } });
    expect(v.allowed).toBe(true);
    expect(v.requiresApproval).toBe(true);
  });
});
