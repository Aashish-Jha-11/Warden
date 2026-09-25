/**
 * pnpm eval [--count 2000] [--seed warden-v1] [--batches 20]
 *
 * Prints the measured comparison. Everything it reports is reproducible from
 * the seed alone - same seed, same numbers, any machine.
 */
import { runEval } from "../src/lib/eval/harness";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const report = runEval({
  count: Number(flag("count", "2000")),
  masterSeed: flag("seed", "warden-v1"),
  batchCount: Number(flag("batches", "20")),
});

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(66));

line();
line(`Warden eval - ${report.count} leads, seed "${report.masterSeed}"`);
line("Simulated outcomes under the model in src/lib/eval/simulator.ts.");
line("No messages were sent. This is not live traffic.");
rule();

line("Conversion by arm");
for (const a of report.arms) {
  const tag = a.arm.padEnd(14);
  const strongest = a.arm === report.strongestBaseline ? "  <- strongest baseline" : "";
  line(`  ${tag} ${pct(a.rate).padStart(7)}  (${a.conversions})${strongest}`);
}
rule();

line(`Headline, against the strongest baseline (${report.strongestBaseline})`);
line(`  lift        ${report.lift.toFixed(3)}x`);
line(`  point gain  ${report.pointGain >= 0 ? "+" : ""}${report.pointGain.toFixed(2)} points`);
rule();

line("Head to head, per lead");
line(`  agent only  ${report.caseWins}`);
line(`  baseline only ${report.caseLosses}`);
line(`  same outcome  ${report.caseTies}`);
rule();

line(`Per batch (${report.batches.length} batches)`);
line(`  batches lost  ${report.batchesLost} of ${report.batches.length}`);
for (const b of report.batches.filter((x) => !x.agentWon)) {
  line(`    batch ${String(b.index).padStart(2)}  agent ${pct(b.agentRate)} vs ${pct(b.baselineRate)}`);
}
rule();

line("By segment");
for (const s of report.segments) {
  const delta = (s.agentRate - s.baselineRate) * 100;
  const verdict = delta >= 0 ? "agent ahead" : "AGENT BEHIND";
  line(`  ${s.name.padEnd(28)} n=${String(s.count).padStart(5)}`);
  line(
    `    agent ${pct(s.agentRate).padStart(7)}   baseline ${pct(s.baselineRate).padStart(7)}` +
      `   ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pts  ${verdict}`,
  );
}
rule();

line("Sensitivity - which assumptions is the headline actually resting on?");
for (const s of report.sensitivity) {
  line(`  ${s.label.padEnd(16)} lift ${s.lift.toFixed(3)}x`);
}
line();
