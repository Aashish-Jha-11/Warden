"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a live run's trace moving, and - more importantly - stops.
 *
 * The naive version of this is `setInterval(router.refresh, 2000)`, and it has
 * three failure modes that all end the same way: a page left open in a
 * background tab quietly re-renders a server component against Supabase every
 * two seconds, forever. During judging that is fatal, and the first symptom is
 * the whole app going slow for reasons nobody can see.
 *
 * So the poll is a cheap probe rather than a re-render. It reads the same
 * bounded endpoint the trace is built from, compares the run's status and step
 * count against what the server already rendered, and only pays for a refresh
 * when something actually changed. It ends itself on a terminal status, on a
 * hidden tab, on repeated network failure, and on a hard deadline.
 *
 * The loop is `startPoll`, deliberately separate from the component and taking
 * its clock, its fetch and its visibility as arguments. A stop condition you
 * cannot run is a stop condition you are taking on trust.
 */

/** Statuses where no further step will ever be committed without a person. */
export const SETTLED: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "BLOCKED_BY_POLICY",
  // Parked, not finished. It resumes from the approvals queue, which is a
  // navigation away - and a run that may sit here for an hour must not hold a
  // two-second poll open while it does.
  "AWAITING_APPROVAL",
]);

/** Consecutive network failures before this gives up rather than retrying. */
const MAX_FAILURES = 3;

/**
 * A run that dies mid-flight - the tsx process killed, the provider hanging -
 * never reaches a terminal status, so without this the probe would outlive it.
 * Ten minutes is far longer than any real run and far shorter than a workday.
 */
const DEADLINE_MS = 10 * 60_000;

export interface PollOptions {
  caseId: string;
  runId: string;
  /** The run status the server last rendered. */
  status: string;
  /** The step count the server last rendered, to detect progress. */
  stepCount: number;
  intervalMs: number;
  /** Called once, when the run has moved. The caller re-renders and re-arms. */
  onProgress: () => void;
  /** Seams. The browser supplies the real ones; a harness supplies fakes. */
  fetcher?: typeof fetch;
  isVisible?: () => boolean;
  now?: () => number;
  deadlineMs?: number;
}

export interface Poll {
  /** Ends the loop permanently and aborts anything in flight. */
  stop: () => void;
  /** Re-arms a loop that parked itself because the tab was hidden. */
  wake: () => void;
  /** Diagnostics: requests actually sent, and whether the loop is finished. */
  readonly state: { requests: number; stopped: boolean };
}

export function startPoll(options: PollOptions): Poll {
  const {
    caseId,
    runId,
    status,
    stepCount,
    intervalMs,
    onProgress,
    // Bound explicitly. A bare `fetch` reference works in every engine we
    // target, but binding costs nothing and removes the question entirely.
    fetcher = globalThis.fetch.bind(globalThis),
    isVisible = () => true,
    now = Date.now,
    deadlineMs = DEADLINE_MS,
  } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let stopped = false;
  let inFlight = false;
  let failures = 0;
  const state = { requests: 0, stopped: false };
  const deadline = now() + deadlineMs;

  const stop = () => {
    stopped = true;
    state.stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  // A self-scheduling timeout, never setInterval: a slow response on a bad
  // connection would otherwise stack probes on top of each other, which is the
  // exact shape of hammering we are trying not to do.
  const schedule = () => {
    if (stopped) return;
    if (now() > deadline) {
      stop();
      return;
    }
    timer = setTimeout(() => void probe(), intervalMs);
  };

  const probe = async () => {
    // The timeout that called this is spent, so the handle is cleared here
    // rather than on the way out: `timer === null` is what wake() reads as
    // "the loop is not armed".
    timer = null;
    if (stopped || inFlight) return;
    // Returning without scheduling parks the loop. wake() is what arms it
    // again, and the component only calls that when the tab comes back.
    if (!isVisible()) return;

    inFlight = true;
    controller = new AbortController();
    try {
      state.requests += 1;
      const response = await fetcher(`/api/cases/${caseId}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (stopped) return;

      // A 401 means the session went, and refreshing would bounce to /login -
      // the right answer, but not one to retry into.
      if (!response.ok) {
        stop();
        return;
      }

      const run = findRun(await response.json(), runId);
      if (!run) {
        stop();
        return;
      }
      failures = 0;

      if (run.status !== status || run.stepCount !== stepCount) {
        // Something committed. This is the only path that costs a render, and
        // the re-render re-arms a fresh loop with the new baseline.
        onProgress();
        stop();
        return;
      }

      if (SETTLED.has(run.status)) {
        stop();
        return;
      }
    } catch (error) {
      if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
      failures += 1;
      if (failures >= MAX_FAILURES) {
        stop();
        return;
      }
    } finally {
      controller = null;
      inFlight = false;
    }

    schedule();
  };

  const wake = () => {
    if (stopped || timer !== null || inFlight) return;
    void probe();
  };

  schedule();
  return { stop, wake, state };
}

export interface LiveRefreshProps {
  caseId: string;
  runId: string;
  status: string;
  stepCount: number;
  intervalMs?: number;
}

export function LiveRefresh({
  caseId,
  runId,
  status,
  stepCount,
  intervalMs = 2000,
}: LiveRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    if (SETTLED.has(status)) return;

    const poll = startPoll({
      caseId,
      runId,
      status,
      stepCount,
      intervalMs,
      onProgress: () => router.refresh(),
      isVisible: () => document.visibilityState === "visible",
    });

    const onVisibility = () => {
      if (document.visibilityState === "visible") poll.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      poll.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [caseId, runId, status, stepCount, intervalMs, router]);

  return null;
}

/**
 * Narrows the polled body down to the one run this page is showing.
 *
 * Field by field rather than cast: the probe's whole job is to decide whether
 * to stop, and a shape it does not recognise must read as "stop", never as an
 * exception inside a timer callback.
 */
export function findRun(
  body: unknown,
  runId: string,
): { status: string; stepCount: number } | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null;
  const runs = body.data.runs;
  if (!Array.isArray(runs)) return null;

  for (const run of runs) {
    if (!isRecord(run) || run.id !== runId) continue;
    if (typeof run.status !== "string" || typeof run.stepCount !== "number") return null;
    return { status: run.status, stepCount: run.stepCount };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
