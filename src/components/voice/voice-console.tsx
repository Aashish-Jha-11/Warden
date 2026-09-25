"use client";

import Link from "next/link";
import {
  ArrowRight,
  Gauge,
  Loader2,
  Mic,
  MicOff,
  Quote,
  RotateCcw,
  Send,
  ShieldCheck,
  ShieldX,
  Square,
  Volume2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";

import { Transcript } from "./transcript";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Mono } from "@/components/ui/mono";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { browserSpeechSupport, createBrowserVoice } from "@/lib/voice/browser-speech";
import type {
  RunStatusValue,
  TranscriptTurn,
  VoiceProvider,
  VoiceSupport,
  VoiceTurnAction,
  VoiceTurnBlock,
  VoiceTurnData,
  VoiceTurnRequest,
  VoiceTurnResponse,
} from "@/lib/voice/types";

/**
 * The voice front door.
 *
 * Push to talk, watch the words land, hear the answer - and when the agent
 * decides it needs a person, watch it stop. That stop is the product: the run
 * parks, the proposal appears here with the reason the agent gave, and the
 * queue is one click away.
 *
 * No Motion here on purpose. Everything that moves on this page is an entrance
 * - a card arriving, a row appending - and entrances are CSS utilities in this
 * codebase because they fire while the page is still busy hydrating, where a
 * rAF-driven animation drops frames and a CSS one does not.
 */

type Phase = "idle" | "listening" | "thinking" | "speaking";

type Notice = { tone: "failed" | "proposed"; text: string };

type Outcome = {
  caseId: string;
  subject: string;
  runId: string;
  runStatus: RunStatusValue;
  awaitingAction: VoiceTurnAction | null;
  blocked: VoiceTurnBlock[];
  latencyMs: number;
  steps: number;
};

/** Literal class strings - Tailwind's scanner cannot see an interpolated one. */
const DIAL: Record<Phase, string> = {
  idle: "border-strong bg-raised text-fg hover:border-accent hover:text-accent-soft",
  listening: "border-state-running bg-state-running/14 text-state-running",
  thinking: "border-accent bg-accent/14 text-accent-soft",
  speaking: "border-state-approved bg-state-approved/14 text-state-approved",
};

/**
 * Enquiries that exercise the three things worth seeing, in the words a real
 * caller would use.
 *
 * They are prompts to read aloud, not canned responses: each one is sent
 * through the identical endpoint and the agent decides what to do with it. The
 * outcomes are not scripted either - what makes the first one park is that
 * `send_email` is irreversible, and policy.ts never auto-approves an
 * irreversible action no matter how a tenant is configured.
 */
const OPENERS = [
  {
    label: "Asks for something irreversible",
    text: "Hi, this is Rohan Deshpande. Please email me the full fee structure for the IELTS weekend batch at rohan@example.com today.",
  },
  {
    label: "Asks for a channel this workspace has not enabled",
    text: "Hi, this is Anjali. Please call me right now on 98765 43210, I need to enrol for the IELTS weekend batch before it fills up.",
  },
  {
    label: "An ordinary first enquiry",
    text: "Hi, my name is Meera Kulkarni. I saw your ad for IELTS coaching in Pune. What are the weekend batch fees?",
  },
] as const;

/**
 * Whether this browser can listen is a fact about the browser, so it is read
 * through the store hook rather than set from an effect: the server has no
 * answer at all (hence the null server snapshot, which renders the skeleton),
 * and the client's answer never changes afterwards. Asking in an effect would
 * mean a second render either way, and a hydration mismatch if asked earlier.
 */
const noSubscription = () => () => {};
const noAnswerOnServer = () => null;

