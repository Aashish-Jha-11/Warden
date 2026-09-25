import { rngFor } from "@/lib/agent/seed";
import { handleAs, WINDOW, type ArmName } from "./arms";
import { generateLeads, type Fixture } from "./fixtures";
import { conversionProbability, converts, MODEL, type OutcomeModel } from "./simulator";
import { localHourFraction } from "./time";

/**
 * The comparison.
 *
 * Three things here are doing the real work, and all three are the difference
 * between a measurement and a demo:
 *
 *  1. Common random numbers. One uniform draw per lead, shared by every arm.
 *     A lead that was always going to convert converts everywhere; what is
 *     left is the decisions.
 *  2. The strongest baseline, not the most flattering one. The headline lift
 *     is quoted against whichever baseline scored highest.
 *  3. Losses are reported, by batch and by segment. The overnight segment is
 *     one the agent loses, and it stays in the output.
 */

const BASELINES: ArmName[] = ["batch", "autoresponder"];
const AGENTS: ArmName[] = ["agent_v1", "agent_v2"];
/** The arm we ship, and the one the headline is about. */
const HEADLINE_ARM: ArmName = "agent_v2";

export type ArmStats = { arm: ArmName; conversions: number; rate: number };

export type EvalReport = {
  count: number;
  masterSeed: string;
  arms: ArmStats[];
  strongestBaseline: ArmName;
  lift: number;
  pointGain: number;
  caseWins: number;
  caseLosses: number;
  caseTies: number;
  batches: Array<{ index: number; agentRate: number; baselineRate: number; agentWon: boolean }>;
  batchesLost: number;
  segments: Array<{ name: string; count: number; agentRate: number; baselineRate: number }>;
  sensitivity: Array<{ label: string; lift: number }>;
};

