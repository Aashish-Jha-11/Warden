"use client";

import { ArrowRight, Send, TriangleAlert, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Mono } from "@/components/ui/mono";
import { scoreLead, type LeadPayload } from "@/lib/domain/lead";
import { cn } from "@/lib/utils";

/**
 * The demo's opening move.
 *
 * Everything downstream - the run trace, the approval queue, the policy
 * verdict - needs a lead to exist first, and waiting on a real WhatsApp
 * webhook in front of an audience is how a demo dies. This posts a synthetic
 * enquiry to the same public endpoint a form provider would hit, so the path
 * being shown is the real one with only the sender faked.
 *
 * The presets are one click each and carry no configuration, because every
 * dropdown between the operator and a lead is one more thing to get wrong on
 * camera. The free-text field exists for the question a judge asks out loud.
 */

/** A preset, minus the timestamp that is stamped at the moment of the click. */
type PresetLead = Omit<LeadPayload, "arrivedAt">;

type Preset = {
  id: string;
  /** Why this one is in the list. Shown to the operator, sent nowhere. */
  note: string;
  contactName: string | null;
  lead: PresetLead;
};

/**
 * Real shapes of Indian SMB enquiry, not three variations on one. Between them
 * they cover the whole scoring range, so a single pass through this panel
 * shows the tier ramp doing something rather than printing "warm" four times.
 */
const PRESETS: readonly Preset[] = [
  {
    id: "fees-hinglish",
    note: "The most common enquiry there is. No service, no timeline.",
    contactName: "Asha",
    lead: {
      source: "whatsapp",
      message: "hi, fees kitni hai?",
      service: null,
      city: "Pune",
      urgency: "comparing",
      budgetSignal: "none",
    },
  },
  {
    id: "weekend-batch",
    note: "Named the service, named the constraint. Everything to work with.",
    contactName: "Rohit",
    lead: {
      source: "website_form",
      message:
        "Is the weekend batch still open? I work full time so weekdays are hard for me.",
      service: "IELTS coaching",
      city: "Indore",
      urgency: "ready",
      budgetSignal: "mid",
    },
  },
  {
    id: "bare-price",
    // Instagram hands over a handle, not a name, often not even that - so this
    // one also exercises the template's {{name}} fallback on the way through.
    contactName: null,
    note: "Two words and nothing else. The agent has to ask, not guess.",
    lead: {
      source: "instagram",
      message: "price?",
      service: null,
      city: "Surat",
      urgency: "browsing",
      budgetSignal: "none",
    },
  },
  {
    id: "missed-call",
    note: "Rang off before anyone picked up. Highest intent, least text.",
    contactName: "Meera",
    lead: {
      source: "missed_call",
      message: "Missed call, no message left.",
      service: null,
      city: "Nagpur",
      urgency: "ready",
      budgetSignal: "low",
    },
  },
];

/**
 * The free-text field sends one fixed shape. A channel picker, a city picker
 * and an urgency picker would each be a place to stall mid-sentence, and the
 * helper line below the field says exactly what is assumed instead.
 */
const FREE_TEXT: PresetLead = {
  source: "whatsapp",
  message: "",
  service: null,
  city: "Pune",
  urgency: "comparing",
  budgetSignal: "none",
};

const FREE_TEXT_ID = "free-text";

/**
 * scoreLead does not read arrivedAt, so the preview chips are scored against a
 * fixed instant. The real stamp is taken when the operator clicks, because it
 * is what every latency number downstream is measured from.
 */
const PREVIEW_ARRIVED_AT = "2026-01-01T00:00:00.000Z";

type Ingested = {
  runId: string | null;
  caseId: string | null;
  /** Echoed back so the operator can see which click this result belongs to. */
  message: string;
};

export interface IngestDemoProps {
  /** The signed-in tenant. The webhook is public, so the body has to say who. */
  tenantSlug: string;
}

/**
 * The per-send values, built at module scope rather than in the component.
 *
 * All three are impure, and React's purity rule cannot tell that the only
 * caller is an event handler - so it reads them as render-time reads of a
 * moving value. Hoisting them out states plainly that they are computed once
 * per send, and keeps the lint honest instead of suppressed.
 */
function freshIdentity(): { externalId: string; contactPhone: string; arrivedAt: string } {
  return {
    // Case is unique on (tenant, externalId), so a fixed id would turn the
    // second press of a preset into a collision instead of a second lead -
    // exactly the failure that would strand a live demo on its first repeat.
    externalId: `demo-${Date.now().toString(36)}-${nonce()}`,
    // Reserved shape, not decoration: no Indian mobile number carries a
    // leading zero in the subscriber block, so a provider wired up by mistake
    // during the demo has nowhere to deliver.
    contactPhone: `+91-00000-${nonce().padStart(5, "0").slice(0, 5)}`,
    arrivedAt: new Date().toISOString(),
  };
}

