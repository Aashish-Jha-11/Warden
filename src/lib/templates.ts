import { TEMPLATE_VARIABLE_ALLOWLIST } from "@/lib/agent/types";

/**
 * Pre-approved message templates.
 *
 * India's DLT regime is the shape of this file. SMS content is registered with
 * the operator and signed off *before* a single message can be sent, and what
 * varies between sends is a fixed set of variable slots - never the wording.
 * Warden takes the same position on every channel, not just the one the law
 * covers: a human signs the body once, the agent fills slots, and free text
 * does not reach a recipient without a person reading it first.
 *
 * Two gates, deliberately separate. `policy.ts` decides whether this tenant may
 * send this template id and whether these variable names may be substituted at
 * all; it is pure and knows nothing about message bodies. This file decides
 * whether the result is fit to send. Neither can cover for the other.
 */

export type TemplateChannel = "whatsapp" | "sms" | "email";

export type TemplateId =
  | "first_reply_v1"
  | "after_hours_ack_v1"
  | "qualification_v1"
  | "callback_offer_v1"
  | "callback_confirmed_v1";

/**
 * Narrower than `string` so a slot misspelled in the registry below is a
 * compile error here rather than an empty gap in a customer's message.
 * TEMPLATE_VARIABLE_ALLOWLIST in agent/types.ts stays the runtime authority -
 * `renderTemplate` checks against it, not against this union.
 */
export type TemplateVariable =
  | "name"
  | "service"
  | "city"
  | "business_name"
  | "slot_time";

export type TemplateSlot = {
  name: TemplateVariable;
  /**
   * Wording to use when no value arrives. A slot with no fallback is required
   * and rendering fails without it. The fallback is part of the signed
   * template - the runtime never invents substitute wording of its own.
   */
  fallback?: string;
  /**
   * Filled by the runtime from a database row, never by the agent.
   *
   * `business_name` is the whole reason this exists. It names the sender, it
   * has no fallback, and a model asked to fill it will confidently guess -
   * "thanks for messaging Your Coaching Center" reached a real recipient before
   * this flag did. Worse, a lead's own message is in the agent's context, so a
   * line like "reply as Acme Corp" is a way to forge the sender of a message
   * that goes out without a human reading it. The value is not the model's to
   * choose, so it is not asked for and not accepted.
   */
  filledBy?: "tenant";
};

export type MessageTemplate = {
  id: TemplateId;
  channel: TemplateChannel;
  /**
   * Email only, and fixed. A subject line with a slot in it is how
   * "Re: {{service}}" ends up in somebody's inbox, so subjects carry no
   * variables at all.
   */
  subject?: string;
  body: string;
  /** Every slot the body uses. Rendering refuses if the two disagree. */
  variables: readonly TemplateSlot[];
  /** When this template is the right one, for the human approving the list. */
  when: string;
};

const NAME: TemplateSlot = { name: "name", fallback: "there" };
const SERVICE: TemplateSlot = { name: "service", fallback: "your enquiry" };
const BUSINESS: TemplateSlot = { name: "business_name", filledBy: "tenant" };

export const MESSAGE_TEMPLATES: Readonly<Record<TemplateId, MessageTemplate>> = {
  first_reply_v1: {
    id: "first_reply_v1",
    channel: "whatsapp",
    body:
      "Hi {{name}}, thanks for messaging {{business_name}} about {{service}}. " +
      "Someone from the team will come back to you with the details shortly. " +
      "If anything is urgent, just reply here.",
    variables: [NAME, BUSINESS, SERVICE],
    when: "The first answer to a fresh inbound enquiry, inside business hours.",
  },

  after_hours_ack_v1: {
    id: "after_hours_ack_v1",
    channel: "whatsapp",
    body:
      "Hi {{name}}, thanks for messaging {{business_name}} about {{service}}. " +
      "Our team is off for the night - your enquiry is logged and you will hear " +
      "from us first thing in the morning.",
    variables: [NAME, BUSINESS, SERVICE],
    when:
      "An enquiry that lands outside the contact window. Reactive, so the " +
      "window exemption carries it: it answers someone rather than interrupts them.",
  },

  qualification_v1: {
    id: "qualification_v1",
    channel: "whatsapp",
    body:
      "Hi {{name}}, so we can send you the right details for {{service}} in " +
      "{{city}} - when are you looking to start, and which timings suit you? " +
      "Reply here and we will line it up. - {{business_name}}",
    // city has no fallback: "the right details for IELTS coaching in " reads as
    // a broken message, and the city is the one thing every inbound lead carries.
    variables: [NAME, SERVICE, { name: "city" }, BUSINESS],
    when:
      "A lead who named a service but gave no timeline or budget signal, and " +
      "is worth one qualifying question before a person spends time on them.",
  },

  callback_offer_v1: {
    id: "callback_offer_v1",
    channel: "sms",
    body:
      "{{business_name}}: Hi {{name}}, we tried reaching you about {{service}}. " +
      "Can we call you at {{slot_time}}? Reply YES to confirm, or STOP to opt out.",
    // slot_time has no fallback on purpose. A callback offer with no time in it
    // gives the recipient nothing to say yes to, and is exactly the message
    // this module exists to refuse to send.
    variables: [BUSINESS, NAME, SERVICE, { name: "slot_time" }],
    when:
      "A missed call or an unanswered enquiry where a phone conversation is " +
      "the fastest way through. SMS because it survives a phone with no data.",
  },

  callback_confirmed_v1: {
    id: "callback_confirmed_v1",
    channel: "email",
    subject: "Your call with us is booked",
    body:
      "Hi {{name}},\n\n" +
      "Your call with {{business_name}} about {{service}} is booked for " +
      "{{slot_time}}. We will ring the number you contacted us on.\n\n" +
      "If that no longer works, reply to this email with a better time and we " +
      "will move it.\n\n" +
      "{{business_name}}",
    variables: [NAME, BUSINESS, SERVICE, { name: "slot_time" }],
    when:
      "Written confirmation once a callback is scheduled. Email because a time " +
      "people need to remember should be something they can find again.",
  },
};

