import { z } from "zod";

/**
 * An action is anything the agent wants to do that touches the outside world.
 * Every one of them goes through propose -> policy -> (approve) -> execute,
 * and every one of them is written to the database before it fires.
 */
export const ActionTypeSchema = z.enum([
  "send_templated_reply",
  "send_email",
  "send_sms",
  "place_call",
  "schedule_callback",
  "update_case",
  "escalate_to_human",
  "close_case",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/** Actions that can never be undone once they fire. */
export const IRREVERSIBLE_ACTIONS: ReadonlySet<ActionType> = new Set([
  "send_templated_reply",
  "send_email",
  "send_sms",
  "place_call",
]);

/**
 * Actions that reach a real person.
 *
 * One definition, because three checks read it and one write depends on it:
 * opt-out, the contact window and the per-case attempt budget all apply only to
 * these, and executing one is what spends an attempt. Those used to be separate
 * lists and they had drifted - `send_templated_reply` was checked against the
 * attempt budget by policy.ts and never charged to it by runtime.ts, so the one
 * action that can reach a customer unattended could not consume the budget that
 * was supposed to bound it. A case could be messaged indefinitely while
 * `attemptCount` sat at 0.
 *
 * It happens to hold the same members as IRREVERSIBLE_ACTIONS today and is
 * still a separate set: "cannot be taken back" and "reaches a person" are
 * different questions, and a refund would answer them differently.
 */
export const CONTACT_ACTIONS: ReadonlySet<ActionType> = new Set([
  "send_templated_reply",
  "send_email",
  "send_sms",
  "place_call",
]);

/**
 * Irreversible, but approved in advance at the template level rather than per
 * message. The human signed the wording once; the agent fills the variables.
 * This is the only path by which the agent reaches a person without a person
 * in the loop at that moment, and it is narrow on purpose.
 */
export const TEMPLATED_ACTION: ActionType = "send_templated_reply";

/** Variables the agent may substitute into an approved template. Nothing else. */
export const TEMPLATE_VARIABLE_ALLOWLIST: ReadonlySet<string> = new Set([
  "name",
  "service",
  "city",
  "business_name",
  "slot_time",
]);

export const ProposalSchema = z.object({
  type: ActionTypeSchema,
  args: z.record(z.string(), z.unknown()),
  /** Shown verbatim to the human approver. Not for the model's benefit. */
  reason: z.string().min(1),
  /** Rupee value in paise, for spend ceilings. 0 for actions that cost nothing. */
  valuePaise: z.number().int().min(0).default(0),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export type PolicyVerdict =
  | { allowed: true; requiresApproval: boolean; checks: CheckResult[] }
  | { allowed: false; requiresApproval: false; blockedBy: string; checks: CheckResult[] };

export type CheckResult = {
  name: string;
  passed: boolean;
  detail?: string;
};

export type ExecutionResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };
