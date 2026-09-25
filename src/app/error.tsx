"use client";

import { useEffect } from "react";
import { RotateCw, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Mono } from "@/components/ui/mono";

/**
 * The boundary above the console shell.
 *
 * (app)/error.tsx cannot catch a throw in (app)/layout.tsx - a boundary never
 * catches the layout it lives inside - and that layout is where requireUser()
 * runs, so a database or auth failure lands here rather than there. That is the
 * gap this file exists to close: without it the same failure reaches Next's
 * default handler, which in production renders an unstyled "Application error"
 * with no way back.
 *
 * It brings its own chrome, because at this level there is none.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] shell failed", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-accent-soft" />
        <span className="text-base font-semibold tracking-tight">Warden</span>
      </div>

      <div className="enter-rise space-y-4">
        <div className="flex items-start gap-2.5">
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-state-failed"
          />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              The console could not start
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              This is the shell itself failing, not one screen inside it - most
              often the database being unreachable. No agent run is affected:
              runs are driven server-side and resume from their last committed
              step whenever this page loads again.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-subtle bg-surface px-4 py-3.5">
          <p className="text-sm break-words text-fg">
            {error.message || "The server did not say what went wrong."}
          </p>
          {error.digest ? (
            <p className="mt-2 text-xs text-muted">
              Server reference{" "}
              <Mono copy value={error.digest} tone="muted">
                {error.digest}
              </Mono>
            </p>
          ) : null}
        </div>

        <Button variant="primary" size="md" icon={RotateCw} onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
