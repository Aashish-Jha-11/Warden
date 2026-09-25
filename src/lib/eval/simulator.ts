import type { LeadPayload } from "@/lib/domain/lead";
import { scoreLead } from "@/lib/domain/lead";

/**
 * Outcome model for the eval.
 *
 * THIS IS A SIMULATION AND THE REPORT SAYS SO. No lead in an eval run is a real
 * person and no message is really sent - `actions.ts` executors run with
 * dryRun=true for every eval arm. What is being measured is whether the agent's
 * *decisions* beat the baseline's decisions under a stated model of how leads
 * behave, not whether it makes money in production. Claiming otherwise would be
 * the easiest and least defensible thing in this repo.
 *
 * Every constant below is declared here rather than scattered, so the model can
 * be argued with. The shape - conversion falling steeply with response delay,
 * flattening rather than reaching zero - is the consistent finding in published
 * lead-response research; the exact constants are our assumption, and the
 * sensitivity of the headline number to them is reported by `pnpm eval`.
 */

export type OutcomeModel = {
  baseRateByTier: Record<"hot" | "warm" | "cold", number>;
  latencyTauMinutes: number;
  latencyFloor: number;
  personalisedMultiplier: number;
  genericMultiplier: number;
  misfireMultiplier: number;
  personalisationMisfireRate: number;
  inWindowMultiplier: number;
  outOfWindowMultiplier: number;
  noContactRate: number;
};

export const MODEL: OutcomeModel = {
  /** Conversion for a perfectly handled hot lead answered instantly. */
  baseRateByTier: { hot: 0.42, warm: 0.22, cold: 0.07 },

  /**
   * latency(d) = FLOOR + (1 - FLOOR) * exp(-d / TAU)
   * Minutes. TAU=45 puts roughly half the decay inside the first half hour;
   * FLOOR keeps a next-day reply worth something, which it is.
   */
  latencyTauMinutes: 45,
  latencyFloor: 0.15,

  /** A reply that names their service and city vs a generic template. */
  personalisedMultiplier: 1.0,
  genericMultiplier: 0.78,

  /**
   * Personalisation is not free. A written-for-you reply that misreads what
   * was asked - wrong service, wrong language, wrong register - lands worse
   * than a neutral template, because it proves nobody was paying attention.
   * A template is boring; a wrong personal reply is disqualifying.
   */
  misfireMultiplier: 0.5,
  personalisationMisfireRate: 0.12,

  /** Reaching someone at a sensible local hour vs whenever. */
  inWindowMultiplier: 1.0,
  outOfWindowMultiplier: 0.55,

  /** Never contacted at all. */
  noContactRate: 0.01,
};

export type ReplyQuality = "personalised" | "generic" | "misfire";

export type Handling = {
  /** Minutes between the enquiry landing and the first reply going out. */
  responseDelayMinutes: number | null;
  /** Whether the reply spoke to their actual enquiry, or got it wrong. */
  quality: ReplyQuality;
  /** Was it sent inside the recipient's local contact window? */
  inContactWindow: boolean;
};

/**
 * Probability this lead converts, given how it was handled.
 *
 * `model` is injectable so the harness can re-run the whole comparison with a
 * perturbed constant and report how much the headline number depends on it.
 * A lift that only survives one setting of TAU is not a finding.
 */
export function conversionProbability(
  lead: LeadPayload,
  handling: Handling,
  model: OutcomeModel = MODEL,
): number {
  if (handling.responseDelayMinutes === null) return model.noContactRate;

  const { tier } = scoreLead(lead);
  const base = model.baseRateByTier[tier];

  const latency =
    model.latencyFloor +
    (1 - model.latencyFloor) *
      Math.exp(-Math.max(0, handling.responseDelayMinutes) / model.latencyTauMinutes);

  const quality = {
    personalised: model.personalisedMultiplier,
    generic: model.genericMultiplier,
    misfire: model.misfireMultiplier,
  }[handling.quality];

  const timing = handling.inContactWindow
    ? model.inWindowMultiplier
    : model.outOfWindowMultiplier;

  return clamp01(base * latency * quality * timing);
}

/**
 * Common random numbers.
 *
 * The draw belongs to the CASE, not to the arm. Both arms are compared against
 * the same u, so a case that was always going to convert converts in both arms
 * and a hopeless one converts in neither. What remains is the decisions.
 *
 * Without this, two arms differing by a couple of points need thousands of
 * cases to separate; with it, a few hundred is enough, and a reported lift is
 * not just a lucky draw.
 */
export function converts(u: number, probability: number): boolean {
  return u < probability;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
