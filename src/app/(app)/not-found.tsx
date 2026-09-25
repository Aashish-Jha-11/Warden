import Link from "next/link";
import { Compass } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty";

/**
 * The 404 an operator hits from inside the console.
 *
 * Almost always a run or case id that no longer exists: `pnpm seed --reset`
 * drops every run, so a `/runs/{id}` link copied before a reseed points at
 * nothing. This boundary sits inside (app)/layout.tsx, so the rail and the
 * mobile nav stay - the root not-found.tsx cannot keep them, because it is
 * above that layout and there is no session to render it with.
 */
export const metadata = { title: "Not found" };

export default function ConsoleNotFound() {
  return (
    <div className="enter-rise space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
        <p className="mt-1 text-sm text-muted">
          Nothing in this workspace answers to that address.
        </p>
      </header>

      <EmptyState
        icon={Compass}
        title="That page or record is gone"
        description="If you followed a link to a run or a case, it was most likely cleared by a reseed. The inbox always lists what exists right now."
        action={
          <Link href="/" className={buttonClasses("secondary", "sm")}>
            Back to the inbox
          </Link>
        }
      />
    </div>
  );
}