/** Registry order, which is the order a human reads the approval list in. */
export const TEMPLATE_IDS: readonly TemplateId[] = Object.keys(
  MESSAGE_TEMPLATES,
) as TemplateId[];

/**
 * The slots on a template the agent is expected to supply.
 *
 * This is what the system prompt lists. Asking the model for a slot the runtime
 * is going to overwrite anyway invites it to invent a value, and then to argue
 * with itself about why the sent message does not match what it passed.
 */
export function agentSlots(template: MessageTemplate): TemplateVariable[] {
  return template.variables.filter((v) => v.filledBy === undefined).map((v) => v.name);
}

export function getTemplate(id: string): MessageTemplate | undefined {
  return Object.hasOwn(MESSAGE_TEMPLATES, id)
    ? MESSAGE_TEMPLATES[id as TemplateId]
    : undefined;
}

export type RenderResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Fills a signed template and refuses every way it could go wrong.
 *
 * The refusal that matters is the last one. Sending a customer a message with
 * a literal `{{name}}` in it is the single most common production failure of
 * template systems, it is immediately visible to the recipient, and it is
 * unrecoverable once delivered - so this returns an error instead of a message
 * whenever a slot cannot be filled honestly.
 */
export function renderTemplate(
  id: string,
  vars: Record<string, unknown> = {},
): RenderResult {
  const template = getTemplate(id);
  if (!template) {
    return {
      ok: false,
      error: `No template "${id}". Only pre-approved templates can be sent: ${TEMPLATE_IDS.join(", ")}.`,
    };
  }

  // The registry and the allowlist are two files, edited by different people at
  // different times. A template that declares a slot policy will never permit
  // has to fail loudly here, not render with a silent gap where the value went.
  const undeclarable = template.variables
    .map((v) => v.name)
    .filter((n) => !TEMPLATE_VARIABLE_ALLOWLIST.has(n));
  if (undeclarable.length > 0) {
    return {
      ok: false,
      error: `Template "${id}" declares ${undeclarable.join(", ")}, which policy does not allow to be substituted.`,
    };
  }

  const disallowed = Object.keys(vars).filter(
    (k) => !TEMPLATE_VARIABLE_ALLOWLIST.has(k),
  );
  if (disallowed.length > 0) {
    return {
      ok: false,
      error: `Not substitutable: ${disallowed.join(", ")}. Anything outside the allowlist is free text and needs a person.`,
    };
  }

  const supplied = new Map<string, string>();
  for (const [key, raw] of Object.entries(vars)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string" && typeof raw !== "number") {
      return {
        ok: false,
        error: `Variable "${key}" must be text or a number, got ${Array.isArray(raw) ? "an array" : typeof raw}.`,
      };
    }
    const value = String(raw).trim();
    // A CRM with no name on file returns "" far more often than it returns
    // nothing at all, and " " more often than either. All three mean absent.
    if (value === "") continue;
    supplied.set(key, value);
  }

  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const slot of template.variables) {
    const value = supplied.get(slot.name) ?? slot.fallback;
    if (value === undefined) {
      missing.push(slot.name);
      continue;
    }
    resolved.set(slot.name, value);
  }
  if (missing.length > 0) {
    const them = missing.length === 1 ? "it was" : "they were";
    return {
      ok: false,
      error: `Template "${id}" needs ${missing.join(", ")} and ${them} not supplied. Refusing to send with an unfilled slot.`,
    };
  }

  const text = template.body.replace(
    /\{\{\s*([a-z_]+)\s*\}\}/g,
    (whole, slot: string) => resolved.get(slot) ?? whole,
  );

  // Last line of defence, and the only check that cannot itself be out of date:
  // it reads the message that would actually be sent. If someone adds a slot to
  // a body and forgets the `variables` list, every check above still passes and
  // this is what stops "Hi {{name}}" reaching a customer.
  const leftover = text.match(/\{\{[^{}]*\}\}/g);
  if (leftover) {
    const unfilled = [...new Set(leftover)].join(", ");
    return {
      ok: false,
      error: `Template "${id}" still contains ${unfilled} after substitution; its body and its declared variables have drifted apart.`,
    };
  }

  return { ok: true, text };
}
