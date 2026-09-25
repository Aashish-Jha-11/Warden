import type { LeadPayload, LeadSource } from "@/lib/domain/lead";
import { rngFor } from "@/lib/agent/seed";

/**
 * Seeded lead generator.
 *
 * Same seed, same leads, on any machine - so a judge can reproduce a reported
 * number rather than take it on trust.
 */

const SERVICES = [
  "IELTS coaching",
  "NEET repeater batch",
  "root canal",
  "teeth cleaning",
  "personal training",
  "2BHK in Kharadi",
  "bridal makeup",
  "GST filing",
  "driving lessons",
  "kitchen interiors",
] as const;

const CITIES = ["Pune", "Indore", "Bengaluru", "Nagpur", "Surat", "Jaipur"] as const;

const SOURCES: LeadSource[] = [
  "whatsapp",
  "website_form",
  "google_ads",
  "justdial",
  "instagram",
  "missed_call",
];

const MESSAGES = [
  "hi, fees kitni hai?",
  "Is the weekend batch still open? I work full time so weekdays are hard for me.",
  "price?",
  "Need this done before the 30th. Can you confirm availability and total cost?",
  "Saw your ad. Do you have anything in the evening slot after 7pm?",
  "hello",
  "My daughter is in class 12 and we are looking at the repeater batch for next year. What is the schedule and what does it cover?",
  "do you do home visit",
] as const;

/**
 * Enquiries are not uniform across the day. Weight by hour so the overnight
 * bucket is realistically small - otherwise the overnight finding would be an
 * artifact of pretending 4am is as busy as 7pm.
 */
const HOUR_WEIGHTS = [
  0.4, 0.3, 0.2, 0.2, 0.2, 0.4, 0.8, 1.4, 2.2, 3.0, 3.4, 3.2, 2.8, 2.6, 2.8,
  3.0, 3.4, 4.0, 4.6, 4.4, 3.4, 2.4, 1.4, 0.8,
];

export type Fixture = {
  externalId: string;
  seed: string;
  timezone: string;
  contactName: string;
  payload: LeadPayload;
};

export function generateLeads(count: number, masterSeed = "warden-v1"): Fixture[] {
  const rnd = rngFor(masterSeed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const leads: Fixture[] = [];
  for (let i = 0; i < count; i++) {
    const hour = weightedHour(rnd);
    const minute = Math.floor(rnd() * 60);

    // A fixed Wednesday, so weekday/weekend behaviour is not left to chance.
    const arrived = new Date(Date.UTC(2026, 8, 23, 0, 0, 0));
    arrived.setUTCMinutes(arrived.getUTCMinutes() + hour * 60 + minute - 330); // IST offset

    const hasService = rnd() > 0.25;
    leads.push({
      externalId: `lead-${String(i).padStart(4, "0")}`,
      seed: `${masterSeed}:${i}`,
      timezone: "Asia/Kolkata",
      contactName: pick(["Asha", "Rohit", "Meera", "Imran", "Sneha", "Vikram", "Fatima"]),
      payload: {
        source: pick(SOURCES),
        message: pick(MESSAGES),
        service: hasService ? pick(SERVICES) : null,
        city: pick(CITIES),
        arrivedAt: arrived.toISOString(),
        urgency: pick(["browsing", "comparing", "ready"] as const),
        budgetSignal: pick(["none", "low", "mid", "high"] as const),
      },
    });
  }
  return leads;
}

function weightedHour(rnd: () => number): number {
  const total = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let h = 0; h < HOUR_WEIGHTS.length; h++) {
    r -= HOUR_WEIGHTS[h];
    if (r <= 0) return h;
  }
  return 12;
}
