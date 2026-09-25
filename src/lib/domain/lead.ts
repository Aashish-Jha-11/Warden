import { z } from "zod";

/**
 * The domain payload carried in Case.payload.
 *
 * An Indian SMB - a coaching institute, clinic, gym, broker, salon - gets
 * inbound enquiries across WhatsApp, a website form, Google Ads, JustDial.
 * Most of them die not because the business was uninterested but because
 * nobody answered while the person was still paying attention.
 */

export const LeadSourceSchema = z.enum([
  "whatsapp",
  "website_form",
  "google_ads",
  "justdial",
  "instagram",
  "missed_call",
]);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

export const UrgencySchema = z.enum(["browsing", "comparing", "ready"]);
export const BudgetSignalSchema = z.enum(["none", "low", "mid", "high"]);

export const LeadPayloadSchema = z.object({
  source: LeadSourceSchema,
  /** What they actually typed. The agent's personalisation hangs off this. */
  message: z.string(),
  /** The service they named, if they named one. */
  service: z.string().nullable(),
  city: z.string(),
  /** When the enquiry landed. All latency is measured from here. */
  arrivedAt: z.string(),
  urgency: UrgencySchema,
  budgetSignal: BudgetSignalSchema,
});
export type LeadPayload = z.infer<typeof LeadPayloadSchema>;

export const QualificationSchema = z.object({
  score: z.number().int().min(0).max(100),
  tier: z.enum(["hot", "warm", "cold"]),
  reason: z.string(),
});
export type Qualification = z.infer<typeof QualificationSchema>;

/**
 * Deterministic scoring, deliberately not done by the model.
 *
 * The model writes the reply; this decides how much the lead is worth chasing.
 * Keeping it here means the control arm can use the identical function, so a
 * measured lift is never just "the agent got a better scoring function".
 */
export function scoreLead(lead: LeadPayload): Qualification {
  let score = 40;
  const notes: string[] = [];

  const urgency = { browsing: -15, comparing: 5, ready: 25 }[lead.urgency];
  score += urgency;
  notes.push(`urgency=${lead.urgency}`);

  const budget = { none: -10, low: 0, mid: 10, high: 20 }[lead.budgetSignal];
  score += budget;
  notes.push(`budget=${lead.budgetSignal}`);

  // Channel intent: someone who called and got no answer, or wrote on WhatsApp,
  // is further along than someone who clicked an ad.
  const channel: Record<LeadSource, number> = {
    missed_call: 15,
    whatsapp: 10,
    website_form: 5,
    justdial: 5,
    google_ads: 0,
    instagram: -5,
  };
  score += channel[lead.source];
  notes.push(`source=${lead.source}`);

  if (lead.service) {
    score += 10;
    notes.push("named a specific service");
  }
  if (lead.message.trim().length > 60) {
    score += 5;
    notes.push("wrote a detailed enquiry");
  }

  score = Math.max(0, Math.min(100, score));
  const tier = score >= 70 ? "hot" : score >= 45 ? "warm" : "cold";

  return { score, tier, reason: notes.join(", ") };
}
