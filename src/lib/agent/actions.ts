import { db } from "@/lib/db";
import { renderTemplate } from "@/lib/templates";
import type { ActionType, ExecutionResult } from "./types";

/**
 * Action executors.
 *
 * Kept deliberately thin and deliberately separate from the agent loop. The
 * loop decides; these functions do. Nothing here re-checks policy, because by
 * the time an executor runs the action has already been proposed, checked,
 * persisted and (where required) approved. Putting a second check here would
 * make it ambiguous which one is authoritative.
 *
 * In CONTROL-arm runs and during evals these are never called - the harness
 * stubs them - so an eval can never send real mail.
 */
export type Executor = (
  args: Record<string, unknown>,
  ctx: { tenantId: string; caseId: string; dryRun: boolean },
) => Promise<ExecutionResult>;

const executors: Partial<Record<ActionType, Executor>> = {
  /**
   * The only path that reaches a person without a human reading the message
   * first, which is why the rendering happens HERE and not in the agent.
   *
   * policy.ts has already confirmed the template id is approved and the
   * variables are on the allowlist. What is left is filling the slots, and
   * renderTemplate() refuses rather than emitting a literal "{{name}}" to a
   * customer - the failure that actually happens in production. A refusal is
   * returned as a failed execution, so it lands in the audit log and the run
   * trace instead of going out half-written.
   */
  send_templated_reply: async (args, ctx) => {
    const templateId = String(args.templateId ?? "");
    const variables = { ...((args.variables ?? {}) as Record<string, unknown>) };

    // The sender's own name is read from the tenant row and overwrites whatever
    // the model passed. Every template needs it, none of them has a fallback
    // for it, and a model asked to name the business it works for guesses:
    // "thanks for messaging Your Coaching Center" and "- Prime IELTS Coaching"
    // both went out, marked sent, from a workspace called Sahyadri Services.
    // The lead's own words are in the agent's context, so accepting the value
    // would also let an enquiry rename the sender of the one message that
    // reaches a person with no human reading it first.
    //
    // A tenant with a blank name leaves the slot unfilled, and renderTemplate
    // refuses. Refusing to send is the correct outcome: a message whose sender
    // is unknown to us is not a message we can stand behind.
    const tenant = await db.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { name: true },
    });
    variables.business_name = tenant?.name ?? "";

    const rendered = renderTemplate(templateId, variables);
    if (!rendered.ok) return { ok: false, error: rendered.error };

    if (ctx.dryRun) {
      return { ok: true, data: { dryRun: true, templateId, text: rendered.text } };
    }
    // TODO(provider): hand `rendered.text` to WhatsApp/MSG91 once a sender is
    // wired. The text is returned either way so the trace shows what was sent.
    return { ok: true, data: { sent: true, templateId, text: rendered.text } };
  },

  send_email: async (args, ctx) => {
    if (ctx.dryRun) return { ok: true, data: { dryRun: true, ...args } };
    // TODO(provider): wire Resend/SES here once the domain is locked.
    return { ok: true, data: { queued: true, to: args.to, subject: args.subject } };
  },

  send_sms: async (args, ctx) => {
    if (ctx.dryRun) return { ok: true, data: { dryRun: true, ...args } };
    // TODO(provider): wire MSG91/Twilio here.
    return { ok: true, data: { queued: true, to: args.to } };
  },

  place_call: async (args, ctx) => {
    if (ctx.dryRun) return { ok: true, data: { dryRun: true, ...args } };
    // Browser/WebRTC only for the demo. Indian telephony needs DLT registration
    // that cannot be obtained inside the hackathon window.
    return { ok: true, data: { queued: true, to: args.to, channel: "webrtc" } };
  },

  schedule_callback: async (args) => ({ ok: true, data: { scheduledFor: args.at } }),

  update_case: async (args) => ({ ok: true, data: { patch: args } }),

  escalate_to_human: async (args) => ({ ok: true, data: { queue: args.queue ?? "default" } }),

  close_case: async (args) => ({ ok: true, data: { resolution: args.resolution } }),
};

export function executorFor(type: ActionType): Executor | undefined {
  return executors[type];
}

export function knownActionTypes(): ActionType[] {
  return Object.keys(executors) as ActionType[];
}
