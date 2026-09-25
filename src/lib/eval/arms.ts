import type { LeadPayload } from "@/lib/domain/lead";
import type { Handling, ReplyQuality } from "./simulator";
import { MODEL } from "./simulator";
import { localHourFraction, minutesUntilLocalHour } from "./time";

/**
 * How each arm handles a lead. This is the only place the arms differ: same
 * lead, same scoring function, same guardrails, same random draw. What
 * separates them is when they reply and what they say.
 */

export type ArmName = "agent_v1" | "agent_v2" | "batch" | "autoresponder";

export const WINDOW = { start: 9, end: 20 } as const;

/** Webhook in, model out, template sent. */
export const AGENT_DECISION_LATENCY_MIN = 1.5;

/** When a person actually opens the enquiry inbox. */
export const BATCH_SLOTS = [10, 14, 18] as const;

/**
 * Note on `inContactWindow`.
 *
 * The out-of-hours penalty models reaching someone who is asleep or annoyed.
 * It does not apply to a reply sent seconds after that person messaged us:
 * they are demonstrably awake and holding the phone. So every arm that answers
 * an inbound immediately gets no penalty, the autoresponder included.
 *
 * An earlier version of this file penalised the autoresponder overnight but
 * planned to exempt the agent for the identical behaviour. That was a bug in
 * our favour and the corrected number is smaller.
 */
export function handleAs(
  arm: ArmName,
  lead: LeadPayload,
  timeZone: string,
  /**
   * Per-case draw deciding whether the agent's personalisation lands. Shared
   * between the agent arms, so v1 and v2 get it right or wrong together and
   * the comparison between them stays about timing alone.
   */
  misfireDraw: number,
  misfireRate: number = MODEL.personalisationMisfireRate,
): Handling {
  const arrived = new Date(lead.arrivedAt);
  const localHour = localHourFraction(timeZone, arrived) ?? 12;
  const inWindowNow = localHour >= WINDOW.start && localHour < WINDOW.end;
  const agentQuality: ReplyQuality = misfireDraw < misfireRate ? "misfire" : "personalised";

  switch (arm) {
    /**
     * v1: personalised, but treats the contact window as absolute, so an
     * overnight enquiry waits until 09:00. This is the arm the eval caught
     * losing to a plain autoresponder.
     */
    case "agent_v1":
      return {
        responseDelayMinutes: inWindowNow
          ? AGENT_DECISION_LATENCY_MIN
          : minutesUntilLocalHour(timeZone, arrived, WINDOW.start),
        quality: agentQuality,
        inContactWindow: true,
      };

    /**
     * v2: same, except a reply inside the reactive grace period is exempt from
     * the window - the rule the eval argued into existence. Proactive follow
     * ups still wait.
     */
    case "agent_v2":
      return {
        responseDelayMinutes: AGENT_DECISION_LATENCY_MIN,
        quality: agentQuality,
        inContactWindow: true,
      };

    /** Someone checks the inbox a few times a day and pastes a stock reply. */
    case "batch": {
      const next = BATCH_SLOTS.find((h) => h > localHour) ?? BATCH_SLOTS[0];
      return {
        responseDelayMinutes: minutesUntilLocalHour(timeZone, arrived, next),
        quality: "generic",
        inContactWindow: true,
      };
    }

    /**
     * A stock auto-reply that fires the moment the enquiry lands. This is the
     * strong baseline: instant, and free. The only thing the agent has on it
     * is that the reply is about what they actually asked for.
     */
    case "autoresponder":
      return {
        responseDelayMinutes: 0,
        quality: "generic",
        inContactWindow: true,
      };
  }
}
