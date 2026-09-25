/**
 * pnpm eval:report
 *
 * Runs the same comparison `pnpm eval` prints and freezes it to
 * `src/lib/eval/report.generated.json`, which `/eval` imports directly.
 *
 * The page could call runEval() at request time - it is pure and takes a few
 * seconds - but a few seconds is the difference between a judge reading the
 * evidence and a judge assuming the page is broken. Committing the artefact
 * also means the numbers on the page are the numbers someone else can
 * reproduce from the seed, rather than whatever the deployment happened to
 * compute.
 *
 * The parameters are fixed here on purpose. The page quotes a specific run,
 * so the run has to be specific: 2000 leads, seed "warden-v1", 20 batches. To
 * explore other settings use `pnpm eval --count ... --seed ...`, which prints
 * and writes nothing.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runEval } from "../src/lib/eval/harness";

const COUNT = 2000;
const MASTER_SEED = "warden-v1";
const BATCH_COUNT = 20;

const OUT = fileURLToPath(
  new URL("../src/lib/eval/report.generated.json", import.meta.url),
);

const report = runEval({
  count: COUNT,
  masterSeed: MASTER_SEED,
  batchCount: BATCH_COUNT,
});

writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n", "utf8");

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

console.log(`Wrote ${OUT}`);
console.log(
  `  ${report.count} leads, seed "${report.masterSeed}", ${report.batches.length} batches`,
);
console.log(
  `  headline ${report.lift.toFixed(3)}x vs ${report.strongestBaseline}` +
    ` (${report.pointGain >= 0 ? "+" : ""}${report.pointGain.toFixed(2)} pts)`,
);
console.log(
  `  lost ${report.caseLosses} leads and ${report.batchesLost} of ${report.batches.length} batches`,
);
for (const s of report.segments) {
  const delta = (s.agentRate - s.baselineRate) * 100;
  console.log(
    `  ${s.name}: agent ${pct(s.agentRate)} vs ${pct(s.baselineRate)}` +
      ` (${delta >= 0 ? "+" : ""}${delta.toFixed(2)} pts)`,
  );
}
