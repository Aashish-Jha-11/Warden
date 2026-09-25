"use client";

import { Check, Info, NotebookPen, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { useDismiss, type Decision } from "@/components/approvals/queue-item";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The two buttons the whole product is built around.
 *
 * Approve is the primary and sits last, because approving is the common case -
 * an action only reaches this queue after passing every policy check, so the
 * operator is confirming a judgement, not catching a fault. Reject is the
 * `danger` variant, which is outlined rather than filled precisely so a screen
 * of these does not read as a screen of alarms.
 *
 * Approving is slow on purpose and the wait is explained rather than hidden.
 * POST /api/actions/[id]/decision signs the action, fires it, and then hands
 * the parked run back to the model, which is a real agent turn - eight to
 * twelve seconds. A spinner with no sentence next to it for twelve seconds
 * reads as a hang, and an operator who reloads mid-turn is an operator who
 * thinks their approval did not take.
 */

type Notice = { tone: "error" | "info"; text: string };

/** How long a decision may run before the wait needs explaining. */
const EXPLAIN_AFTER_MS = 1200;

/** What the decision endpoint answers with. */
type Decided = {
  runStatus?: string;
  actionStatus?: string;
  awaitingActionId?: string | null;
};

export interface DecisionButtonsProps {
  actionId: string;
  /** What the agent wants to do, for the buttons' accessible names. */
  actionLabel?: string;
}

export function DecisionButtons({ actionId, actionLabel }: DecisionButtonsProps) {
  const router = useRouter();
  const noteId = useId();
  const dismiss = useDismiss();

  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Sticky once a decision lands: the row is on its way out of the queue, and
  // re-enabling the buttons for the frame before the refresh paints invites a
  // second click on an action that no longer exists.
  const [settled, setSettled] = useState(false);
  const [refreshing, startRefresh] = useTransition();

  const explainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (explainTimer.current) clearTimeout(explainTimer.current);
    },
    [],
  );

  const busy = pending !== null || refreshing || settled;
  const suffix = actionLabel ? ` ${actionLabel}` : "";

  function stopExplaining() {
    if (explainTimer.current) clearTimeout(explainTimer.current);
    explainTimer.current = null;
    setExplaining(false);
  }

  async function decide(decision: Decision) {
    if (busy) return;
    setPending(decision);
    setNotice(null);
    // Only after a beat. A fast answer that flashes an explanation of why it
    // was slow is worse than no explanation.
    explainTimer.current = setTimeout(() => setExplaining(true), EXPLAIN_AFTER_MS);

    let response: Response;
    try {
      response = await fetch(`/api/actions/${actionId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
    } catch {
      // Nothing is cleared on a failure, least of all the note: it is the
      // operator's own sentence and there is no copy of it anywhere else.
      stopExplaining();
      setPending(null);
      setNotice({
        tone: "error",
        text: "Could not reach the server. Nothing was decided, and your note is still here.",
      });
      return;
    }

    // A 500 can arrive as an HTML error page, so the body is parsed as a
    // maybe rather than assumed to match the contract.
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; data?: Decided }
      | null;

    stopExplaining();

    if (response.status === 409) {
      // Someone in another seat or another tab got here first. The honest move
      // is to say so and take the row out the same way a decision would.
      setSettled(true);
      setNotice({
        tone: "info",
        text: "This was already decided elsewhere. Refreshing the queue.",
      });
      dismiss(null);
      return;
    }

    if (!response.ok || !body?.ok) {
      setPending(null);
      setNotice({
        tone: "error",
        text: body?.error ?? `The server refused this decision (${response.status}).`,
      });
      return;
    }

    setSettled(true);

    // Something went wrong AFTER the decision was committed. The action is no
    // longer PROPOSED either way, so the next render drops this card from the
    // queue - which makes this the only moment the operator will ever be told.
    // The row is deliberately NOT dismissed on these paths: it stays on screen
    // carrying the failure until they clear it themselves.
    const problem = afterTheDecision(decision, body.data);
    if (problem) {
      setNotice({ tone: "error", text: problem });
      return;
    }

    // Nothing to say that the queue itself will not say better a moment from
    // now. The card collapses first and refreshes when it has - see
    // queue-item.tsx for why the refresh waits.
    dismiss(decision);
  }

  return (
    <div className="flex w-full flex-col gap-2.5">
      {noteOpen ? (
        <div>
          <label
            htmlFor={noteId}
            className="mb-1 block text-2xs font-medium text-faint uppercase"
          >
            Note for the record
          </label>
          <textarea
            id={noteId}
            name="note"
            rows={2}
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why you decided this. Stored with the approval."
            className={cn(
              "w-full resize-y rounded-md border border-strong bg-raised px-2.5 py-2",
              "text-sm text-fg placeholder:text-faint",
              "disabled:cursor-not-allowed disabled:opacity-45",
            )}
          />
        </div>
      ) : null}

      {explaining ? (
        <p
          role="status"
          className="enter-fade flex items-start gap-1.5 text-xs leading-relaxed text-muted"
        >
          <RefreshCw aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          {pending === "APPROVED"
            ? "Signing it, sending it, then handing the run back to the agent."
            : "Recording the refusal, then handing the run back to the agent."}{" "}
          That last part is a real model turn, so it takes a few seconds.
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={cn(
            "flex items-start gap-1.5 text-xs leading-relaxed",
            notice.tone === "error" ? "text-state-failed" : "text-muted",
          )}
        >
          {notice.tone === "error" ? (
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-state-proposed" />
          )}
          {notice.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {settled && notice?.tone === "error" ? (
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            Refresh the queue
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={NotebookPen}
              disabled={busy}
              aria-expanded={noteOpen}
              aria-controls={noteOpen ? noteId : undefined}
              onClick={() => setNoteOpen((open) => !open)}
            >
              {noteOpen ? "Hide note" : note.trim() ? "Note added" : "Add a note"}
            </Button>

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="danger"
                icon={X}
                disabled={busy}
                loading={pending === "REJECTED"}
                aria-label={`Reject${suffix}`}
                onClick={() => decide("REJECTED")}
              >
                Reject
              </Button>
              <Button
                variant="primary"
                icon={Check}
                disabled={busy}
                loading={pending === "APPROVED"}
                aria-label={`Approve${suffix}`}
                onClick={() => decide("APPROVED")}
              >
                Approve
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Anything that went wrong once the decision was already committed, said in
 * the operator's terms. Null when the decision landed cleanly.
 *
 * Both of these leave the approval recorded and the card gone, which is
 * exactly the combination that produces an operator who believes a message
 * went out when it did not.
 */
function afterTheDecision(decision: Decision, data: Decided | undefined): string | null {
  if (decision === "APPROVED" && data?.actionStatus === "FAILED") {
    return "Approved, but the send failed. The approval is on record; the message did not go out. Open the run to see why.";
  }
  if (data?.runStatus === "FAILED") {
    const verb = decision === "APPROVED" ? "Approved" : "Rejected";
    return `${verb}, and that part is on record - but the run failed when the agent picked it back up. Open the trace to see where.`;
  }
  return null;
}
