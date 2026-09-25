"use client";

import { Mic } from "lucide-react";
import { useEffect, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { Mono } from "@/components/ui/mono";
import { cn } from "@/lib/utils";
import type { TranscriptTurn } from "@/lib/voice/types";

export interface TranscriptProps {
  turns: TranscriptTurn[];
  /**
   * The utterance in progress - phrases the engine has already settled plus the
   * syllables it is still working on. Shown as it arrives, never stored.
   */
  interim?: string;
  /** A turn is in flight - the agent has been handed the words and is working. */
  thinking?: boolean;
}

/**
 * The conversation, as the browser heard it and as the agent answered it.
 *
 * Sunken ground, because this is a log: it is the one surface on the page that
 * records what happened rather than offering something to do.
 */
export function Transcript({ turns, interim, thinking = false }: TranscriptProps) {
  const viewport = useRef<HTMLDivElement>(null);
  /**
   * Whether the view was at the bottom before this update. Scrolling is only
   * forced when it was: yanking someone back down while they are reading an
   * earlier turn is worse than letting a new line arrive off-screen.
   */
  const pinned = useRef(true);

  useEffect(() => {
    const node = viewport.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [turns, interim, thinking]);

  const empty = turns.length === 0 && !interim && !thinking;

  return (
    <div
      ref={viewport}
      onScroll={() => {
        const node = viewport.current;
        if (!node) return;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
      className="max-h-96 min-h-40 overflow-y-auto bg-sunken px-4 py-3"
    >
      {empty ? (
        <EmptyState
          icon={Mic}
          title="Nothing said yet"
          description="Speak, or type below. Every word appears here as it is recognised, and so does every answer."
          className="py-8"
        />
      ) : (
        // role="log" announces each settled turn to a screen reader as it
        // lands, which matters most on the browsers that cannot speak the
        // reply aloud.
        <ol role="log" aria-label="Voice transcript" className="space-y-3.5">
          {turns.map((turn) => (
            // enter-rise with no --i. Turns append one at a time during a
            // conversation, and an index-based delay would make the twelfth
            // arrive most of a second after it was said.
            <li key={turn.id} className={cn("enter-rise border-l-2 pl-3", RAIL[turn.speaker])}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-2xs font-medium text-faint uppercase">
                  {turn.speaker === "agent" ? "Warden" : "Caller"}
                </span>
                {turn.runStatus ? <Badge status={turn.runStatus} /> : null}
                <Mono tone="faint" className="text-2xs">
                  {clock(turn.at)}
                </Mono>
              </div>
              <p
                className={cn(
                  "mt-1 text-sm leading-relaxed break-words",
                  turn.speaker === "agent" ? "text-fg" : "text-muted",
                )}
              >
                {turn.text}
              </p>
            </li>
          ))}

          {interim ? (
            // Hidden from the log: interim text is the speaker's own sentence
            // being echoed back at them, and it changes on every syllable.
            <li aria-hidden className="border-l-2 border-state-running/60 pl-3">
              <span className="text-2xs font-medium text-state-running uppercase">
                Caller · hearing
              </span>
              <p className="mt-1 text-sm leading-relaxed break-words text-muted italic">
                {interim}
                <span
                  aria-hidden
                  className="ml-0.5 inline-block h-3 w-px animate-pulse bg-state-running align-middle"
                />
              </p>
            </li>
          ) : null}

          {thinking ? (
            <li className="enter-fade border-l-2 border-accent/50 pl-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-2xs font-medium text-faint uppercase">Warden</span>
                <Badge tone="running" label="Working" />
              </div>
              <p className="mt-1 text-sm leading-relaxed text-faint">
                Deciding what to propose, then putting it through policy.
              </p>
            </li>
          ) : null}
        </ol>
      )}
    </div>
  );
}

/** Written out whole so Tailwind's scanner can see both classes. */
const RAIL = {
  caller: "border-subtle",
  agent: "border-accent/50",
} as const;

/**
 * en-GB and 24-hour, so the column is the same width for every turn and does
 * not depend on the judge's locale. Client-only, so there is no server render
 * for it to disagree with.
 */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
