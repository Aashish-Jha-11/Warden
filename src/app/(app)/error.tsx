"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Mono } from "@/components/ui/mono";

/**
 * A page under the console threw.
 *
 * This boundary sits inside (app)/layout.tsx, so the rail and the mobile nav
 * survive and the operator can still reach the other sections - which matters
 * more than it sounds on the one screen that failed, because the reason they
 * opened the app was probably a different screen.
 *
 * Red, not violet. Violet in this product means policy refused to act, which is
 * the system working. This is the system broken, and the two colours must never
 * be swapped.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The client only ever receives the digest in production; the message is
    // redacted. Logging here is what lets someone match this screen to a
    // server line when a judge says "it went red".
    console.error("[console] render failed", error);
  }, [error]);

  return (
    <div className="enter-rise space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Something broke</h1>
        <p className="mt-1 text-sm text-muted">
          This section failed to render. Nothing was sent and no approval was
          decided - the agent only acts through the run loop, which is not this.
        </p>
      </header>

      <div className="rounded-lg border border-state-failed/30 bg-state-failed/10 px-4 py-4">
        <div className="flex items-start gap-2.5">
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-state-failed"
          />
          <div className="min-w-0 space-y-3">
            <p className="text-sm break-words text-fg">
              {error.message || "The server did not say what went wrong."}
            </p>

            {error.digest ? (
              <p className="text-xs text-muted">
                Server reference{" "}
                <Mono copy value={error.digest} tone="muted">
                  {error.digest}
                </Mono>
              </p>
            ) : null}

            <Button variant="secondary" size="sm" icon={RotateCw} onClick={reset}>
              Try this section again
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
