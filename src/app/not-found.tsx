import Link from "next/link";
import { Compass, ShieldCheck } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";

/**
 * Reached by a mistyped URL and, more usefully, by a run id that no longer
 * exists - `pnpm seed --reset` drops every run, so a link copied before a reseed
 * points at nothing. Saying that plainly is the difference between a dead end
 * and a demo that carries on.
 */
export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-accent-soft" />
        <span className="text-base font-semibold tracking-tight">Warden</span>
      </div>

      <div className="enter-rise space-y-4">
        <div className="flex items-start gap-2.5">
          <Compass aria-hidden className="mt-0.5 size-4 shrink-0 text-faint" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">
              Nothing at this address
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              The page does not exist, or it pointed at a case or run that has
              since been reseeded away.
            </p>
          </div>
        </div>

        <Link href="/" className={buttonClasses("secondary", "md")}>
          Back to the inbox
        </Link>
      </div>
    </main>
  );
}
