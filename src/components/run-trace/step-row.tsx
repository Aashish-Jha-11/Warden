import {
  Brain,
  CheckCircle2,
  CornerDownRight,
  Flag,
  MessageSquareQuote,
  PauseCircle,
  Send,
  ShieldCheck,
  ShieldX,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { PolicyVerdict, readPolicyChecks } from "@/components/approvals/policy-verdict";
import { Badge, StatusPip, TONE, type BadgeTone } from "@/components/ui/badge";
import { Mono } from "@/components/ui/mono";
import { TEMPLATED_ACTION } from "@/lib/agent/types";
import { cn } from "@/lib/utils";

/**
 * One row of the run trace.
 *
 * Every StepKind renders differently on purpose. A trace where eight kinds of
 * event look identical tells a reader nothing - the whole value of this screen
 * is that someone who will never open the source can watch the agent think,
 * get stopped by a guardrail, and wait for a person.
 *
 * What each kind actually carries was read off real rows, not assumed, and the
 * rendering follows the data rather than the schema:
 *
 *   MODEL_CALL      content is usually NULL - a tool-calling turn emits no
 *                   prose - so the row states what the turn decided instead of
 *                   rendering a blank.
 *   TOOL_CALL       toolArgs for propose_action holds { type, args, reason },
 *                   and `reason` is a whole human sentence. It is the proposal,
 *                   so it is set as one, not buried in a JSON fold.
 *   POLICY_CHECK    content is "allowed" or "blocked: <check>"; detail holds
 *                   the named checks. Machine text, promoted to a verdict.
 *   ACTION_EXECUTED detail.data.text is the message that actually went out.
 *                   It is the most concrete thing in the whole database and it
 *                   is rendered as a message, not as JSON.
 */

export type TraceStep = {
  id: string;
  index: number;
  kind: string;
  model: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  toolName: string | null;
  toolArgs: unknown;
  content: string | null;
  detail: unknown;
  createdAt: Date;
};

/**
 * The write-ahead row behind an ACTION_PROPOSED / AWAIT_APPROVAL step, joined
 * in by the page. Without it an approval in the trace is anonymous, and the
 * halt row goes on saying "waiting" long after somebody signed.
 */
export type TraceAction = {
  id: string;
  type: string;
  status: string;
  autoApproved: boolean;
  approval: {
    decision: string;
    note: string | null;
    decidedAt: Date;
    by: string | null;
  } | null;
};

/** Past this, JSON is folded away behind a disclosure rather than shown open. */
const OPEN_IF_UNDER = 180;

const ICON: Record<string, LucideIcon> = {
  MODEL_CALL: Brain,
  TOOL_CALL: Wrench,
  TOOL_RESULT: CornerDownRight,
  POLICY_CHECK: ShieldCheck,
  ACTION_PROPOSED: Send,
  ACTION_EXECUTED: CheckCircle2,
  AWAIT_APPROVAL: PauseCircle,
  TERMINAL: Flag,
};

/**
 * Rings, not bigger nodes. The rail is positioned against a fixed node width,
 * so the two rows that have to shout grow outward from the same centre instead
 * of pushing the line off axis.
 */
const RING: Partial<Record<BadgeTone, string>> = {
  blocked: "ring-2 ring-state-blocked/20",
  proposed: "ring-2 ring-state-proposed/20",
};

export interface StepRowProps {
  step: TraceStep;
  /** The step committed immediately after this one, if any. */
  next: TraceStep | null;
  runStartedAt: Date;
  /** The proposed action this step is about, where there is one. */
  action?: TraceAction;
  /** The recipient's timezone - the clock policy actually reads. */
  timezone: string;
  /** True on the last row, and on any row where the run genuinely stops. */
  railStops: boolean;
}

export function StepRow({
  step,
  next,
  runStartedAt,
  action,
  timezone,
  railStops,
}: StepRowProps) {
  const halt = step.kind === "AWAIT_APPROVAL" && !action?.approval;
  const tone = toneFor(step, halt);
  const Icon = ICON[step.kind] ?? CornerDownRight;

  return (
    <li className="enter-fade relative flex gap-3 pb-5 last:pb-0">
      {/* The rail. Drawn per row rather than as one absolute line so it stops
          cleanly where the run stops instead of trailing into empty space.

          It draws downward on mount, which is what makes a live run read as
          the agent extending its own history rather than a list that was
          always there. No stagger delay: steps append during a demo, and an
          index-based delay would make the twelfth step arrive late. */}
      {railStops ? (
        halt ? (
          <StopCap />
        ) : null
      ) : (
        <span
          aria-hidden
          data-rail
          className="absolute top-6 bottom-0 left-[11px] w-px origin-top animate-[var(--animate-rail)] bg-subtle"
        />
      )}

      <span
        className={cn(
          "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border",
          TONE[tone].chip,
          // A transparent chip would let the rail show through the node.
          tone === "quiet" && "bg-canvas",
          halt && RING.proposed,
          step.kind === "POLICY_CHECK" && tone === "blocked" && RING.blocked,
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        <Meta step={step} tone={tone} runStartedAt={runStartedAt} />
        <Body
          step={step}
          next={next}
          action={action}
          halt={halt}
          timezone={timezone}
        />
      </div>
    </li>
  );
}

/**
 * The stop cap. Absence of a rail reads as "nothing happened next"; a drawn
 * terminator reads as "it stopped here", which is the difference this screen
 * exists to show. Sized and placed against the same 11px axis as the rail.
 */
function StopCap() {
  return (
    <span aria-hidden className="absolute top-6 left-[7px] h-3 w-[9px]">
      <span className="absolute top-0 left-1/2 h-2 w-px -translate-x-1/2 bg-state-proposed/60" />
      <span className="absolute bottom-0 left-0 h-0.5 w-full rounded-full bg-state-proposed" />
    </span>
  );
}

function Meta({
  step,
  tone,
  runStartedAt,
}: {
  step: TraceStep;
  tone: BadgeTone;
  runStartedAt: Date;
}) {
  const loud = step.kind === "POLICY_CHECK" || step.kind === "AWAIT_APPROVAL";

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge status={step.kind} tone={tone} size={loud ? "md" : "sm"} />
      <Mono tone="faint" className="text-2xs">
        +{offset(step.createdAt, runStartedAt)}
      </Mono>
      {step.latencyMs !== null ? (
        <Mono tone="faint" className="text-2xs">
          {formatMs(step.latencyMs)}
        </Mono>
      ) : null}
      {step.model ? (
        <Mono tone="faint" className="text-2xs">
          {step.model}
        </Mono>
      ) : null}
      {step.promptTokens !== null || step.outputTokens !== null ? (
        <Mono tone="faint" className="text-2xs">
          {step.promptTokens ?? 0} in / {step.outputTokens ?? 0} out
        </Mono>
      ) : null}
    </div>
  );
}

function Body({
  step,
  next,
  action,
  halt,
  timezone,
}: {
  step: TraceStep;
  next: TraceStep | null;
  action?: TraceAction;
  halt: boolean;
  timezone: string;
}) {
  switch (step.kind) {
    case "MODEL_CALL":
      return <ModelCall step={step} next={next} />;

    case "TOOL_CALL":
      return <ToolCall step={step} />;

    case "TOOL_RESULT":
      return (
        <>
          {step.toolName ? (
            <p className="text-xs text-faint">
              returned by <Mono tone="muted">{step.toolName}</Mono>
            </p>
          ) : null}
          <Json label="Result" value={step.detail} />
        </>
      );

    case "POLICY_CHECK":
      return <PolicyStep step={step} />;

    case "ACTION_PROPOSED":
      return <ActionProposed step={step} action={action} />;

    case "ACTION_EXECUTED":
      return <ActionExecuted step={step} action={action} />;

    case "AWAIT_APPROVAL":
      return (
        <AwaitApproval step={step} action={action} halt={halt} timezone={timezone} />
      );

    case "TERMINAL":
      return (
        <div className="rounded-md border border-subtle bg-surface px-3 py-2.5">
          <p className="text-2xs font-medium text-faint uppercase">
            Closing summary, in the agent&rsquo;s own words
          </p>
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-fg">
            {step.content ?? "Run complete."}
          </p>
        </div>
      );

    default:
      return <Prose>{step.content}</Prose>;
  }
}

/**
 * A tool-calling turn returns no text, so `content` is null on most of these.
 * Rendering that as a blank row wastes the row; the committed next step says
 * what the turn actually decided, and saying so is true rather than inferred.
 */
function ModelCall({ step, next }: { step: TraceStep; next: TraceStep | null }) {
  const echoedByTerminal = next?.kind === "TERMINAL" && next.content === step.content;

  if (step.content && !echoedByTerminal) {
    return <Prose className="text-fg">{step.content}</Prose>;
  }

  if (echoedByTerminal) {
    return <p className="text-xs text-faint">Wrote the closing summary below.</p>;
  }

  if (next?.kind === "TOOL_CALL" && next.toolName) {
    return (
      <p className="text-xs text-faint">
        No prose this turn — the model answered with a call to{" "}
        <Mono tone="muted">{next.toolName}</Mono>.
      </p>
    );
  }

  return <p className="text-xs text-faint">No prose this turn.</p>;
}

/**
 * propose_action is the only gated tool, and its arguments carry the agent's
 * stated justification as a full sentence. That sentence is what a human
 * approver reads, so it is set as prose here and the raw object folds.
 */
function ToolCall({ step }: { step: TraceStep }) {
  const args = asRecord(step.toolArgs);
  const proposal = step.toolName === "propose_action" ? args : null;
  const type = typeof proposal?.type === "string" ? proposal.type : null;
  const reason = typeof proposal?.reason === "string" ? proposal.reason : null;
  const valuePaise = typeof proposal?.valuePaise === "number" ? proposal.valuePaise : 0;

  if (!proposal) {
    return (
      <>
        <p className="text-sm">
          <Mono>{step.toolName ?? "tool"}</Mono>
          <span className="text-faint">()</span>
        </p>
        <Json label="Arguments" value={step.toolArgs} />
      </>
    );
  }

  return (
    <div className="rounded-md border border-subtle bg-sunken">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-subtle px-3 py-2">
        <span className="text-2xs font-medium text-faint uppercase">
          The agent proposes
        </span>
        {type ? <Mono className="text-sm">{type}</Mono> : null}
        {valuePaise > 0 ? (
          <Badge
            tone="neutral"
            label={<Mono className="text-2xs">{formatPaise(valuePaise)}</Mono>}
            pip={false}
          />
        ) : null}
      </div>

      {reason ? (
        <p className="px-3 py-2.5 text-sm leading-relaxed text-fg">
          <span className="mr-1 select-none text-faint">&ldquo;</span>
          {reason}
          <span className="ml-0.5 select-none text-faint">&rdquo;</span>
        </p>
      ) : null}

      <div className="border-t border-subtle px-3 py-1.5">
        <Json label="Raw proposal" value={step.toolArgs} forceFold />
      </div>
    </div>
  );
}

/**
 * The guardrail speaking. Visually the loudest row on the page, because it is
 * the one that proves policy is code and not prompt text.
 *
 * An allowed verdict folds and a blocked one does not, on purpose. A run makes
 * several of these and three identical green panels would drown the one violet
 * panel that matters - which is exactly the row a judge is here to see.
 */
function PolicyStep({ step }: { step: TraceStep }) {
  const checks = readPolicyChecks(step.detail);
  const failed = checks.find((c) => !c.passed);
  const blocked = failed !== undefined || (step.content ?? "").startsWith("blocked");
  const blockedBy = failed?.name ?? blockedByOf(step.content);
  const passedCount = checks.filter((c) => c.passed).length;

  if (!blocked) {
    return (
      <details className="group rounded-md border border-subtle bg-sunken">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] select-none hover:bg-raised">
          <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-state-executed" />
          <span className="text-sm font-medium text-state-executed">Allowed</span>
          <span className="text-xs text-muted">
            <Mono tone="muted">{passedCount}</Mono> checks passed, none blocked
          </span>
          <span className="ml-auto text-2xs text-faint group-open:hidden">show</span>
          <span className="ml-auto hidden text-2xs text-faint group-open:inline">
            hide
          </span>
        </summary>
        {checks.length > 0 ? (
          <PolicyVerdict checks={checks} className="rounded-none border-0 border-t" />
        ) : (
          <Prose>{step.content}</Prose>
        )}
      </details>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-state-blocked/45 bg-state-blocked/10">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2.5">
          <ShieldX aria-hidden className="size-4 shrink-0 text-state-blocked" />
          <span className="text-base leading-tight font-semibold text-state-blocked">
            Blocked by policy
          </span>
          {blockedBy ? (
            <Mono className="text-2xs text-state-blocked">{blockedBy}</Mono>
          ) : null}
        </div>

        {failed?.detail ? (
          // The engine's own sentence, verbatim. "Local time is Wed 20:37
          // Asia/Kolkata; window is 9:00-20:00." is the entire argument this
          // product makes, and paraphrasing it would weaken it.
          <p className="border-t border-state-blocked/25 px-3 py-2.5 text-sm leading-relaxed text-state-blocked">
            {failed.detail}
          </p>
        ) : null}

        <p className="border-t border-state-blocked/25 px-3 py-2 text-xs leading-relaxed text-muted">
          The proposal never reached anyone. The agent was handed this verdict
          as a tool result and had to choose something else — there is no
          override path in the code.
        </p>
      </div>

      {checks.length > 0 ? <PolicyVerdict checks={checks} /> : null}
    </div>
  );
}

function ActionProposed({ step, action }: { step: TraceStep; action?: TraceAction }) {
  const detail = asRecord(step.detail);
  const [type, reason] = splitTypeAndReason(step.content);
  const actionType = type ?? action?.type ?? "action";

  // `requiresApproval` is on the step; `autoApproved` is on the write-ahead
  // row. Same fact from two sides - and the action row is the one that cannot
  // be missing it, so it stands in for a step written before the flag existed.
  const requiresApproval =
    typeof detail?.requiresApproval === "boolean"
      ? detail.requiresApproval
      : action
        ? !action.autoApproved
        : false;

  return (
    <div className="rounded-md border border-state-proposed/30 bg-state-proposed/8">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-state-proposed/25 px-3 py-2">
        <Send aria-hidden className="size-3.5 shrink-0 text-state-proposed" />
        <Mono className="text-sm text-state-proposed">{actionType}</Mono>
        {/* Skipping approval has two different causes and they are not
            interchangeable: a signed template is a human decision taken in
            advance, tenant auto-approval is a configuration. Labelling a
            schedule_callback "pre-approved template" would claim a signature
            that nobody gave. */}
        {requiresApproval ? (
          <Badge tone="proposed" label="Needs a human" pip={false} />
        ) : actionType === TEMPLATED_ACTION ? (
          <Badge tone="approved" label="Pre-approved template" pip={false} />
        ) : (
          <Badge tone="approved" label="Auto-approved by policy" pip={false} />
        )}
        {action ? <Badge status={action.status} /> : null}
      </div>

      {reason ? (
        <p className="px-3 py-2.5 text-sm leading-relaxed text-fg">{reason}</p>
      ) : (
        <Prose className="px-3 py-2.5">{step.content}</Prose>
      )}

      {action ? (
        <p className="border-t border-state-proposed/25 px-3 py-1.5 text-2xs text-faint">
          Written to the database before anything fired ·{" "}
          <Mono tone="faint" value={action.id} truncate={14} copy className="text-2xs" />
        </p>
      ) : null}
    </div>
  );
}

/**
 * `detail` here is the executor's own return value: { ok, data }. For a
 * templated reply `data.text` is the rendered message that went out, which is
 * the single most concrete row in the database - so it is rendered as a
 * message rather than folded into JSON with everything else.
 */
function ActionExecuted({ step, action }: { step: TraceStep; action?: TraceAction }) {
  const detail = asRecord(step.detail);
  const ok = detail?.ok !== false;
  const data = asRecord(detail?.data);
  const text = typeof data?.text === "string" ? data.text : null;
  const templateId = typeof data?.templateId === "string" ? data.templateId : null;
  const subject = typeof data?.subject === "string" ? data.subject : null;

  if (!ok) {
    const error =
      typeof detail?.error === "string" ? detail.error : (step.content ?? "Execution failed.");
    return (
      <div className="flex items-start gap-2 rounded-md border border-state-failed/35 bg-state-failed/10 px-3 py-2.5">
        <XCircle aria-hidden className="mt-px size-3.5 shrink-0 text-state-failed" />
        <p className="text-sm leading-relaxed text-state-failed">{error}</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-state-executed/30 bg-state-executed/8">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-state-executed" />
        <span className="text-sm font-medium text-state-executed">Executed</span>
        {action ? <Mono tone="muted" className="text-xs">{action.type}</Mono> : null}
        {templateId ? (
          <Badge
            tone="approved"
            label={<Mono className="text-2xs">{templateId}</Mono>}
            pip={false}
          />
        ) : null}
      </div>

      {text ? (
        <div className="border-t border-state-executed/25 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-2xs font-medium text-faint uppercase">
            <MessageSquareQuote aria-hidden className="size-3" />
            What the recipient received
          </p>
          {subject ? (
            <p className="mt-1.5 text-xs text-muted">
              Subject: <span className="text-fg">{subject}</span>
            </p>
          ) : null}
          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap text-fg">
            {text}
          </p>
        </div>
      ) : null}

      {!text && data && Object.keys(data).length > 0 ? (
        <div className="border-t border-state-executed/25 px-3 py-1.5">
          <Json label="Outcome" value={data} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The halt. The product's whole claim is that an agent stops and waits, so
 * this row states it at the size of a claim - and the rail terminates beside
 * it rather than carrying on into nothing.
 */
function AwaitApproval({
  step,
  action,
  halt,
  timezone,
}: {
  step: TraceStep;
  action?: TraceAction;
  halt: boolean;
  timezone: string;
}) {
  const approval = action?.approval;

  if (!halt && approval) {
    const rejected = approval.decision.toUpperCase() === "REJECTED";
    return (
      <div className="rounded-md border border-subtle bg-surface">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5">
          <Badge status={approval.decision} size="md" />
          <span className="text-sm text-fg">
            {approval.by ? (
              <>
                by <span className="font-medium">{approval.by}</span>
              </>
            ) : (
              "by an operator"
            )}
          </span>
          <Mono tone="faint" className="text-2xs">
            {localStamp(approval.decidedAt, timezone)}
          </Mono>
        </div>
        {approval.note ? (
          <p className="border-t border-subtle px-3 py-2 text-sm leading-relaxed text-muted">
            &ldquo;{approval.note}&rdquo;
          </p>
        ) : null}
        <p className="border-t border-subtle px-3 py-1.5 text-2xs text-faint">
          {rejected
            ? "The run stopped here and a person declined it. Nothing was sent."
            : "The run stopped here until a person signed it, then resumed."}
        </p>
      </div>
    );
  }

  // No button here. The header already offers the one that an operator opening
  // this page on a phone needs to reach without scrolling, and a second copy of
  // it eleven rows down is a duplicate control, not a second affordance.
  return (
    <div className="rounded-md border-2 border-state-proposed/45 bg-state-proposed/12 px-3 py-3">
      <p className="flex items-center gap-2 text-base leading-tight font-semibold text-state-proposed">
        <PauseCircle aria-hidden className="size-4 shrink-0" />
        The run stops here
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-state-proposed">
        {step.content ?? "Waiting on a human."}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Nothing further happens on this case until a person decides. The agent
        cannot approve its own proposal and cannot time out into acting.
      </p>
    </div>
  );
}

function Prose({ children, className }: { children: string | null; className?: string }) {
  if (!children) return null;
  return (
    <p className={cn("text-sm leading-relaxed whitespace-pre-wrap text-muted", className)}>
      {children}
    </p>
  );
}

/**
 * Native <details>, not a client component. Collapsing JSON is the one piece of
 * interactivity on this page and it does not justify shipping React for it.
 */
function Json({
  label,
  value,
  forceFold = false,
}: {
  label: string;
  value: unknown;
  /** Set where the same content is already stated in prose above. */
  forceFold?: boolean;
}) {
  if (value === null || value === undefined) return null;
  const text = safeStringify(value);
  if (!text || text === "{}" || text === "null" || text === "[]") return null;

  const open = !forceFold && text.length < OPEN_IF_UNDER;

  return (
    <details open={open} className="group">
      <summary className="cursor-pointer list-none text-2xs tracking-wide text-faint uppercase transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] select-none hover:text-muted">
        <StatusPip tone="quiet" className="mr-1.5 align-middle" />
        {label}
        <span className="ml-1.5 normal-case group-open:hidden">({text.length} chars)</span>
      </summary>
      <pre className="mt-1.5 max-h-80 overflow-auto rounded-md border border-subtle bg-sunken px-3 py-2 text-xs text-muted">
        {text}
      </pre>
    </details>
  );
}

/**
 * Tone per kind, and it is not a constant lookup: a POLICY_CHECK that passed
 * must not render violet, or the one colour in this product that means "policy
 * stopped it" stops meaning anything.
 */
function toneFor(step: TraceStep, halt: boolean): BadgeTone {
  switch (step.kind) {
    case "MODEL_CALL":
      return "accent";
    case "TOOL_CALL":
      return "neutral";
    case "TOOL_RESULT":
      return "quiet";
    case "POLICY_CHECK": {
      const checks = readPolicyChecks(step.detail);
      const blocked =
        checks.some((c) => !c.passed) || (step.content ?? "").startsWith("blocked");
      return blocked ? "blocked" : "executed";
    }
    case "ACTION_PROPOSED":
      return "proposed";
    case "ACTION_EXECUTED":
      return asRecord(step.detail)?.ok === false ? "failed" : "executed";
    case "AWAIT_APPROVAL":
      return halt ? "proposed" : "approved";
    case "TERMINAL":
      return "pending";
    default:
      return "neutral";
  }
}

/** ACTION_PROPOSED writes "<type>: <reason>" into one column. */
function splitTypeAndReason(content: string | null): [string | null, string | null] {
  if (!content) return [null, null];
  const at = content.indexOf(": ");
  if (at <= 0) return [null, content];
  return [content.slice(0, at), content.slice(at + 2)];
}

/** POLICY_CHECK writes "blocked: <check name>". */
function blockedByOf(content: string | null): string | null {
  if (!content) return null;
  const at = content.indexOf(": ");
  return at > 0 ? content.slice(at + 2) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    // A step payload is diagnostic data; a cycle in it must not blank the page.
    return String(value);
  }
}

function offset(at: Date, start: Date): string {
  const ms = at.getTime() - start.getTime();
  if (ms < 0) return "0.0s";
  return formatMs(ms);
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatPaise(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2)}`;
}

/**
 * Formatted in the RECIPIENT's timezone, with an explicit locale, so the
 * stamp is the same string on the server and after any refresh - and so it
 * agrees with the clock the contact-window check read.
 */
function localStamp(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}
