import { describe, expect, it } from "vitest";
import { runEval } from "./harness";
import { handleAs } from "./arms";
import { conversionProbability, MODEL } from "./simulator";
import { generateLeads } from "./fixtures";

describe("reproducibility", () => {
  it("gives the same numbers for the same seed", () => {
    const a = runEval({ count: 400, masterSeed: "t", batchCount: 4 });
    const b = runEval({ count: 400, masterSeed: "t", batchCount: 4 });
    expect(b.lift).toBe(a.lift);
    expect(b.caseWins).toBe(a.caseWins);
    expect(b.arms).toEqual(a.arms);
  });

  it("gives different numbers for a different seed", () => {
    const a = runEval({ count: 400, masterSeed: "t", batchCount: 4 });
    const b = runEval({ count: 400, masterSeed: "u", batchCount: 4 });
    expect(b.arms).not.toEqual(a.arms);
  });

  it("generates the same leads for the same seed", () => {
    expect(generateLeads(20, "x")).toEqual(generateLeads(20, "x"));
  });
});

describe("the comparison is not rigged", () => {
  it("quotes the headline against the strongest baseline, not the weakest", () => {
    const r = runEval({ count: 1000, masterSeed: "t", batchCount: 10 });
    const baselines = r.arms.filter((a) => a.arm === "batch" || a.arm === "autoresponder");
    const best = Math.max(...baselines.map((b) => b.rate));
    expect(r.arms.find((a) => a.arm === r.strongestBaseline)!.rate).toBe(best);
  });

  it("can actually lose, which is what makes a win mean anything", () => {
    // If the agent structurally cannot lose a lead, the eval proves nothing.
    // Misfires are what make the comparison non-trivial.
    const r = runEval({ count: 2000, masterSeed: "warden-v1", batchCount: 20 });
    expect(r.caseLosses).toBeGreaterThan(0);
  });

  it("reports losses rather than smoothing them away", () => {
    const r = runEval({ count: 2000, masterSeed: "warden-v1", batchCount: 20 });
    expect(r.batchesLost).toBe(r.batches.filter((b) => !b.agentWon).length);
  });

  it("stops being worth it once personalisation misfires often enough", () => {
    // The threshold that decides whether any of this should ship. If the agent
    // cannot read an enquiry correctly more often than this, use a template.
    const r = runEval({ count: 2000, masterSeed: "warden-v1", batchCount: 20 });
    const at40 = r.sensitivity.find((s) => s.label === "misfire=40%")!;
    const at0 = r.sensitivity.find((s) => s.label === "misfire=0%")!;
    expect(at0.lift).toBeGreaterThan(1.1);
    expect(at40.lift).toBeLessThan(1.02);
  });
});

describe("common random numbers", () => {
  it("holds the misfire draw steady across agent arms", () => {
    // v1 and v2 differ only in timing. If they drew misfires independently,
    // comparing them would be measuring noise.
    const [lead] = generateLeads(1, "t");
    const draw = 0.05; // below the 12% misfire rate
    const v1 = handleAs("agent_v1", lead.payload, lead.timezone, draw);
    const v2 = handleAs("agent_v2", lead.payload, lead.timezone, draw);
    expect(v1.quality).toBe("misfire");
    expect(v2.quality).toBe("misfire");
  });

  it("makes a misfired reply worse than the generic template it replaced", () => {
    const [lead] = generateLeads(1, "t");
    const misfired = handleAs("agent_v2", lead.payload, lead.timezone, 0.0);
    const generic = handleAs("autoresponder", lead.payload, lead.timezone, 0.0);
    expect(misfired.quality).toBe("misfire");
    expect(conversionProbability(lead.payload, misfired, MODEL)).toBeLessThan(
      conversionProbability(lead.payload, generic, MODEL),
    );
  });
});
