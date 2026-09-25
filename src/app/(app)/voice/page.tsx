import type { Metadata } from "next";
import Link from "next/link";
import { Activity } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { VoiceConsole } from "@/components/voice/voice-console";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Voice",
  description:
    "Speak an inbound enquiry and watch the agent work it - proposing, and stopping where policy says a person decides.",
};

/**
 * The front door a person can talk to.
 *
 * Listening and speaking happen in the browser, on the Web Speech API. That is
 * why this page needs no key, no vendor account and no phone number to demo:
 * it works from the deployed URL on any laptop with Chrome. Everything past the
 * transcript is the ordinary runtime, so a lead that arrives by voice is gated
 * by the same policy engine as one that arrives by webhook.
 */
export default async function VoicePage() {
  const { tenant } = await requireUser();

  return (
    <div className="space-y-6">
      <header className="enter-fade flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Voice</h1>
          <p className="mt-1 text-sm text-muted">
            Speak an enquiry the way a customer would. The agent proposes; policy decides.
          </p>
        </div>
        <Link href="/approvals" className={buttonClasses("secondary", "md")}>
          <Activity aria-hidden className="size-4" />
          Approval queue
        </Link>
      </header>

      <VoiceConsole tenantName={tenant.name} />

      <p className="text-xs leading-relaxed text-faint">
        Speech recognition and playback run in this browser, on the Web Speech API - not through a
        voice vendor. No key to expire, no per-minute cost, and nothing said here leaves the page
        until a turn is sent. Telephony is a second implementation of the same interface, and needs
        DLT registration before it can dial an Indian number.
      </p>
    </div>
  );
}
