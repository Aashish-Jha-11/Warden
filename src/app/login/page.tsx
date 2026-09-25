import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { createClient, requestOrigin } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Warden proposes every action against an inbound lead; a policy engine decides whether it happens.",
};

/**
 * Readable text for every way this page can be arrived at with a failure.
 *
 * Anything not listed falls through to whatever the provider said, which is
 * why the callback route forwards a short reason alongside the code: a person
 * who cannot get in needs a sentence, and the sentence has to be true even
 * for a failure mode nobody anticipated.
 */
const ERROR_COPY: Record<string, string> = {
  access_denied: "Sign-in was cancelled at Google. Nothing was shared with Warden.",
  missing_code: "Google sent you back without an authorisation code. Try signing in again.",
  exchange_failed: "That sign-in link had already been used, or it expired. Try again.",
  missing_email:
    "That account did not share an email address. Warden identifies a workspace by email, so there is nothing to sign you in to.",
  oauth_unavailable:
    "Could not start Google sign-in. Check that the Google provider is enabled in Supabase.",
};

/**
 * Starts the OAuth round trip from the server.
 *
 * Running it here rather than from a browser client means the PKCE verifier is
 * written as an httpOnly cookie by the same code path that later reads it in
 * /auth/callback, and the page needs no client JavaScript at all - a form post
 * is enough, which is a strange thing to care about until the one time the
 * bundle fails to load and sign-in still works.
 */
async function continueWithGoogle() {
  "use server";

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${await requestOrigin()}/auth/callback` },
  });

  // redirect() throws to unwind, so both calls stay outside any try/catch.
  if (error || !data?.url) {
    const reason = encodeURIComponent(error?.message ?? "");
    redirect(`/login?error=oauth_unavailable&reason=${reason}`);
  }

  redirect(data.url);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = firstValue(params.error);
  const problem = code
    ? (ERROR_COPY[code] ?? asSentence(firstValue(params.reason)) ?? "Sign-in did not complete. Try again.")
    : null;

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-6 py-16">
      {/* One soft light source above the card, so it reads as lit by the page
          rather than pasted onto it. Nothing else on this screen moves. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-48 h-96"
        style={{
          backgroundImage:
            "radial-gradient(52% 100% at 50% 100%, color-mix(in oklab, var(--color-accent) 14%, transparent), transparent 72%)",
        }}
      />

      <div className="relative w-full max-w-[23rem]">
        <header className="mb-9 flex flex-col items-center text-center">
          <span
            style={{ "--i": 0 } as React.CSSProperties}
            className="enter-rise mb-5 flex size-11 items-center justify-center rounded-lg border border-subtle bg-surface"
          >
            <ShieldCheck className="size-5 text-accent-soft" strokeWidth={1.75} aria-hidden />
          </span>
          <h1
            style={{ "--i": 1 } as React.CSSProperties}
            className="enter-rise text-4xl font-semibold tracking-tight text-fg"
          >
            Warden
          </h1>
          <p
            style={{ "--i": 2 } as React.CSSProperties}
            className="enter-rise mt-3 text-sm leading-relaxed text-balance text-muted"
          >
            An operations agent for inbound leads. It proposes every action; a policy engine it
            cannot influence decides whether that action happens.
          </p>
        </header>

        <div
          style={{ "--i": 3 } as React.CSSProperties}
          className="enter-rise rounded-xl border border-subtle bg-surface p-6 shadow-overlay"
        >
          {problem ? (
            <p
              role="alert"
              className="mb-5 rounded-md border border-state-proposed/30 bg-state-proposed/10 px-3 py-2.5 text-xs leading-relaxed text-state-proposed"
            >
              {problem}
            </p>
          ) : null}

          <form action={continueWithGoogle}>
            <button
              type="submit"
              className="pressable flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-md bg-fg px-4 py-2.5 text-base font-medium text-canvas transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-white"
            >
              <GoogleMark />
              Continue with Google
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-faint">
            Google is the only way in. Warden never handles a password.
          </p>
        </div>

        <p
          style={{ "--i": 4 } as React.CSSProperties}
          className="enter-rise mt-6 text-center text-xs leading-relaxed text-balance text-faint"
        >
          {/* "sets up" rather than "creates": an address a workspace is already
              waiting on joins that one instead of minting a second. */}
          Signing in for the first time sets up your workspace with contact windows, per-case
          attempt limits and the approval queue already switched on.
        </p>
      </div>
    </main>
  );
}

/** Google's brand mark. Inlined because the button has to render before anything else does. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-[18px] shrink-0" aria-hidden focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function firstValue(value: string | string[] | undefined): string | null {
  const single = Array.isArray(value) ? value[0] : value;
  const trimmed = single?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Provider text arrives in the query string. React escapes it on render, so
 * the only thing left to bound is length - an unabridged provider dump would
 * push the sign-in button off the card, which is the one element that has to
 * stay reachable on this page.
 */
function asSentence(reason: string | null): string | null {
  if (!reason) return null;
  const text = reason.replace(/_/g, " ").slice(0, 180);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