export function runEval(opts: {
  count?: number;
  masterSeed?: string;
  batchCount?: number;
}): EvalReport {
  const count = opts.count ?? 2000;
  const masterSeed = opts.masterSeed ?? "warden-v1";
  const batchCount = opts.batchCount ?? 20;

  const leads = generateLeads(count, masterSeed);

  // Two draws per lead, both taken before any arm runs. This is the whole
  // trick: the outcome draw decides whether a lead handled identically well
  // converts, and the misfire draw decides whether the agent's personalisation
  // lands. Both are shared across arms, so neither is luck.
  const draws = leads.map((l) => rngFor(`${l.seed}:outcome`)());
  const misfireDraws = leads.map((l) => rngFor(`${l.seed}:misfire`)());

  const outcomes = simulate(leads, draws, misfireDraws, MODEL);

  const arms: ArmStats[] = [...AGENTS, ...BASELINES].map((arm) => {
    const conversions = outcomes[arm].filter(Boolean).length;
    return { arm, conversions, rate: conversions / count };
  });

  const baselineStats = arms.filter((a) => BASELINES.includes(a.arm));
  const strongest = baselineStats.reduce((a, b) => (b.rate > a.rate ? b : a));
  const strongestBaseline = strongest.arm;
  const agentRate = arms.find((a) => a.arm === HEADLINE_ARM)!.rate;

  // Per-case head to head.
  let caseWins = 0;
  let caseLosses = 0;
  let caseTies = 0;
  for (let i = 0; i < count; i++) {
    const a = outcomes[HEADLINE_ARM][i];
    const b = outcomes[strongestBaseline][i];
    if (a && !b) caseWins++;
    else if (!a && b) caseLosses++;
    else caseTies++;
  }

  // Per-batch, so "it wins on average" can be checked against "it wins often".
  const perBatch = Math.floor(count / batchCount);
  const batches = [];
  for (let b = 0; b < batchCount; b++) {
    const lo = b * perBatch;
    const hi = b === batchCount - 1 ? count : lo + perBatch;
    const rate = (xs: boolean[]) =>
      xs.slice(lo, hi).filter(Boolean).length / Math.max(1, hi - lo);
    const agentRateB = rate(outcomes[HEADLINE_ARM]);
    const baselineRateB = rate(outcomes[strongestBaseline]);
    batches.push({
      index: b,
      agentRate: agentRateB,
      baselineRate: baselineRateB,
      agentWon: agentRateB >= baselineRateB,
    });
  }

  // Segments. Overnight is the one the agent is expected to lose.
  const overnightIdx: number[] = [];
  const daytimeIdx: number[] = [];
  leads.forEach((l, i) => {
    const h = localHourFraction(l.timezone, new Date(l.payload.arrivedAt)) ?? 12;
    (h >= WINDOW.start && h < WINDOW.end ? daytimeIdx : overnightIdx).push(i);
  });
  const segmentRate = (idx: number[], xs: boolean[]) =>
    idx.length === 0 ? 0 : idx.filter((i) => xs[i]).length / idx.length;

  const segments = [
    {
      name: `in-window (${WINDOW.start}:00-${WINDOW.end}:00)`,
      count: daytimeIdx.length,
      agentRate: segmentRate(daytimeIdx, outcomes[HEADLINE_ARM]),
      baselineRate: segmentRate(daytimeIdx, outcomes[strongestBaseline]),
    },
    {
      name: "overnight",
      count: overnightIdx.length,
      agentRate: segmentRate(overnightIdx, outcomes[HEADLINE_ARM]),
      baselineRate: segmentRate(overnightIdx, outcomes[strongestBaseline]),
    },
  ];

  // Both constants the headline leans on, swept independently. Once both arms
  // answer instantly the decay constant barely matters and the personalisation
  // multiplier carries the result - so that is the one to be honest about.
  const sweep = (label: string, model: OutcomeModel) => {
    const o = simulate(leads, draws, misfireDraws, model);
    const a = o[HEADLINE_ARM].filter(Boolean).length / count;
    const b = o[strongestBaseline].filter(Boolean).length / count;
    return { label, lift: b === 0 ? 0 : a / b };
  };
  const sensitivity = [
    ...[0.7, 1.0, 1.3].map((f) =>
      sweep(`TAU=${Math.round(MODEL.latencyTauMinutes * f)}min`, {
        ...MODEL,
        latencyTauMinutes: MODEL.latencyTauMinutes * f,
      }),
    ),
    ...[0.65, 0.78, 0.9].map((g) =>
      sweep(`generic=${g.toFixed(2)}`, { ...MODEL, genericMultiplier: g }),
    ),
    // The one that decides whether any of this is worth doing: how often can
    // the agent misread the enquiry before a boring template beats it?
    ...[0.0, 0.12, 0.25, 0.4].map((r) =>
      sweep(`misfire=${(r * 100).toFixed(0)}%`, {
        ...MODEL,
        personalisationMisfireRate: r,
      }),
    ),
  ];

  return {
    count,
    masterSeed,
    arms,
    strongestBaseline,
    lift: strongest.rate === 0 ? 0 : agentRate / strongest.rate,
    pointGain: (agentRate - strongest.rate) * 100,
    caseWins,
    caseLosses,
    caseTies,
    batches,
    batchesLost: batches.filter((b) => !b.agentWon).length,
    segments,
    sensitivity,
  };
}

function simulate(
  leads: Fixture[],
  draws: number[],
  misfireDraws: number[],
  model: OutcomeModel,
): Record<ArmName, boolean[]> {
  const out: Record<ArmName, boolean[]> = {
    agent_v1: [],
    agent_v2: [],
    batch: [],
    autoresponder: [],
  };
  leads.forEach((lead, i) => {
    for (const arm of [...AGENTS, ...BASELINES]) {
      const handling = handleAs(
        arm,
        lead.payload,
        lead.timezone,
        misfireDraws[i],
        model.personalisationMisfireRate,
      );
      const p = conversionProbability(lead.payload, handling, model);
      out[arm].push(converts(draws[i], p));
    }
  });
  return out;
}