export function IngestDemo({ tenantSlug }: IngestDemoProps) {
  const router = useRouter();
  const fieldId = useId();

  const [text, setText] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Ingested | null>(null);
  const [refreshing, startRefresh] = useTransition();

  const busy = sending !== null || refreshing;

  async function ingest(id: string, lead: PresetLead, contactName: string | null) {
    if (busy) return;
    setSending(id);
    setError(null);

    const body = {
      tenantSlug,
      contactName,
      timezone: "Asia/Kolkata",
      ...lead,
      ...freshIdentity(),
    };

    let response: Response;
    try {
      response = await fetch("/api/leads/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
    } catch {
      setSending(null);
      setError("Could not reach the ingest endpoint. Nothing was created.");
      return;
    }

    // A 500 can arrive as an HTML error page, so the body is read as a maybe
    // rather than assumed to match the envelope.
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; data?: unknown }
      | null;

    setSending(null);

    if (!response.ok || !payload?.ok) {
      // The endpoint's own wording, verbatim. Its validation errors name the
      // offending field, which is the one thing worth reading mid-demo.
      setError(
        payload?.error ?? `The ingest endpoint refused this lead (${response.status}).`,
      );
      return;
    }

    setResult({ ...readIds(payload.data), message: lead.message });
    if (id === FREE_TEXT_ID) setText("");
    // The table above is rendered on the server, so a refresh is what makes
    // the new lead appear in it.
    startRefresh(() => router.refresh());
  }

  // Under md the console header is sticky and about 93px tall, so an anchor
  // jump carrying only the desktop margin lands this card's title behind it.
  return (
    <Card id="ingest" className="scroll-mt-28 md:scroll-mt-6">
      <CardHeader className="flex-wrap gap-y-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Zap aria-hidden className="size-4 shrink-0 text-accent-soft" />
            Send a lead in
          </CardTitle>
          <CardDescription>
            Posts to <Mono tone="faint">POST /api/leads/ingest</Mono>, the same public
            webhook a WhatsApp bridge or a website form would hit. The numbers are
            unroutable by construction, so nothing here can reach a real person.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {PRESETS.map((preset) => (
            <PresetButton
              key={preset.id}
              preset={preset}
              busy={busy}
              sending={sending === preset.id}
              onSend={() => ingest(preset.id, preset.lead, preset.contactName)}
            />
          ))}
        </div>

        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const message = text.trim();
            if (!message) return;
            ingest(FREE_TEXT_ID, { ...FREE_TEXT, message }, "Guest");
          }}
        >
          <label htmlFor={fieldId} className="block text-2xs font-medium text-faint uppercase">
            Or type one
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={fieldId}
              value={text}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
              placeholder="Sunday batch available?"
              className={cn(
                "min-w-0 flex-1 rounded-md border border-strong bg-raised px-2.5 py-2",
                "text-sm text-fg placeholder:text-faint",
                "disabled:cursor-not-allowed disabled:opacity-45",
              )}
            />
            <Button
              type="submit"
              variant="secondary"
              icon={Send}
              disabled={busy || text.trim().length === 0}
              loading={sending === FREE_TEXT_ID}
            >
              Send
            </Button>
          </div>
          <p className="text-2xs text-faint">
            Sent as a WhatsApp enquiry from Pune with no service and no budget signal.
          </p>
        </form>

        {error ? (
          <p role="status" className="flex items-start gap-1.5 text-xs leading-relaxed text-state-failed">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </p>
        ) : null}

        {result ? <Result result={result} /> : null}
      </CardContent>
    </Card>
  );
}

function PresetButton({
  preset,
  busy,
  sending,
  onSend,
}: {
  preset: Preset;
  busy: boolean;
  sending: boolean;
  onSend: () => void;
}) {
  const { tier } = scoreLead({ ...preset.lead, arrivedAt: PREVIEW_ARRIVED_AT });

  return (
    <button
      type="button"
      onClick={onSend}
      disabled={busy}
      aria-busy={sending || undefined}
      className={cn(
        "group flex flex-col items-start gap-1.5 rounded-md border border-subtle bg-sunken px-3 py-2.5 text-left",
        "pressable cursor-pointer transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "hover:border-strong hover:bg-raised",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
        sending && "border-accent/50",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        {/* Scored before it is sent, by the same function the row will use
            once it lands - so the chip here and the chip there cannot differ. */}
        <Badge status={tier} />
        <Mono tone="faint" className="text-2xs">
          {preset.lead.source}
        </Mono>
        <Send
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-colors",
            sending ? "text-accent-soft" : "text-faint group-hover:text-accent-soft",
          )}
        />
      </span>
      <span className="text-sm leading-snug text-fg">&ldquo;{preset.lead.message}&rdquo;</span>
      <span className="text-2xs leading-snug text-faint">{preset.note}</span>
    </button>
  );
}

function Result({ result }: { result: Ingested }) {
  return (
    <div className="rounded-md border border-state-executed/30 bg-state-executed/10 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Badge tone="executed" label="Ingested" />
        <span className="min-w-0 truncate text-xs text-muted" title={result.message}>
          &ldquo;{result.message}&rdquo;
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {result.runId ? (
          <>
            <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-faint">
              run
              <Mono copy truncate={16} value={result.runId} tone="muted">
                {result.runId}
              </Mono>
            </span>
            <Link
              href={`/runs/${result.runId}`}
              className={buttonClasses("primary", "sm", "ml-auto")}
            >
              Open the trace
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-muted">
            The endpoint accepted the lead but returned no run id
            {result.caseId ? (
              <>
                {" "}
                for case <Mono tone="muted" truncate={16} value={result.caseId}>{result.caseId}</Mono>
              </>
            ) : null}
            . It is in the table above.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

/**
 * The contract names the response envelope but not where the run id sits
 * inside it, and the route is being written in parallel. Both spellings it
 * could reasonably use are read, rather than betting the demo's one-click move
 * on a guess about someone else's field name.
 */
function readIds(data: unknown): { runId: string | null; caseId: string | null } {
  const root = asRecord(data);
  return {
    runId: asId(root.runId) ?? asId(asRecord(root.run).id),
    caseId: asId(root.caseId) ?? asId(asRecord(root.case).id),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Only has to differ from the last click, never to be unguessable. */
function nonce(): string {
  return Math.random().toString(36).slice(2, 8);
}
