import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";

/**
 * Supabase client for server components, route handlers and server actions.
 *
 * One per request, never shared. The client caches the session it read out of
 * the request's cookies, so a module-level singleton would eventually hand one
 * user the session of whoever rendered before them - the kind of bug that only
 * shows up under concurrency, in production.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export async function createClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Copy .env.example to .env.",
    );
  }

  const store = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options);
          }
        } catch {
          // A Server Component renders after the response headers are settled
          // and cannot write cookies. That is survivable only because
          // middleware.ts refreshed the session earlier in the same request -
          // if the matcher ever stops covering a route, sessions on it start
          // expiring mid-use and this silent catch is where the evidence went.
        }
      },
    },
  });
}

/**
 * The origin this request actually arrived on.
 *
 * Every post-auth destination is built from it: the `redirectTo` we hand
 * Google, and where the callback and sign-out routes send the browser next.
 * Deriving it from the request rather than an env var means preview
 * deployments and localhost work without anyone configuring a base URL.
 *
 * `x-forwarded-*` is client-supplied and a hostile one could point `redirectTo`
 * at another origin - which is exactly the case Supabase's redirect allow-list
 * exists to refuse, so a spoofed host fails at the authorize step instead of
 * completing a sign-in somewhere else.
 */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  // Some proxies chain the header ("https,http"); the first hop is ours.
  const forwardedProto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto || (isLoopback(host) ? "http" : "https");
  return `${proto}://${host}`;
}

function isLoopback(host: string): boolean {
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}
