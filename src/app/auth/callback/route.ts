import { NextResponse, type NextRequest } from "next/server";

import { createClient, requestOrigin } from "@/lib/supabase/server";

/**
 * Where Google returns the browser after the consent screen.
 *
 * Three things can arrive here and only one of them is a success, so each
 * failure is turned into a short stable code and handed back to /login, which
 * owns the wording. A stack trace on this route would be the first thing a new
 * user ever saw of Warden.
 *
 * The authorisation code is single-use and short-lived. That makes a reload of
 * this URL - back button, a link a browser prefetched - a normal event rather
 * than a bug, and it lands on "that link was already used" instead of a 500.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const origin = await requestOrigin();

  // A refusal is reported on the redirect itself, never as an exchange failure:
  // declining at the consent screen sends error=access_denied and no code.
  const denial = params.get("error");
  if (denial) {
    return backToLogin(origin, denial, params.get("error_description"));
  }

  const code = params.get("code");
  if (!code) {
    return backToLogin(origin, "missing_code", null);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return backToLogin(origin, "exchange_failed", error.message);
  }

  // The session cookies were written through the server client's setAll during
  // the exchange; Next attaches them to whatever this handler returns.
  return NextResponse.redirect(new URL("/", origin));
}

function backToLogin(origin: string, code: string, reason: string | null): NextResponse {
  const login = new URL("/login", origin);
  login.searchParams.set("error", code);
  // Carried only as a fallback for a code /login has no copy for. Bounded here
  // rather than there, so an oversized provider message never reaches a URL.
  if (reason) login.searchParams.set("reason", reason.slice(0, 200));
  return NextResponse.redirect(login);
}
