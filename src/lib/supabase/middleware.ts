import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh, and the one place that decides whether a request is allowed
 * to reach a route at all.
 *
 * This runs before anything renders, which is why it holds the refresh: an
 * access token that expires mid-session has to be exchanged somewhere a
 * `Set-Cookie` can still be attached, and a Server Component is too late.
 *
 * It is a gate, not the authorisation model. Tenant scoping lives in
 * src/lib/auth/session.ts and is re-established on every server render, because
 * a check that only happens out here is a check that a route added tomorrow
 * silently opts out of.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Reachable without a session: the sign-in page and the OAuth round trip. */
const PUBLIC_PATHS = ["/login", "/auth"];

/**
 * Endpoints whose caller is a machine, not a person with cookies.
 *
 * The lead webhook is posted to by a form provider or a WhatsApp bridge. It
 * authenticates itself at the route; running a session refresh on its behalf
 * would only burn a round trip and hand it `Set-Cookie` headers it will never
 * send back.
 */
const MACHINE_PATHS = ["/api/leads/ingest"];

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (covers(MACHINE_PATHS, pathname)) return NextResponse.next();

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Fail closed, loudly. Unset configuration must never resolve to "everyone
    // is signed in", and a 500 on the first page load is a far cheaper way to
    // find out than an open app.
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Copy .env.example to .env.",
    );
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        // Refreshed tokens have to land on both sides: on the request, so the
        // route being rendered downstream reads the new session rather than the
        // expired one, and on the response, so the browser keeps it.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // A refreshed session travels in Set-Cookie. A CDN or reverse proxy
        // that caches this response serves one user's tokens to the next one,
        // so the library hands us the no-store headers that prevent it.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // This must be the first await after the client exists. A refresh that
  // completes once the response is already built has nowhere to write its
  // cookies, so the next request refreshes again - the loop that presents to
  // users as random logouts.
  //
  // getClaims() rather than getUser(): with asymmetric signing keys it verifies
  // the token locally, which matters on a check that runs on every navigation.
  // The authoritative call lives in requireUser(), once per render, where the
  // answer decides which tenant's rows get read.
  const { data, error } = await supabase.auth.getClaims();
  const signedIn = !error && Boolean(data?.claims);

  if (!signedIn && !covers(PUBLIC_PATHS, pathname)) {
    // An API client asked for JSON and should be told no in JSON. Redirecting
    // it to the login page answers a fetch() with an HTML document, which
    // surfaces as a parse error somewhere far from the actual cause.
    if (pathname.startsWith("/api/")) {
      return json401(response);
    }
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return carryCookies(response, NextResponse.redirect(login));
  }

  // A signed-in user staring at a sign-in page is a dead end. The exception is
  // a page carrying an error: requireUser() bounces an unusable identity back
  // here with a reason, and sending it straight back to "/" would put the two
  // of them in a redirect loop with the explanation lost in the middle.
  if (signedIn && pathname === "/login" && !request.nextUrl.searchParams.has("error")) {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return carryCookies(response, NextResponse.redirect(home));
  }

  return response;
}

function covers(prefixes: readonly string[], pathname: string): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * A redirect built from scratch does not inherit the cookies a refresh just
 * wrote - including the deletions that a failed refresh issues. Dropping them
 * leaves the stale token in place and every subsequent request repeats the
 * same doomed refresh.
 */
function carryCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(header);
    if (value) to.headers.set(header, value);
  }
  return to;
}

function json401(from: NextResponse): NextResponse {
  return carryCookies(
    from,
    NextResponse.json({ error: "unauthenticated", detail: "Sign in at /login." }, { status: 401 }),
  );
}
