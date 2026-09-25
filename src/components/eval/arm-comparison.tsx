import { ListChecks, Moon, Sunrise } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty";
import { Mono } from "@/components/ui/mono";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ArmName } from "@/lib/eval/arms";
import type { ArmStats, EvalReport } from "@/lib/eval/harness";
import { cn } from "@/lib/utils";

/**
 * The comparison under the headline: every arm, then the two places an average
 * hides something - the segments and the batches.
 *
 * The bars are scaled to the best arm rather than to 100%. At a 26% conversion
 * ceiling a 0-100 axis draws every arm as the same stub and the reader compares
 * nothing; the axis is therefore stated in words beneath the bars rather than
 * left to be assumed.
 */

const pct = (rate: number) => `${(rate * 100).toFixed(2)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

/** What separates the arms is when they reply and what they say - `arms.ts`. */
const WHAT_IT_DOES: Record<ArmName, string> = {
  agent_v1:
    "Personalised, but treats the contact window as absolute: an enquiry at 23:40 waits for 09:00.",
  agent_v2: "Personalised, and answers an inbound immediately whatever the local hour.",
  batch: "A person opens the enquiry inbox at 10:00, 14:00 and 18:00 and pastes a stock reply.",
  autoresponder: "A stock auto-reply that fires the second the enquiry lands. Instant, and free.",
};

/**
 * agent_v1 is ours too, and it is the arm that loses. Both agent arms share one
 * colour family so that stays legible instead of being quietly recoloured into
 * the baselines.
 */
const AGENT_ARMS: ReadonlySet<ArmName> = new Set<ArmName>(["agent_v1", "agent_v2"]);

const OVERNIGHT = /overnight/i;

export interface ArmComparisonProps {
  report: EvalReport;
  /** The arm that ships, resolved once by the page. */
  ships: ArmStats;
  /** The strongest baseline - what the headline is quoted against. */
  baseline: ArmStats;
}

export function ArmComparison({ report, ships, baseline }: ArmComparisonProps) {
  const best = report.arms.reduce((m, a) => Math.max(m, a.rate), 0);
  const lostBatches = report.batches.filter((b) => !b.agentWon);

  // Our own earlier arm scoring under the baseline is the most useful thing on
  // this card, so it is said in words rather than left to bar lengths.
  const ourArmsBehind = report.arms.filter(
    (a) => AGENT_ARMS.has(a.arm) && a.arm !== ships.arm && a.rate < baseline.rate,
  );

  return (
    <section className="space-y-4">
      <Card>
        <CardHeader className="block">
          <CardTitle>Conversion by arm</CardTitle>
          <CardDescription>
            Same leads, same scoring function, same guardrails, same pre-drawn random
            numbers. The only difference between these four is when they reply and what
            they say.
          </CardDescription>
        </CardHeader>

        {report.arms.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No arms in this run"
            description="The report was generated with no arms, which means the harness did not run. Regenerate it before reading anything else on this page."
          />
        ) : (
          <div className="px-4 py-3.5">
            <ul className="space-y-3.5">
              {report.arms.map((arm) => (
                <ArmBar
                  key={arm.arm}
                  arm={arm}
                  total={report.count}
                  share={best === 0 ? 0 : arm.rate / best}
                  ships={arm.arm === ships.arm}
                  strongestBaseline={arm.arm === baseline.arm}
                />
              ))}
            </ul>

            <p className="mt-4 border-t border-subtle pt-3 text-xs leading-relaxed text-muted">
              Bars are scaled to the highest arm — full width is{" "}
              <Mono tone="muted">{pct(best)}</Mono>, not <Mono tone="muted">100%</Mono>.
              {ourArmsBehind.length > 0 ? (
                <>
                  {" "}
                  {ourArmsBehind.map((a) => (
                    <Mono key={a.arm} tone="muted">
                      {a.arm}
                    </Mono>
                  ))}{" "}
                  is one of ours and it scores under the baseline at{" "}
                  <Mono tone="muted">{pct(baseline.rate)}</Mono>. That arm is in the table
                  because it is the one the eval caught, not because it flatters anything.
                </>
              ) : null}
            </p>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader className="block">
          <CardTitle>By segment</CardTitle>
          <CardDescription>
            <Mono tone="muted">{ships.arm}</Mono> against{" "}
            <Mono tone="muted">{baseline.arm}</Mono>, split by whether the enquiry landed
            inside the contact window. An average over both can be carried by one of them.
          </CardDescription>
        </CardHeader>

        {report.segments.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No segments"
            description="This run recorded no segment split, so the average is unaudited. Regenerate the report."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Segment</TH>
                <TH numeric>Leads</TH>
                <TH numeric>{ships.arm}</TH>
                <TH numeric>{baseline.arm}</TH>
                <TH numeric>Delta</TH>
              </TR>
            </THead>
            <TBody>
              {report.segments.map((s) => {
                const delta = (s.agentRate - s.baselineRate) * 100;
                const overnight = OVERNIGHT.test(s.name);
                const Icon = overnight ? Moon : Sunrise;
                return (
                  <TR key={s.name}>
                    <TD>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />
                        {s.name}
                      </span>
                    </TD>
                    <TD numeric>
                      <Mono>{s.count}</Mono>
                    </TD>
                    <TD numeric>
                      <Mono>{pct(s.agentRate)}</Mono>
                    </TD>
                    <TD numeric>
                      <Mono tone="muted">{pct(s.baselineRate)}</Mono>
                    </TD>
                    <TD numeric>
                      <Mono
                        className={
                          delta >= 0 ? "text-state-executed" : "text-state-failed"
                        }
                      >
                        {signed(delta)} pts
                      </Mono>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader className="block">
          <CardTitle>By batch</CardTitle>
          <CardDescription>
            The run split into <Mono tone="muted">{report.batches.length}</Mono> batches, so
            &ldquo;it wins on average&rdquo; can be checked against &ldquo;it wins
            often&rdquo;. A lost batch is one where{" "}
            <Mono tone="muted">{baseline.arm}</Mono> converted at least as many.
          </CardDescription>
        </CardHeader>

        {report.batches.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No batches"
            description="This run was not split into batches, so there is nothing to check the average against."
          />
        ) : (
          <>
            <div className="px-4 py-3.5">
              <ol className="grid grid-cols-10 gap-1">
                {report.batches.map((b) => (
                  <li
                    key={b.index}
                    title={`batch ${b.index}: ${pct(b.agentRate)} vs ${pct(b.baselineRate)}`}
                    className={cn(
                      "flex h-7 items-center justify-center rounded-xs border",
                      b.agentWon
                        ? "border-subtle bg-raised"
                        : "border-state-failed/60 bg-state-failed/14",
                    )}
                  >
                    <Mono
                      className={cn(
                        "text-2xs",
                        b.agentWon ? "text-muted" : "text-state-failed",
                      )}
                    >
                      {b.index}
                    </Mono>
                  </li>
                ))}
              </ol>
              <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2.5 rounded-xs border border-subtle bg-raised" />
                  agent ahead — <Mono tone="muted">
                    {report.batches.length - report.batchesLost}
                  </Mono>
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2.5 rounded-xs border border-state-failed/60 bg-state-failed/14"
                  />
                  lost to <Mono tone="muted">{baseline.arm}</Mono> —{" "}
                  <Mono tone="muted">{report.batchesLost}</Mono>
                </span>
              </p>
            </div>

            <div className="border-t border-subtle">
              {lostBatches.length === 0 ? (
                <EmptyState
                  icon={ListChecks}
                  title="No batch went to the baseline"
                  description="Every batch in this run went to the agent. That is a fact about this seed, not a property of the agent — a different seed will lose some."
                />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Batch lost</TH>
                      <TH numeric>{ships.arm}</TH>
                      <TH numeric>{baseline.arm}</TH>
                      <TH numeric>Delta</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {lostBatches.map((b) => (
                      <TR key={b.index}>
                        <TD>
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            <Badge tone="failed" label="lost" pip={false} />
                            <Mono tone="muted">#{b.index}</Mono>
                          </span>
                        </TD>
                        <TD numeric>
                          <Mono>{pct(b.agentRate)}</Mono>
                        </TD>
                        <TD numeric>
                          <Mono tone="muted">{pct(b.baselineRate)}</Mono>
                        </TD>
                        <TD numeric>
                          <Mono className="text-state-failed">
                            {signed((b.agentRate - b.baselineRate) * 100)} pts
                          </Mono>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          </>
        )}
      </Card>
    </section>
  );
}

function ArmBar({
  arm,
  total,
  share,
  ships,
  strongestBaseline,
}: {
  arm: ArmStats;
  total: number;
  /** Width as a fraction of the best arm, not of 100%. */
  share: number;
  ships: boolean;
  strongestBaseline: boolean;
}) {
  const ours = AGENT_ARMS.has(arm.arm);
  const fill = ships
    ? "bg-accent"
    : ours
      ? "bg-accent/35"
      : strongestBaseline
        ? "bg-strong"
        : "bg-strong/45";

  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Mono>{arm.arm}</Mono>
          {ships ? <Badge tone="accent" label="ships" pip={false} /> : null}
          {strongestBaseline ? (
            <Badge tone="quiet" label="strongest baseline" pip={false} />
          ) : null}
        </span>
        <span className="whitespace-nowrap">
          <Mono>{pct(arm.rate)}</Mono>{" "}
          <Mono tone="faint" className="text-xs">
            {arm.conversions}/{total}
          </Mono>
        </span>
      </div>

      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-xs bg-sunken">
        <div
          className={cn("h-full rounded-xs", fill)}
          style={{ width: `${(share * 100).toFixed(2)}%` }}
        />
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-muted">{WHAT_IT_DOES[arm.arm]}</p>
    </li>
  );
}
