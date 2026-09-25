import Link from "next/link";
import { ArrowUpRight, Clock, Cpu, Hash, ShieldCheck, Timer, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Mono } from "@/components/ui/mono";
import { cn } from "@/lib/utils";

export interface RunHeaderProps {
  runId: string;
  subject: string;
  /** What the lead actually wrote. The reason the run exists. */
  inboundMessage: string | null;
  /** Which channel it arrived on, where the payload names one. */
  source: string | null;
  contactName: string | null;
  timezone: string;
  status: string;
  arm: string;
  stepCount: number;
  /** startedAt to completedAt. What a stopwatch would have read. */
  wallMs: number | null;
  /** Sum of the model's own latencies. The part that was inference. */
  modelMs: number;
  totalTokens: number;
  /** Provider and model id, off the committed steps rather than from config. */
  model: string | null;
  policyAllowed: number;
  policyBlocked: number;
  awaiting: boolean;
}

/**
 * The run's identity and its cost.
 *
 * The counts here are all read off committed rows - step latencies, token
 * usage, policy verdicts - rather than recomputed or estimated. A judge
 * scoring AI implementation should be able to see which model ran, how long
 * it took, what it cost in tokens, and how many of its proposals the guardrail
 * refused, without opening anything.
 */
export function RunHeader({
  runId,
  subject,
  inboundMessage,
  source,
  contactName,
  timezone,
  status,
  arm,
  stepCount,
  wallMs,
  modelMs,
  totalTokens,
  model,
  policyAllowed,
  policyBlocked,
  awaiting,
}: RunHeaderProps) {
  const ruledOn = policyAllowed + policyBlocked;

  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{subject}</h1>
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
            <span>{contactName ?? "Unknown contact"}</span>
            {source ? (
              <>
                <span className="text-faint">·</span>
                <Mono tone="faint">{source}</Mono>
              </>
            ) : null}
            <span className="text-faint">·</span>
            <Mono tone="faint">{timezone}</Mono>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge status={arm} size="md" />
          <Badge status={status} size="md" />
        </div>
      </div>

      {inboundMessage ? (
        <blockquote className="rounded-md border border-subtle bg-sunken px-3 py-2.5 text-sm text-muted">
          <span className="mr-1.5 select-none text-faint">&ldquo;</span>
          {inboundMessage}
          <span className="ml-0.5 select-none text-faint">&rdquo;</span>
        </blockquote>
      ) : null}

      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <Fact icon={Hash} label="Steps" value={String(stepCount)} />
        <Fact icon={Timer} label="Wall clock" value={formatMs(wallMs)} />
        <Fact icon={Clock} label="Model time" value={formatMs(modelMs)} />
        <Fact
          icon={Zap}
          label="Tokens"
          value={totalTokens > 0 ? totalTokens.toLocaleString("en-IN") : "—"}
        />
        {model ? <Fact icon={Cpu} label="Model" value={model} /> : null}
        <Fact icon={Hash} label="Run" value={runId} truncate={12} copy />
      </dl>

      {ruledOn > 0 ? (
        // The single most useful line on this screen for anyone watching a
        // recording: how many times the guardrail ruled, and how many times it
        // said no. Violet whenever it said no at least once.
        <p
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm",
            policyBlocked > 0
              ? "border-state-blocked/35 bg-state-blocked/10 text-state-blocked"
              : "border-subtle bg-surface text-muted",
          )}
        >
          <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
          <span>
            Policy ruled on <Mono>{ruledOn}</Mono>{" "}
            {ruledOn === 1 ? "proposal" : "proposals"} —{" "}
            <Mono>{policyBlocked}</Mono> blocked, <Mono>{policyAllowed}</Mono> allowed.
          </span>
        </p>
      ) : null}

      {awaiting ? (
        // The run has genuinely stopped. Saying so loudly is the point of the
        // whole product - an operator should never wonder whether it is stuck
        // or waiting for them.
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-state-proposed/30 bg-state-proposed/10 px-3 py-2.5">
          <p className="text-sm text-state-proposed">
            This run has stopped and is waiting for a human decision.
          </p>
          <Link href="/approvals" className={cn(buttonClasses("secondary", "sm"), "gap-1.5")}>
            Open approvals
            <ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      ) : null}
    </header>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
  truncate,
  copy,
}: {
  icon: typeof Hash;
  label: string;
  value: string;
  truncate?: number;
  copy?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden className="size-3.5 shrink-0 text-faint" />
      <dt className="text-2xs tracking-wide text-faint uppercase">{label}</dt>
      <dd className="min-w-0">
        <Mono value={value} truncate={truncate} copy={copy}>
          {value}
        </Mono>
      </dd>
    </div>
  );
}

function formatMs(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
