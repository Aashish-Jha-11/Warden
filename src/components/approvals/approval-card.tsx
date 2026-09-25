import {
  ArrowUpRight,
  Bot,
  CalendarClock,
  CircleCheckBig,
  CircleHelp,
  Clock,
  KeyRound,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquareQuote,
  PencilLine,
  Phone,
  Send,
  ShieldX,
  Signature,
  Smartphone,
  UserRound,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { DecisionButtons } from "@/components/approvals/decision-buttons";
import {
  PolicyVerdict,
  readPolicyChecks,
} from "@/components/approvals/policy-verdict";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Mono } from "@/components/ui/mono";
import type { ActionType } from "@/lib/agent/types";
import { LeadPayloadSchema, scoreLead, type LeadPayload } from "@/lib/domain/lead";
import {
  getTemplate,
  renderTemplate,
  type MessageTemplate,
  type TemplateChannel,
} from "@/lib/templates";
import { cn } from "@/lib/utils";

import type { AgentRun, Case, ProposedAction } from "@/generated/prisma/client";

/**
 * One proposed action, with everything a person needs to sign it.
 *
 * The organising rule is that approving must never be approving a black box.
 * So this shows, in order: what the agent wants to do, who it lands on, what
 * they actually wrote, the agent's own justification in its own words, the
 * literal outgoing text, the slots it filled, and the policy verdict that let
 * it get this far. If any of those cannot be resolved, the card says so rather
 * than quietly rendering a smaller version of itself.
 */

export type QueuedAction = ProposedAction & { run: AgentRun & { case: Case } };

const ACTION: Record<ActionType, { label: string; icon: LucideIcon }> = {
  send_templated_reply: { label: "Send a pre-approved reply", icon: MessageCircle },
  send_email: { label: "Send an email", icon: Mail },
  send_sms: { label: "Send an SMS", icon: Smartphone },
  place_call: { label: "Place a call", icon: Phone },
  schedule_callback: { label: "Schedule a callback", icon: CalendarClock },
  update_case: { label: "Update the case", icon: PencilLine },
  escalate_to_human: { label: "Escalate to a person", icon: UserRoundPlus },
  close_case: { label: "Close the case", icon: CircleCheckBig },
};

const CHANNEL_LABEL: Record<TemplateChannel, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  email: "Email",
};

/** Arg keys that hold the body of a message rather than metadata about it. */
const BODY_KEYS = ["body", "message", "text"] as const;

/**
 * Past this a proposal stops being fresh work and starts being a backlog.
 * Inbound lead response is a freshness business - half an hour is roughly
 * where a reply stops feeling like an answer to the person who is waiting.
 */
const STALE_AFTER_MINUTES = 30;

export interface ApprovalCardProps {
  action: QueuedAction;
  /** Captured once per page render so every card agrees on "how long ago". */
  now: Date;
  /** Stagger index for the entrance. */
  index?: number;
}

