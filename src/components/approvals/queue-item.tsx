"use client";

import { motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * One row of the queue, and the only place in this product where the Motion
 * library earns its import.
 *
 * Everything else here animates in CSS, because entrances fire while the page
 * is still hydrating and CSS runs off the main thread. This does not: a card
 * leaving the queue is interruptible, state-driven change whose start value is
 * a measured height nobody can write into a stylesheet. A decided card that
 * simply disappears when the server re-render lands reads as a page glitch -
 * the operator cannot tell their click from a refresh - so it collapses first
 * and the refresh is held until it has.
 *
 * The decision itself is reported up from DecisionButtons through context,
 * which is what lets this wrapper stay a client component while the card
 * between them stays on the server.
 */

export type Decision = "APPROVED" | "REJECTED";

/** null means "gone, but not by us" - the 409 path, where someone else decided. */
type Dismiss = (decision: Decision | null) => void;

const DismissContext = createContext<Dismiss | null>(null);

const NOTHING: Dismiss = () => {};

/**
 * Handed to DecisionButtons. Falls back to a no-op rather than throwing, so
 * the buttons still work if they are ever rendered outside a queue - on a run
 * trace, say, where there is no row to collapse.
 */
export function useDismiss(): Dismiss {
  return useContext(DismissContext) ?? NOTHING;
}

/** The one curve in the system. Motion takes it as an array, CSS as a token. */
const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Hoisted so the resting state is referentially stable across renders. */
const RESTING = {} as const;
const LEAVING = { opacity: 0, height: 0, paddingBottom: 0 } as const;
const LEAVING_REDUCED = { opacity: 0 } as const;

export interface QueueItemProps {
  children: ReactNode;
}

export function QueueItem({ children }: QueueItemProps) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [decided, setDecided] = useState<Decision | null | "gone">(null);
  const [, startRefresh] = useTransition();

  const leaving = decided !== null;

  const dismiss = useCallback<Dismiss>((decision) => {
    setDecided(decision ?? "gone");
  }, []);

  // Held until the collapse has finished. The server re-render is what
  // actually removes this row, and firing it at click time would race the
  // animation off the screen on a fast connection.
  const settle = useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

  return (
    <DismissContext.Provider value={dismiss}>
      <motion.li
        // No entrance here. Rows arrive with the CSS `enter-rise` on the card
        // itself; only the exit needs a measured start value.
        initial={false}
        animate={leaving ? (reduced ? LEAVING_REDUCED : LEAVING) : RESTING}
        // The delay is the outline's, not the collapse's. Approving and
        // rejecting otherwise look identical - both rows just leave - and one
        // beat of teal or clay is what tells an operator which button they
        // actually hit. 140 + 320 keeps the whole exit inside half a second.
        transition={{
          duration: reduced ? 0.12 : 0.32,
          delay: reduced ? 0 : 0.14,
          ease: EASE_OUT,
        }}
        onAnimationComplete={leaving ? settle : undefined}
        // Clipped only on the way out. Holding it hidden at rest would crop
        // the 10px rise of the card's own CSS entrance.
        style={{ overflow: leaving ? "hidden" : "visible" }}
        className="pb-4 last:pb-0"
        aria-busy={leaving || undefined}
      >
        {/*
          A line, not a shadow - this system structures with borders. It marks
          which way the decision went for the moment before the row leaves,
          which is the only feedback an operator gets that their click landed
          on this card and not the one below it.
        */}
        <div
          className={cn(
            "rounded-lg outline outline-transparent -outline-offset-1",
            "transition-[outline-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
            decided === "APPROVED" && "outline-state-approved",
            decided === "REJECTED" && "outline-state-rejected",
          )}
        >
          {children}
        </div>
      </motion.li>
    </DismissContext.Provider>
  );
}
