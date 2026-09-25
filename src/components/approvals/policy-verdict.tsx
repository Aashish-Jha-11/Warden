import { Check, ShieldCheck, ShieldX, UserRoundCheck, type LucideIcon } from "lucide-react";

import { Badge, TONE, type BadgeTone } from "@/components/ui/badge";
import { Mono } from "@/components/ui/mono";
import type { CheckResult } from "@/lib/agent/types";
import { cn } from "@/lib/utils";

/**
 * The policy verdict, check by check.
 *
 * This is the component that has to carry the claim. Anyone can put "I follow
 * your rules" in a system prompt; what makes that claim true here is that a
 * separate engine read database rows and a clock after the model had finished
 * speaking, and wrote down what it found. So every check is rendered by name -
 * the literal identifier from policy.ts, not a prettified paraphrase - next to
 * its outcome and the human sentence the engine produced. A reader can open
 * policy.ts, find `contact_window`, and see the same words.
 *
 * A failed check is VIOLET, never red. It is the guardrail working, and the one
 * thing this product must never teach an operator to read as breakage.
 */

/**
 * Noun phrases, deliberately not sentences. "Contact window" is honest whether
 * the check passed or blocked; "Inside the contact window" would be a lie on
 * half the rows this renders.
 */
const CHECK_TITLE: Record<string, string> = {
  opt_out: "Opt-out",
  action_allowed: "Action allow-list",
  attempt_budget: "Contact attempts",
  run_action_ceiling: "Actions this run",
  contact_window: "Contact window",
  value_ceiling: "Spend ceiling",
  template_approved: "Template signed off",
  template_variables: "Variable allow-list",
  approval_required: "Human approval",
};

export interface PolicyVerdictProps {
  checks: CheckResult[];
  /**
   * Name of the one check that explains why this is on screen at all - on the
   * approval queue, `approval_required`. Rendered amber, the colour this system
   * uses for "waiting on a human", so the eye lands on the reason first.
   */
  emphasise?: string;
  className?: string;
}

export function PolicyVerdict({ checks, emphasise, className }: PolicyVerdictProps) {
  const blocked = checks.filter((c) => !c.passed);

  return (
    <section
      className={cn("rounded-md border border-subtle bg-sunken", className)}
      aria-label="Policy checks"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-subtle px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-faint uppercase">
          <ShieldCheck aria-hidden className="size-3.5" />
          Policy checks
        </span>
        {checks.length > 0 ? (
          blocked.length > 0 ? (
            <Badge tone="blocked" label="Blocked" />
          ) : (
            <Badge tone="executed" label="All passed" />
          )
        ) : null}
      </header>

      {checks.length === 0 ? (
        <p className="px-3 py-3 text-xs text-faint">
          No verdict was recorded against this action. Nothing can be approved
          from here until one is.
        </p>
      ) : (
        <ul className="divide-y divide-subtle">
          {checks.map((check, i) => (
            <CheckRow
              // Names repeat across a verdict (contact_window can be evaluated
              // on two paths), so position is the only stable key here.
              key={`${check.name}-${i}`}
              check={check}
              emphasised={check.passed && check.name === emphasise}
            />
          ))}
        </ul>
      )}

      <footer className="border-t border-subtle px-3 py-2 text-2xs leading-relaxed text-faint">
        Evaluated against tenant policy and the recipient&rsquo;s local clock
        before this row was written. The agent does not see these checks and
        cannot argue with them.
      </footer>
    </section>
  );
}

function CheckRow({ check, emphasised }: { check: CheckResult; emphasised: boolean }) {
  const tone: BadgeTone = !check.passed ? "blocked" : emphasised ? "proposed" : "executed";
  const Icon: LucideIcon = !check.passed ? ShieldX : emphasised ? UserRoundCheck : Check;

  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5">
      <span
        className={cn(
          "mt-px flex size-5 shrink-0 items-center justify-center rounded-sm border",
          TONE[tone].chip,
        )}
      >
        <Icon aria-hidden className="size-3" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {/* Colour and an icon are the only outcome cues in the visual design,
              and neither survives a screen reader. */}
          <span className="sr-only">{check.passed ? "Passed:" : "Blocked:"}</span>
          <span
            className={cn(
              "text-sm leading-tight font-medium",
              check.passed ? "text-fg" : TONE.blocked.text,
            )}
          >
            {titleFor(check.name)}
          </span>
          <Mono tone="faint" className="text-2xs break-all">
            {check.name}
          </Mono>
        </div>

        {check.detail ? (
          <p
            className={cn(
              "mt-1 text-xs leading-relaxed break-words",
              check.passed ? "text-muted" : TONE.blocked.text,
            )}
          >
            {check.detail}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Narrows the `policyVerdict` Json column into checks.
 *
 * The column is written by runtime.ts as `{ checks }` and read back untyped.
 * It can hold rows written by an older shape of this code, so this narrows
 * field by field instead of casting: an approver seeing an empty verdict is
 * recoverable, a queue that throws on one malformed row is not.
 */
export function readPolicyChecks(value: unknown): CheckResult[] {
  const source: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.checks)
      ? value.checks
      : [];

  const checks: CheckResult[] = [];
  for (const entry of source) {
    if (!isRecord(entry)) continue;
    const { name, passed, detail } = entry;
    if (typeof name !== "string" || typeof passed !== "boolean") continue;
    checks.push({
      name,
      passed,
      detail: typeof detail === "string" && detail.length > 0 ? detail : undefined,
    });
  }
  return checks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleFor(name: string): string {
  if (Object.hasOwn(CHECK_TITLE, name)) return CHECK_TITLE[name];
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Check";
}