export function ApprovalCard({ action, now, index = 0 }: ApprovalCardProps) {
  const kase = action.run.case;
  const { label, icon: ActionIcon } = describeAction(action.type);

  const parsed = LeadPayloadSchema.safeParse(kase.payload);
  const lead: LeadPayload | null = parsed.success ? parsed.data : null;
  // A payload that has drifted from the schema still usually has the message in
  // it, and the message is the one thing the approver cannot decide without.
  const inbound = lead?.message ?? readString(kase.payload, "message");
  const qualification = lead ? scoreLead(lead) : null;
  const arrived = lead ? formatIn(kase.timezone, lead.arrivedAt) : null;

  const checks = readPolicyChecks(action.policyVerdict);
  const contactName = kase.contactName?.trim() || "Unnamed contact";
  const waitedMinutes = minutesSince(action.proposedAt, now);
  const stale = waitedMinutes >= STALE_AFTER_MINUTES;

  return (
    <Card className="enter-rise" style={{ "--i": Math.min(index, 8) } as React.CSSProperties}>
      <CardHeader className="flex-wrap gap-y-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <ActionIcon aria-hidden className="size-4 shrink-0 text-accent-soft" />
            {label}
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Mono tone="faint" className="break-all">
              {action.type}
            </Mono>
            <span aria-hidden className="text-faint">
              ·
            </span>
            <span className="break-words">{kase.subject}</span>
          </CardDescription>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {qualification ? <Badge status={qualification.tier} /> : null}
          <Badge status={action.status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <section className="space-y-2">
          <SectionLabel icon={UserRound}>Who this lands on</SectionLabel>

          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-base font-medium text-fg">{contactName}</span>
            {lead?.city ? <span className="text-xs text-muted">{lead.city}</span> : null}
            {lead?.service ? (
              <span className="text-xs text-muted">
                asked about <span className="text-fg">{lead.service}</span>
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {kase.contactPhone ? (
              <Meta icon={Phone}>
                <Mono tone="muted">{kase.contactPhone}</Mono>
              </Meta>
            ) : null}
            {kase.contactEmail ? (
              <Meta icon={Mail}>
                <Mono tone="muted" truncate={26} value={kase.contactEmail}>
                  {kase.contactEmail}
                </Mono>
              </Meta>
            ) : null}
            {/* The timezone is not decoration: it is the clock the contact
                window check below was evaluated against. */}
            <Meta icon={MapPin}>
              <Mono tone="muted">{kase.timezone}</Mono>
            </Meta>
          </div>

          {inbound ? (
            <blockquote className="rounded-md border border-subtle bg-sunken px-3 py-2.5">
              <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">
                {inbound}
              </p>
              <footer className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-faint">
                <span>Inbound</span>
                {lead ? <Mono tone="faint">{lead.source}</Mono> : null}
                {arrived ? (
                  <>
                    <span aria-hidden>·</span>
                    <Mono tone="faint">{arrived}</Mono>
                  </>
                ) : null}
              </footer>
            </blockquote>
          ) : (
            <p className="text-xs text-faint">
              This case carries no inbound message. Nothing here says what the
              person asked for.
            </p>
          )}

          {qualification ? (
            // scoreLead is deterministic and shared with the control arm, so
            // its inputs are shown rather than the tier alone - the chip in the
            // header is arithmetic, not an opinion the model formed.
            <p className="text-2xs leading-relaxed text-faint">
              Scored <Mono tone="muted">{qualification.score}</Mono>/100 ·{" "}
              <Mono tone="faint" className="break-words">
                {qualification.reason}
              </Mono>
            </p>
          ) : null}
        </section>

        {/* Accent, not a state colour. This is the model talking, and the one
            thing on the card that must never be mistaken for a verdict. */}
        <section className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2.5">
          <SectionLabel icon={Bot} className="text-accent-soft">
            The agent&rsquo;s stated reason
          </SectionLabel>
          <blockquote className="mt-1.5 text-sm leading-relaxed break-words text-fg italic">
            &ldquo;{action.reason}&rdquo;
          </blockquote>
        </section>

        <Outgoing action={action} />

        <PolicyVerdict checks={checks} emphasise="approval_required" />

        <div className="-mx-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-subtle px-4 pt-3 text-xs text-muted">
          <Meta icon={Clock}>
            <span className="text-faint">Waiting</span>
            <Mono
              // Amber is this system's colour for "waiting on a human", and a
              // proposal that has been here half an hour is more of that, not
              // a different thing.
              className={cn(stale ? "text-state-proposed" : "text-muted")}
              title={`Proposed ${action.proposedAt.toISOString()}`}
            >
              {formatWait(waitedMinutes)}
            </Mono>
          </Meta>

          <Meta icon={KeyRound}>
            <span className="text-faint">Idempotency</span>
            <Mono copy truncate={20} value={action.idempotencyKey}>
              {action.idempotencyKey}
            </Mono>
          </Meta>

          {/* The trace is the only place the decisions behind this proposal are
              legible. An approver who cannot reach it is being asked to sign
              for reasoning they have no way to read. */}
          <Link
            href={`/runs/${action.runId}`}
            className="pressable ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-1 -mx-1.5 text-xs text-accent-soft transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-raised"
          >
            Open the run
            <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
          </Link>
        </div>
      </CardContent>

      <CardFooter className="flex-col items-stretch justify-start gap-2">
        <DecisionButtons actionId={action.id} actionLabel={label.toLowerCase()} />
      </CardFooter>
    </Card>
  );
}

/**
 * What would actually go out.
 *
 * For a templated reply this runs the same renderTemplate() the executor will
 * run, so the operator reads the literal text rather than a template id and a
 * promise. When that render refuses, the refusal is shown in the blocked violet
 * rather than red: a template that will not fill its slots is the message layer
 * doing its job, not a fault in it.
 */
function Outgoing({ action }: { action: QueuedAction }) {
  if (action.type === "send_templated_reply") {
    const templateId = readString(action.args, "templateId");
    const variables = readRecord(action.args, "variables");
    const template = templateId ? getTemplate(templateId) : undefined;
    const rendered = templateId ? renderTemplate(templateId, variables) : null;

    return (
      <section className="space-y-2">
        <SectionLabel icon={Send}>The exact message</SectionLabel>

        {rendered?.ok ? (
          <div className="overflow-hidden rounded-md border border-subtle bg-sunken">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-subtle px-3 py-2">
              {template ? (
                <Badge tone="quiet" pip={false} label={CHANNEL_LABEL[template.channel]} />
              ) : null}
              <Mono tone="faint" className="text-2xs break-all">
                {templateId}
              </Mono>
            </div>
            {template?.subject ? (
              <p className="border-b border-subtle px-3 py-2 text-xs">
                <span className="text-faint">Subject</span>{" "}
                <span className="text-fg">{template.subject}</span>
              </p>
            ) : null}
            <p className="px-3 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">
              {rendered.text}
            </p>
            {template ? <Slots template={template} variables={variables} /> : null}
          </div>
        ) : (
          <Refusal
            title="This would not send as it stands"
            detail={
              rendered?.ok === false
                ? rendered.error
                : "The proposal names no template, so there is no wording to show."
            }
          />
        )}
      </section>
    );
  }

  const args = readRecord(action.args);
  const bodyKey = BODY_KEYS.find((key) => typeof args[key] === "string" && args[key]);
  const body = bodyKey ? String(args[bodyKey]) : null;
  const fields = Object.entries(args).filter(([key]) => key !== bodyKey);
  const timeZone = action.run.case.timezone;

  return (
    <section className="space-y-2">
      <SectionLabel icon={MessageSquareQuote}>What would happen</SectionLabel>

      {body ? (
        <p className="rounded-md border border-subtle bg-sunken px-3 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">
          {body}
        </p>
      ) : null}

      {fields.length > 0 ? (
        <dl className="divide-y divide-subtle rounded-md border border-subtle bg-sunken">
          {fields.map(([key, value]) => {
            // A callback time is the one argument on this card an approver is
            // actually being asked to check, and the agent writes it in UTC.
            // "2026-09-24T13:30:00Z" against a lead who wrote "call me after
            // 7pm" is not a thing a person can verify in their head, so the
            // recipient's own clock is printed beside it - the same clock
            // policy.ts evaluated the contact window in.
            const local = asLocalTime(value, timeZone);
            return (
              <div key={key} className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-2">
                <dt className="w-20 shrink-0 text-2xs text-faint uppercase sm:w-24">
                  {key}
                </dt>
                <dd className="min-w-0 flex-1">
                  <Mono tone="muted" className="break-words">
                    {display(value)}
                  </Mono>
                  {local ? (
                    <span className="mt-0.5 block text-2xs text-faint">
                      {local} local to {timeZone}
                    </span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : body ? null : (
        <p className="text-xs text-faint">
          The agent proposed this with no arguments at all.
        </p>
      )}
    </section>
  );
}

/**
 * The slots, and the sentence a human signed the wording under.
 *
 * This is the whole per-template argument made visible: the body above was
 * approved once by a person, and the only thing the agent contributed to it is
 * the short list below. Values are read straight off the proposal's own args
 * rather than re-derived, so nothing here can disagree with the message
 * printed above it - that text came from renderTemplate itself.
 */
function Slots({
  template,
  variables,
}: {
  template: MessageTemplate;
  variables: Record<string, unknown>;
}) {
  return (
    <div className="space-y-1.5 border-t border-subtle px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xs text-faint uppercase">Filled</span>
        {template.variables.map((slot) => {
          const supplied = asFilled(variables[slot.name]);
          const value = supplied ?? slot.fallback;
          return (
            <span key={slot.name} className="inline-flex min-w-0 items-baseline gap-1">
              <Mono tone="faint" className="text-2xs shrink-0">
                {`{{${slot.name}}}`}
              </Mono>
              <span className="min-w-0 text-xs break-words text-fg">
                {value ?? <span className="text-state-blocked">nothing supplied</span>}
              </span>
              {supplied === null && value !== undefined ? (
                <span className="shrink-0 text-2xs text-faint">signed default</span>
              ) : null}
            </span>
          );
        })}
      </div>
      <p className="text-2xs leading-relaxed text-faint">
        <Signature aria-hidden className="mr-1 inline size-3 align-[-1px]" />
        Signed off for: {template.when}
      </p>
    </div>
  );
}

function Refusal({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-state-blocked/30 bg-state-blocked/10 px-3 py-2.5">
      <ShieldX aria-hidden className="mt-0.5 size-3.5 shrink-0 text-state-blocked" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-state-blocked">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed break-words text-muted">{detail}</p>
      </div>
    </div>
  );
}

function SectionLabel({
  icon: Icon,
  className,
  children,
}: {
  icon: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-2xs font-medium text-faint uppercase",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </div>
  );
}

function Meta({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {Icon ? <Icon aria-hidden className="size-3.5 shrink-0 text-faint" /> : null}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- helpers

function describeAction(type: string): { label: string; icon: LucideIcon } {
  if (Object.hasOwn(ACTION, type)) return ACTION[type as ActionType];
  const words = type.replace(/[_-]+/g, " ").trim();
  return {
    label: words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown action",
    icon: CircleHelp,
  };
}

/** Rounded down, because "waiting 2h" must never overstate how fresh this is. */
function minutesSince(at: Date, now: Date): number {
  return Math.floor(Math.max(0, now.getTime() - at.getTime()) / 60_000);
}

function formatWait(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Formatted in the RECIPIENT's timezone, for the same reason policy.ts
 * evaluates the contact window there: the operator has to be able to line this
 * timestamp up against "Local time Wed 15:00 Asia/Kolkata" in the verdict, and
 * a server-local clock makes that comparison silently wrong.
 */
function formatIn(timeZone: string, iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at);
  } catch {
    return null;
  }
}

/** Anchored and strict, so a phone number or an id is never read as a date. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The same instant in the recipient's zone, or null if this is not a time. */
function asLocalTime(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string" || !ISO_DATETIME.test(value.trim())) return null;
  return formatIn(timeZone, value.trim());
}

/**
 * Mirrors renderTemplate's idea of "supplied": a CRM with no name on file
 * returns "" far more often than it returns nothing at all, and " " more often
 * than either. All three mean the signed fallback is what actually went in.
 */
function asFilled(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function readString(source: unknown, key: string): string | null {
  const value = readRecord(source)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRecord(source: unknown, key?: string): Record<string, unknown> {
  const root =
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  if (key === undefined) return root;
  const nested = root[key];
  return typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : {};
}

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
