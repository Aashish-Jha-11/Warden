import type { Metadata } from "next";
import { GitCommitHorizontal, ScrollText } from "lucide-react";

import { ArmComparison } from "@/components/eval/arm-comparison";
import { LiftSummary } from "@/components/eval/lift-summary";
import { Sensitivity } from "@/components/eval/sensitivity";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty";
import { Mono } from "@/components/ui/mono";
import type { ArmStats, EvalReport } from "@/lib/eval/harness";
import generated from "@/lib/eval/report.generated.json";

/**
 * The evidence page.
 *
 * It reads a committed artefact rather than calling runEval() at request time.
 * The eval is pure and takes a few seconds, and a few seconds is the difference
 * between a reader looking at the numbers and a reader assuming the page is
 * broken. Freezing it also means the figures here are the figures anyone else
 * can reproduce from the seed - `pnpm eval:report` - rather than whatever this
 * deployment happened to compute.
 *
 * Nothing on this page is rounded in the agent's favour and nothing it lost is
 * moved below a fold. That is the entire point of it.
 */

export const metadata: Metadata = {
  title: "Evidence",
};

/**
 * The JSON module widens `arm` to `string`, so the shape is re-asserted once
 * here against the type the harness wrote it with instead of every component
 * re-deriving it.
 */
const report = generated as EvalReport;

export default function EvalPage() {
  const baseline = report.arms.find((a) => a.arm === report.strongestBaseline);
  const ships = baseline ? headlineArm(report, baseline) : undefined;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Evidence</h1>
          <p className="mt-1 text-sm text-muted">
            What the agent is worth against the baselines a business already has —
            including the segments, batches and assumptions where it is worth less.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <Mono copy className="text-xs">
            pnpm eval:report
          </Mono>
          <p className="text-2xs text-faint">regenerates every number on this page</p>
        </div>
      </header>

      {baseline && ships ? (
        <>
          <LiftSummary report={report} ships={ships} baseline={baseline} />
          <ArmComparison report={report} ships={ships} baseline={baseline} />
          <Sensitivity report={report} ships={ships} baseline={baseline} />
          <WhatChanged report={report} baseline={baseline} />
        </>
      ) : (
        <Card>
          <EmptyState
            icon={ScrollText}
            title="No report to read"
            description="src/lib/eval/report.generated.json does not name an arm and a strongest baseline, so there is nothing here that could honestly be called evidence. Run pnpm eval:report and reload."
          />
        </Card>
      )}
    </div>
  );
}

/**
 * The finding that changed the code.
 *
 * Kept on the page rather than in the README because a guardrail that exists
 * for a measured reason is the claim this product is making, and the reason
 * should sit next to the measurement.
 */
function WhatChanged({ report, baseline }: { report: EvalReport; baseline: ArmStats }) {
  const overnight = report.segments.find((s) => /overnight/i.test(s.name));
  const delta = overnight ? (overnight.agentRate - overnight.baselineRate) * 100 : null;

  return (
    <Card>
      <CardHeader className="block">
        <div className="flex items-center gap-2">
          <GitCommitHorizontal aria-hidden className="size-4 shrink-0 text-faint" />
          <CardTitle>What this measurement changed</CardTitle>
        </div>
      </CardHeader>

      <div className="space-y-3 px-4 py-3.5 text-sm leading-relaxed text-muted">
        <p>
          The first version of the agent — <Mono tone="muted">agent_v1</Mono>, still in the
          table above — treated its contact window as absolute, so an enquiry that arrived
          at 23:40 waited until 09:00 for a reply. That eval had it losing the overnight
          segment to a plain autoresponder by <Mono tone="muted">5.6</Mono> points. That run
          is not this report; it is the reason this report exists.
        </p>
        <p>
          The fix was not to special-case the metric. A contact window exists to stop us{" "}
          <em className="text-fg not-italic">interrupting</em> people, and answering
          someone who messaged ninety seconds ago is not interrupting them — which is also
          why India&rsquo;s DLT regime governs registered template content rather than
          banning replies. So <Mono tone="muted">Policy</Mono> gained{" "}
          <Mono tone="muted">inboundReplyGraceMinutes</Mono>, and{" "}
          <Mono tone="muted">policy.ts</Mono> checks it before it checks the hour: a reply
          inside that grace window is exempt, while proactive follow-ups still wait.
        </p>
        {overnight && delta !== null ? (
          <p>
            Under this report the overnight segment —{" "}
            <Mono tone="muted">{overnight.count}</Mono> of{" "}
            <Mono tone="muted">{report.count}</Mono> leads — runs at{" "}
            <Mono tone="muted">{(overnight.agentRate * 100).toFixed(2)}%</Mono> against{" "}
            <Mono tone="muted">{(overnight.baselineRate * 100).toFixed(2)}%</Mono> for{" "}
            <Mono tone="muted">{baseline.arm}</Mono>:{" "}
            <Mono className={delta >= 0 ? "text-state-executed" : "text-state-failed"}>
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(2)} pts
            </Mono>
            . The segment the agent used to lose is now the one it wins by most.
          </p>
        ) : null}
        <p>
          Correcting it surfaced a second thing, and that one went against us: the
          autoresponder was being penalised for replying at 3am while the agent was about
          to be exempted for identical behaviour. Both are reactive. Fixing that made the
          headline smaller, and the smaller number is the one at the top of this page.
        </p>
      </div>
    </Card>
  );
}

/**
 * Which arm the report is about.
 *
 * The harness keeps that choice private, so it is recovered from the number it
 * published: the headline lift is exactly the shipping arm's rate over the
 * strongest baseline's. Deriving it means this page cannot quietly drift out of
 * agreement with the report it is rendering.
 */
function headlineArm(r: EvalReport, baseline: ArmStats): ArmStats | undefined {
  if (baseline.rate <= 0) return undefined;
  return r.arms.find((a) => Math.abs(a.rate / baseline.rate - r.lift) < 1e-9);
}
