import { FlaskConical } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Mono } from "@/components/ui/mono";
import type { ArmStats, EvalReport } from "@/lib/eval/harness";
import { cn } from "@/lib/utils";

/**
 * The headline block.
 *
 * One number is large and it is the lift against the STRONGEST baseline, not
 * the weakest one. Everything this arm lost sits in the same block, at a size
 * you cannot skim past: a judge who reads this card and nothing else has to
 * come away knowing the agent loses sometimes. Moving the losses further down
 * the page, or into smaller type, would make this card a sales pitch.
 */

const pct = (rate: number) => `${(rate * 100).toFixed(2)}%`;
const pts = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)} pts`;

/** Three decimals throughout: at the break-even end a lift of 0.996x must not
    be allowed to round itself up into 1.00x. */
const lift = (n: number) => `${n.toFixed(3)}x`;

const FIGURE_TONE = {
  good: "text-state-executed",
  bad: "text-state-failed",
  neutral: "text-fg",
} as const;

export interface LiftSummaryProps {
  report: EvalReport;
  /** The arm the headline is about. Derived once by the page. */
  ships: ArmStats;
  /** The arm the headline is quoted against. */
  baseline: ArmStats;
}

export function LiftSummary({ report, ships, baseline }: LiftSummaryProps) {
  const batchCount = report.batches.length;
  const perBatch = batchCount === 0 ? 0 : Math.floor(report.count / batchCount);
  const tieShare = report.count === 0 ? 0 : (report.caseTies / report.count) * 100;
  const decided = report.caseWins + report.caseLosses;
  const lostSomething = report.caseLosses > 0 || report.batchesLost > 0;

  return (
    <Card>
      {/* First thing on the page, above the number, in body type. A reader who
          stops after one sentence should already know none of this is real
          traffic. */}
      <div className="flex items-start gap-2.5 border-b border-subtle px-4 py-3">
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-faint" />
        <p className="text-sm leading-relaxed text-fg">
          These are <strong className="font-semibold">simulated</strong> outcomes under the
          outcome model in <Mono tone="muted">src/lib/eval/simulator.ts</Mono>. No message
          was ever sent to anyone: every eval arm runs the executors in{" "}
          <Mono tone="muted">src/lib/agent/actions.ts</Mono> with{" "}
          <Mono tone="muted">dryRun=true</Mono>. Nobody on this page is a real person, and
          none of these numbers are revenue.
        </p>
      </div>

      <div className="px-4 py-5">
        <p className="text-2xs font-medium text-faint uppercase">
          Lift against the strongest baseline
        </p>

        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/* The one number the whole page exists to state. Given display
              scale so a judge reads it before anything else on screen - and
              so the losses printed directly beneath it are read in the same
              glance rather than found later. */}
          <Mono className="text-5xl leading-none font-medium sm:text-6xl">
            {lift(report.lift)}
          </Mono>
          <span className="text-sm text-muted">
            <Mono tone="muted">{ships.arm}</Mono> at{" "}
            <Mono tone="muted">{pct(ships.rate)}</Mono> against{" "}
            <Mono tone="muted">{baseline.arm}</Mono> at{" "}
            <Mono tone="muted">{pct(baseline.rate)}</Mono>
          </span>
        </div>

        <p className="mt-2.5 text-sm text-muted">
          <Mono tone="muted">{report.count}</Mono> simulated leads, seed{" "}
          <Mono tone="muted">{report.masterSeed}</Mono>. Both arms saw the same leads and the
          same pre-drawn random numbers, so the gap is the decisions and not the dice.
        </p>
      </div>

      <div className="grid grid-cols-1 divide-y divide-subtle border-t border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Figure
          label="Point gain"
          value={pts(report.pointGain)}
          tone={report.pointGain >= 0 ? "good" : "bad"}
          note={`${ships.arm} conversion minus ${baseline.arm} conversion`}
        />
        <Figure
          label="Leads lost to the baseline"
          value={String(report.caseLosses)}
          tone={report.caseLosses > 0 ? "bad" : "neutral"}
          note={`of ${report.count} — converted under ${baseline.arm} and not under ${ships.arm}`}
        />
        <Figure
          label="Batches lost"
          value={String(report.batchesLost)}
          tone={report.batchesLost > 0 ? "bad" : "neutral"}
          note={
            batchCount === 0
              ? "no batches in this run"
              : `of ${batchCount} batches of ${perBatch} leads each`
          }
        />
      </div>

      <div className="border-t border-subtle px-4 py-3.5">
        {lostSomething ? (
          <p className="text-sm leading-relaxed text-fg">
            The agent is not strictly better.{" "}
            <Mono>{report.caseLosses}</Mono> of the <Mono>{report.count}</Mono> leads converted
            under <Mono>{baseline.arm}</Mono> and did not convert under{" "}
            <Mono>{ships.arm}</Mono>, and <Mono>{report.batchesLost}</Mono> of{" "}
            <Mono>{batchCount}</Mono> batches went to the baseline outright.
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-fg">
            This run lost nothing — no lead and no batch went to the baseline. That is a fact
            about seed <Mono>{report.masterSeed}</Mono>, not a property of the agent.
          </p>
        )}
        <p className="mt-2 text-sm leading-relaxed text-muted">
          <Mono tone="muted">{report.caseTies}</Mono> of <Mono tone="muted">{report.count}</Mono>{" "}
          leads — <Mono tone="muted">{tieShare.toFixed(1)}%</Mono> — had the same outcome
          whichever arm handled them. The headline is decided by the{" "}
          <Mono tone="muted">{decided}</Mono> that did not.
        </p>
      </div>
    </Card>
  );
}

function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: keyof typeof FIGURE_TONE;
}) {
  return (
    <div className="px-4 py-3.5">
      <p className="text-2xs font-medium text-faint uppercase">{label}</p>
      {/* text-2xl, not text-xs. These are the numbers the page is most tempted
          to hide, so they are sized like the claim they qualify. */}
      <Mono className={cn("mt-1.5 block text-2xl", FIGURE_TONE[tone])}>{value}</Mono>
      <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p>
    </div>
  );
}