export function VoiceConsole({ tenantName }: { tenantName: string }) {
  const provider = useRef<VoiceProvider | null>(null);
  const support = useSyncExternalStore<VoiceSupport | null>(
    noSubscription,
    browserSpeechSupport,
    noAnswerOnServer,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [heard, setHeard] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [typed, setTyped] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  /**
   * Conversation state the provider's handlers need but must not re-subscribe
   * for. The provider hands its handlers over once, at mount, and lives for the
   * life of the page; reading from refs keeps those handlers from closing over
   * a render that has since been replaced.
   */
  const settled = useRef("");
  const partial = useRef("");
  const caseId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  /**
   * One line for the whole utterance in progress, settled words included.
   *
   * The recogniser finalises a phrase every few seconds and clears its interim
   * buffer when it does. Rendering only the interim part means the sentence
   * someone is halfway through vanishes from the screen mid-breath, which reads
   * as the microphone having dropped them.
   */
  const showHeard = useCallback(() => {
    setHeard(`${settled.current} ${partial.current}`.replace(/\s+/g, " ").trim());
  }, []);

  const clearHeard = useCallback(() => {
    settled.current = "";
    partial.current = "";
    setHeard("");
  }, []);

  const append = useCallback((turn: Omit<TranscriptTurn, "id" | "at">) => {
    setTurns((prev) => [...prev, { ...turn, id: `${prev.length}-${Date.now()}`, at: Date.now() }]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (inFlight.current) return;
      inFlight.current = true;

      // Close the mic before the request, not after. A recogniser left open
      // across a turn files the room's noise as the caller's next sentence.
      provider.current?.stop();
      clearHeard();

      setNotice(null);
      setPhase("thinking");
      append({ speaker: "caller", text });

      try {
        const request: VoiceTurnRequest = {
          caseId: caseId.current ?? undefined,
          transcript: text,
        };
        const response = await fetch("/api/voice/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });

        const payload = await readTurn(response);
        if (!payload.ok) {
          setNotice({ tone: "failed", text: payload.error });
          return;
        }

        const data = payload.data;
        caseId.current = data.caseId;
        setOutcome({
          caseId: data.caseId,
          subject: data.subject,
          runId: data.runId,
          runStatus: data.runStatus,
          awaitingAction: data.awaitingAction,
          blocked: data.blocked,
          latencyMs: data.latencyMs,
          steps: data.steps,
        });
        append({ speaker: "agent", text: data.reply, runStatus: data.runStatus });

        setPhase("speaking");
        await provider.current?.speak(data.reply);
      } catch {
        setNotice({
          tone: "failed",
          text: "That turn never reached the server. Check the connection and say it again - nothing was sent to the customer.",
        });
      } finally {
        inFlight.current = false;
        // Only clear the states this call owns; the provider may already have
        // put us back to listening by the time the reply finished playing.
        setPhase((current) => (current === "thinking" || current === "speaking" ? "idle" : current));
      }
    },
    [append, clearHeard],
  );

  useEffect(() => {
    const voice = createBrowserVoice();
    provider.current = voice;

    voice.onPartial((text) => {
      partial.current = text;
      showHeard();
    });
    voice.onFinal((text) => {
      settled.current = settled.current ? `${settled.current} ${text}` : text;
      partial.current = "";
      showHeard();
    });
    voice.onStatus((status) => {
      setPhase((current) => {
        // A request outranks the microphone: the provider reports idle the
        // instant we close the mic to send, and that is not what is happening.
        if (current === "thinking") return current;
        if (status === "listening") return "listening";
        return status === "speaking" ? "speaking" : "idle";
      });
    });
    voice.onFailure((failure) => {
      setNotice({
        tone: failure.code === "permission_denied" ? "proposed" : "failed",
        text: failure.message,
      });
    });

    return () => voice.dispose();
  }, [showHeard]);

  const toggle = useCallback(() => {
    if (phase === "listening") {
      const said = `${settled.current} ${partial.current}`.replace(/\s+/g, " ").trim();
      provider.current?.stop();
      clearHeard();
      if (!said) {
        setNotice({
          tone: "proposed",
          text: "Nothing was recognised. Check the microphone your browser is using, then try again.",
        });
        setPhase("idle");
        return;
      }
      void send(said);
      return;
    }
    setNotice(null);
    clearHeard();
    void provider.current?.start();
  }, [clearHeard, phase, send]);

  const reset = useCallback(() => {
    provider.current?.stop();
    caseId.current = null;
    clearHeard();
    setTurns([]);
    setOutcome(null);
    setNotice(null);
    setTyped("");
    setPhase("idle");
  }, [clearHeard]);

  const onTyped = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const text = typed.trim();
      if (!text) return;
      setTyped("");
      void send(text);
    },
    [send, typed],
  );

  const pickOpener = useCallback((text: string) => {
    setTyped(text);
    input.current?.focus();
  }, []);

  const busy = phase === "thinking" || phase === "speaking";
  const voiceOff = support !== null && !support.supported;
  const awaiting = outcome?.awaitingAction ?? null;
  const blocked = outcome?.blocked ?? [];

  return (
    <div className="space-y-6">
      <Card className="enter-rise">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Talk to the agent</CardTitle>
            <CardDescription>
              Say what an enquiry would say. {tenantName}&rsquo;s policy decides what happens next.
            </CardDescription>
          </div>
          {outcome ? (
            <Badge status={outcome.runStatus} />
          ) : (
            <Badge tone="quiet" pip={false} label="No run yet" />
          )}
        </CardHeader>

        <CardContent className="flex flex-col items-center gap-4 py-7">
          {support === null ? (
            <>
              <Skeleton className="size-24 rounded-full" />
              <Skeleton className="h-3.5 w-56" />
            </>
          ) : !support.supported ? (
            <VoiceUnavailable reason={support.reason} />
          ) : (
            <>
              <button
                type="button"
                onClick={toggle}
                disabled={busy}
                aria-pressed={phase === "listening"}
                aria-label={phase === "listening" ? "Stop and send" : "Start talking"}
                className={cn(
                  "pressable relative flex size-24 cursor-pointer items-center justify-center rounded-full border-2",
                  "transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
                  "disabled:cursor-not-allowed disabled:opacity-80 disabled:active:scale-100",
                  DIAL[phase],
                )}
              >
                {phase === "listening" ? (
                  <span
                    aria-hidden
                    className="absolute inset-0 animate-ping rounded-full border-2 border-state-running/40"
                  />
                ) : null}
                <DialIcon phase={phase} />
              </button>
              <p aria-live="polite" className="max-w-sm text-center text-sm text-muted">
                {HELP[phase](Boolean(outcome))}
              </p>
            </>
          )}

          {notice ? (
            <p
              role="alert"
              className={cn(
                "enter-fade w-full rounded-md border px-3 py-2 text-xs leading-relaxed",
                notice.tone === "failed"
                  ? "border-state-failed/30 bg-state-failed/10 text-state-failed"
                  : "border-state-proposed/30 bg-state-proposed/10 text-state-proposed",
              )}
            >
              {notice.text}
            </p>
          ) : null}
        </CardContent>

        {outcome ? (
          <CardFooter className="flex-wrap justify-between gap-x-4 gap-y-2">
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
              <span className="inline-flex items-center gap-1.5">
                <Gauge aria-hidden className="size-3.5" />
                <Mono tone="faint">{`${(outcome.latencyMs / 1000).toFixed(1)}s`}</Mono>
              </span>
              <span>
                <Mono tone="faint">{String(outcome.steps)}</Mono> steps
              </span>
              <Link
                href={`/runs/${outcome.runId}`}
                className="underline decoration-subtle underline-offset-4 transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-fg hover:decoration-strong"
              >
                Watch the trace
              </Link>
            </span>
            <Button variant="ghost" size="sm" icon={RotateCcw} onClick={reset} disabled={busy}>
              New enquiry
            </Button>
          </CardFooter>
        ) : (
          <CardFooter className="flex-col items-stretch justify-start gap-2">
            <p className="text-2xs font-medium text-faint uppercase">
              {voiceOff ? "Send one of these" : "Read one of these aloud"}
            </p>
            {OPENERS.map((opener, i) => (
              <button
                key={opener.label}
                type="button"
                onClick={() => pickOpener(opener.text)}
                style={{ "--i": i + 1 } as CSSProperties}
                className={cn(
                  "enter-fade pressable group cursor-pointer rounded-md border border-subtle bg-sunken px-3 py-2 text-left",
                  "transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                  "hover:border-strong hover:bg-raised",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                )}
              >
                <span className="flex items-start gap-2">
                  <Quote aria-hidden className="mt-0.5 size-3 shrink-0 text-faint" />
                  <span className="min-w-0">
                    <span className="block text-sm leading-relaxed text-muted group-hover:text-fg">
                      {opener.text}
                    </span>
                    <span className="mt-0.5 block text-2xs text-faint uppercase">
                      {opener.label} · tap to put it in the box
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </CardFooter>
        )}
      </Card>

      {blocked.length > 0 ? <Stopped blocked={blocked} /> : null}
      {awaiting && outcome ? <Handoff action={awaiting} runId={outcome.runId} /> : null}

      <Card className="enter-rise" style={{ "--i": 1 } as CSSProperties}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Transcript</CardTitle>
            <CardDescription className="truncate">
              {outcome ? (
                <>
                  Case <Mono value={outcome.caseId} truncate={12} copy tone="muted" /> ·{" "}
                  {outcome.subject}
                </>
              ) : (
                "No case yet. The first thing you say opens one."
              )}
            </CardDescription>
          </div>
          {turns.length > 0 ? (
            <Badge
              tone="quiet"
              pip={false}
              label={
                <>
                  <Mono tone="faint">{String(turns.length)}</Mono>
                  <span className="ml-1">turns</span>
                </>
              }
            />
          ) : null}
        </CardHeader>

        <Transcript turns={turns} interim={heard} thinking={phase === "thinking"} />

        <CardFooter className="justify-start">
          <form onSubmit={onTyped} className="flex w-full items-center gap-2">
            <label htmlFor="voice-typed" className="sr-only">
              Type what the customer would say
            </label>
            <input
              id="voice-typed"
              ref={input}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={phase === "thinking"}
              maxLength={2000}
              autoComplete="off"
              placeholder={voiceOff ? "Type the enquiry here" : "or type it"}
              className={cn(
                "h-8 min-w-0 flex-1 rounded-md border border-strong bg-raised px-2.5 text-sm text-fg",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                "placeholder:text-faint focus-visible:border-accent focus-visible:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-45",
              )}
            />
            <Button
              type="submit"
              variant={voiceOff ? "primary" : "secondary"}
              size="sm"
              icon={Send}
              loading={phase === "thinking"}
              disabled={!typed.trim()}
            >
              Send
            </Button>
          </form>
        </CardFooter>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

const HELP: Record<Phase, (resumed: boolean) => string> = {
  idle: (resumed) =>
    resumed
      ? "Press to answer back. The agent picks up the same case."
      : "Press, say what a customer would say, then press again to send it.",
  listening: () => "Listening. Press again when you have finished the sentence.",
  thinking: () => "Working. Everything it wants to do goes through policy first.",
  speaking: () => "Answering. The microphone is off while it talks.",
};

function DialIcon({ phase }: { phase: Phase }) {
  if (phase === "thinking") return <Loader2 aria-hidden className="size-8 animate-spin" />;
  if (phase === "speaking") return <Volume2 aria-hidden className="size-8" />;
  if (phase === "listening") return <Square aria-hidden className="size-7 fill-current" />;
  return <Mic aria-hidden className="size-8" />;
}

/**
 * Reads the answer without assuming there is one.
 *
 * Two things this has to survive. A response that is not JSON at all - an HTML
 * error page from a proxy - throws inside json(), and reporting that as "the
 * network failed" sends whoever is demoing to go and look at their wifi. And a
 * 401, which in production is written by the middleware rather than by the
 * route and carries `{ error: "unauthenticated" }` - a true statement, and a
 * useless thing to put in front of a person mid-sentence. So the status is read
 * first and the body only where it can actually say something better.
 */
async function readTurn(response: Response): Promise<VoiceTurnResponse> {
  if (response.status === 401) {
    return { ok: false, error: "Your session has expired. Sign in again and say it once more." };
  }

  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const shape = body as { ok?: unknown; data?: unknown; error?: unknown };
      if (shape.ok === true && shape.data) {
        return { ok: true, data: shape.data as VoiceTurnData };
      }
      if (typeof shape.error === "string") return { ok: false, error: shape.error };
    }
  } catch {
    // Fall through to the status-based wording below.
  }

  return {
    ok: false,
    error: `The server answered ${response.status} and not in the shape this page expects. Nothing was sent to the customer.`,
  };
}

/**
 * The page must never be a dead end. Firefox and Safari ship no recogniser, and
 * a judge who opens the link there still has to be able to run the demo - so
 * this explains the gap in one line and points at the box that does the same
 * thing, which posts to the identical endpoint.
 */
function VoiceUnavailable({ reason }: { reason: string }) {
  return (
    <div className="w-full space-y-2.5">
      <div className="flex items-start gap-2.5 rounded-md border border-subtle bg-raised px-3 py-2.5">
        <MicOff aria-hidden className="mt-0.5 size-4 shrink-0 text-faint" />
        <div className="min-w-0">
          <p className="text-sm text-fg">Voice is off in this browser.</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{reason}</p>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-faint">
        Type the enquiry below instead. It runs the identical turn - same case, same run, same
        policy checks - and the only thing missing is the sound.
      </p>
    </div>
  );
}

/**
 * What policy refused, in violet.
 *
 * A blocked proposal does not stop a run - the agent is told why and picks
 * something else - so without this the most characteristic thing the product
 * does passes by inside a single spoken sentence. Violet, never red: this is
 * the guardrail working.
 */
function Stopped({ blocked }: { blocked: VoiceTurnBlock[] }) {
  return (
    <Card className="enter-rise border-state-blocked/40">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <ShieldX aria-hidden className="size-4 shrink-0 text-state-blocked" />
            Policy stopped it
          </CardTitle>
          <CardDescription>
            The agent proposed this and a rule it cannot see refused. It was told why, and it
            carried on with something else.
          </CardDescription>
        </div>
        <Badge status="BLOCKED" />
      </CardHeader>

      <CardContent className="space-y-2">
        {blocked.map((block, i) => (
          <div
            key={`${block.check}-${i}`}
            className="rounded-md border border-subtle bg-sunken px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Mono tone="default" className="text-state-blocked">
                {block.check}
              </Mono>
              {block.actionType ? (
                <>
                  <span className="text-2xs text-faint uppercase">refused</span>
                  <Mono tone="muted">{block.actionType}</Mono>
                </>
              ) : null}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted">{block.detail}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * The moment the demo is built around. The agent has proposed something it is
 * not allowed to do on its own and stopped, and this is where that is said out
 * loud - in amber, with the agent's own reason, one click from the queue.
 */
function Handoff({ action, runId }: { action: VoiceTurnAction; runId: string }) {
  const card = useRef<HTMLDivElement>(null);

  // Brought into view rather than left below the fold. This card is the answer
  // to the sentence that was just spoken, and on a laptop it lands under the
  // transcript where nobody is looking. `nearest` so a card already on screen
  // does not jump.
  useEffect(() => {
    card.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [action.id]);

  return (
    <div ref={card}>
      <Card className="enter-rise border-state-proposed/40">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="size-4 shrink-0 text-state-proposed" />
              It stopped and asked
            </CardTitle>
            <CardDescription>
              The agent proposed this and went no further. Nothing reaches the customer until a
              person signs it.
            </CardDescription>
          </div>
          <Badge status={action.status} />
        </CardHeader>

        <CardContent className="space-y-3">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
            <Field label="Action">
              <Mono>{action.type}</Mono>
            </Field>
            <Field label="Value">
              <Mono>{rupees(action.valuePaise)}</Mono>
            </Field>
            <Field label="Action id">
              <Mono value={action.id} truncate={16} copy />
            </Field>
            <Field label="Run">
              <Mono value={runId} truncate={16} copy />
            </Field>
          </dl>

          <p className="rounded-md border border-subtle bg-sunken px-3 py-2 text-sm leading-relaxed text-muted">
            {action.reason}
          </p>
        </CardContent>

        <CardFooter className="flex-wrap justify-between gap-2">
          <Link
            href={`/runs/${runId}`}
            className={buttonClasses("ghost", "md", "text-muted hover:text-fg")}
          >
            See the whole trace
          </Link>
          <Link href="/approvals" className={buttonClasses("primary", "md")}>
            Open the approval queue
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium text-faint uppercase">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  );
}

function rupees(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2)}`;
}
