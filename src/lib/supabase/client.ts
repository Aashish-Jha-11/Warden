import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for the browser.
 *
 * It holds the anon key and nothing else. Nothing in this app trusts what it
 * says: who the user is and which tenant they belong to are resolved
 * server-side in src/lib/auth/session.ts, because a value the browser can edit
 * is not an identity.
 *
 * Use it for the things that genuinely have to happen in the tab - realtime
 * subscriptions, an auth state listener. Everything else belongs on a server
 * component or a route handler.
 */

// Next substitutes NEXT_PUBLIC_* into the browser bundle only where the lookup
// is written out in full. Reading them through a variable or a helper compiles
// to `undefined` in the client, which is a slow way to discover a typo.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function createClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Copy .env.example to .env.",
    );
  }

  // createBrowserClient caches one instance per tab, so calling this from
  // every component that needs it still yields a single auth state listener.
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
