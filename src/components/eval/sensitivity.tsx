import { SlidersHorizontal, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty";
import { Mono } from "@/components/ui/mono";
import type { ArmStats, EvalReport } from "@/lib/eval/harness";
import { cn } from "@/lib/utils";

/**
 * The sweep: the whole comparison re-run with one constant moved and nothing
 * else, so the reader can see which assumption the headline is actually
 * resting on.
 *
 * Split into two cards on purpose. TAU and the template penalty ask "is the
 * model roughly right?"; misfire asks "should this ship at all?" - and only one
 * of those has an answer that ends the conversation. Three decimals
 * everywhere, because a lift of 0.996x must never be allowed to round itself up
 * into 1.00x on the one row where the sign matters.
 */

const lift = (n: number) => `${n.toFixed(3)}x`;

/** A sweep row's group is the constant it moved: `misfire=40%` -> `misfire`. */
const MISFIRE = "misfire";

type Sweep = EvalReport["sensitivity"][number];

const GROUPS: Record<string, { title: string; question: string }> = {
  TAU: {
    title: "Latency decay",
    question:
      "How fast does an enquiry go cold while it waits? Both the agent and the autoresponder answer within seconds, so almost nothing here depends on where this constant sits — which is exactly why it is not the interesting one.",
  },
  generic: {
    title: "Template penalty",
    question:
      "How much worse is a stock template than a reply that names their service and city? This is the assumption the headline leans on hardest: the agent's entire edge over an instant autoresponder is that the reply is about what they actually asked for.",
  },
  [MISFIRE]: {
    title: "Misread rate",
    question:
      "How often can the agent misread the enquiry before a boring template beats it? Personalisation is not free — a reply that gets the service, the language or the register wrong lands worse than a neutral template, because it proves nobody was paying attention.",
  },
};

export interface SensitivityProps {
  report: EvalReport;
  ships: ArmStats;
  baseline: ArmStats;
}

export function Sensitivity({ report, ships, baseline }: SensitivityProps) {
  const rows = report.sensitivity;
  const misfire = rows.filter((r) => groupKey(r) === MISFIRE);
  const others = rows.filter((r) => groupKey(r) !== MISFIRE);

  // One scale across every sweep in the report, so a bar in one card means the
  // same thing as a bar in the other.
  const max = rows.reduce((m, r) => Math.max(m, r.lift), 1);

  // The row where the agent stops being worth more than the template it
  // replaces. Derived, not written down: if the sweep is re-run with a different
  // range this follows it.
  const breakEven = misfire.find((r) => r.lift < 1);

  return (
    <section className="space-y-4">
      <Card>
        <CardHeader className="block">
          <CardTitle>Sensitivity — which assumptions is this resting on?</CardTitle>
          <CardDescription>
            Each row is the entire comparison re-run with one constant of the outcome
            model moved and everything else held: same leads, same draws, same arms. A
            lift that only survives one setting of a constant is not a finding.
          </CardDescription>
        </CardHeader>

        {others.length === 0 ? (
          <EmptyState
            icon={SlidersHorizontal}
            title="No sweep recorded"
            description="This report contains no sensitivity sweep, so nothing on this page has been stress-tested. Regenerate it before quoting the headline."
          />
        ) : (
          <div className="divide-y divide-subtle">
            {groupsOf(others).map(([key, groupRows]) => (
              <SweepGroup
                key={key}
                groupKey={key}
                rows={groupRows}
                max={max}
                modelled={report.lift}
              />
            ))}
          </div>
        )}
      </Card>

      <Card className="border-strong">
        <CardHeader className="block">
          <div className="flex items-center gap-2">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-state-failed" />
            <CardTitle>The one that decides whether to ship</CardTitle>
          </div>
          <CardDescription>{GROUPS[MISFIRE].question}</CardDescription>
        </CardHeader>

        {misfire.length === 0 ? (
          <EmptyState
            icon={SlidersHorizontal}
            title="No misread sweep"
            description="The sweep that decides whether this system is worth running at all is missing from the report. Regenerate it."
          />
        ) : (
          <>
            <ul className="divide-y divide-subtle">
              {misfire.map((row) => {
                const lost = row.lift < 1;
                return (
                  <li key={row.label} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Mono>{setting(row)}</Mono>
                        <span className="text-xs text-muted">of enquiries misread</span>
                        {isModelled(row, report.lift) ? (
                          <Badge tone="accent" label="as modelled" pip={false} />
                        ) : null}
                        {breakEven && row.label === breakEven.label ? (
                          <Badge tone="failed" label="break-even" pip={false} />
                        ) : null}
                      </span>
                      <Mono
                        className={cn(
                          "text-base",
                          lost ? "text-state-failed" : "text-fg",
                        )}
                      >
                        {lift(row.lift)}
                      </Mono>
                    </div>
                    <SweepBar className="mt-2" value={row.lift} max={max} />
                  </li>
                );
              })}
            </ul>

            <div className="border-t border-subtle px-4 py-4">
              {breakEven ? (
                <>
                  {/* The single most useful sentence in the project, so it is set
                      at the size of a claim and not as a caption. It states the
                      finding rather than issuing an instruction - a reader who
                      is told "do not ship it" has to take our word for it, and a
                      reader who is told a plain template wins does not. */}
                  <p className="text-lg leading-snug font-semibold text-fg">
                    If the agent misreads more than about{" "}
                    <Mono>{setting(breakEven)}</Mono> of enquiries, a plain template beats
                    it.
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    At <Mono tone="muted">{setting(breakEven)}</Mono> the lift is{" "}
                    <Mono tone="muted">{lift(breakEven.lift)}</Mono> — under{" "}
                    <Mono tone="muted">1.000x</Mono>, which means{" "}
                    <Mono tone="muted">{baseline.arm}</Mono>, a stock template that costs
                    nothing and needs no approval queue, converts more of the same leads
                    than <Mono tone="muted">{ships.arm}</Mono> does. Every other number on
                    this page is downstream of this one. It is also the one number here
                    that a simulation cannot settle: it has to be measured on real replies,
                    which is what the case trace and the audit log are for.
                  </p>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-fg">
                  This sweep never crosses <Mono>1.000x</Mono> — every misread rate tested
                  still beats <Mono>{baseline.arm}</Mono>. That is a statement about the
                  range that was swept, not a licence: widen the sweep until it breaks,
                  because the crossing point is the number that decides whether this ships.
                </p>
              )}
            </div>
          </>
        )}
      </Card>
    </section>
  );
}

function SweepGroup({
  groupKey,
  rows,
  max,
  modelled,
}: {
  groupKey: string;
  rows: Sweep[];
  max: number;
  /** The headline lift, which identifies the row the model actually uses. */
  modelled: number;
}) {
  const meta = GROUPS[groupKey];
  const lo = rows.reduce((m, r) => Math.min(m, r.lift), Number.POSITIVE_INFINITY);
  const hi = rows.reduce((m, r) => Math.max(m, r.lift), 0);

  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-fg">{meta?.title ?? groupKey}</h3>
        {/* The swing is the whole point of a sweep: it says how much of the
            headline this constant is carrying. */}
        <span className="text-xs text-muted">
          swing <Mono tone="muted">{(hi - lo).toFixed(3)}x</Mono> across{" "}
          <Mono tone="muted">{rows.length}</Mono> settings
        </span>
      </div>

      {meta ? (
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{meta.question}</p>
      ) : null}

      <ul className="mt-3 space-y-2.5">
        {rows.map((row) => (
          <li key={row.label}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="flex flex-wrap items-center gap-2">
                <Mono tone="muted">{row.label}</Mono>
                {isModelled(row, modelled) ? (
                  <Badge tone="accent" label="as modelled" pip={false} />
                ) : null}
              </span>
              <Mono className={row.lift < 1 ? "text-state-failed" : undefined}>
                {lift(row.lift)}
              </Mono>
            </div>
            <SweepBar className="mt-1.5" value={row.lift} max={max} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SweepBar({
  value,
  max,
  className,
}: {
  /** The lift this row scored. */
  value: number;
  max: number;
  className?: string;
}) {
  const width = max <= 0 ? 0 : clampPercent((value / max) * 100);
  const breakEven = max <= 0 ? 0 : clampPercent((1 / max) * 100);

  return (
    <div className={cn("relative h-2 w-full rounded-xs bg-sunken", className)}>
      <div
        className={cn("h-full rounded-xs", value < 1 ? "bg-state-failed" : "bg-accent")}
        style={{ width: `${width.toFixed(2)}%` }}
      />
      {/* The axis starts at zero, so the only gridline worth drawing is 1.000x:
          left of it the agent is worth less than the template it replaces. */}
      <span
        aria-hidden
        className="absolute -top-1 -bottom-1 w-px bg-strong"
        style={{ left: `${breakEven.toFixed(2)}%` }}
      />
    </div>
  );
}

function groupKey(row: Sweep): string {
  const [key] = row.label.split("=");
  return key ?? row.label;
}

/** The setting itself: `misfire=40%` -> `40%`. */
function setting(row: Sweep): string {
  const parts = row.label.split("=");
  return parts.length > 1 ? parts.slice(1).join("=") : row.label;
}

/** The row the report was actually generated with scores exactly the headline. */
function isModelled(row: Sweep, headline: number): boolean {
  return Math.abs(row.lift - headline) < 1e-9;
}

function groupsOf(rows: Sweep[]): Array<[string, Sweep[]]> {
  const out = new Map<string, Sweep[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return [...out];
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, n));
}
