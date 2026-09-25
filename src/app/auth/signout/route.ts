import { NextResponse } from "next/server";

import { createClient, requestOrigin } from "@/lib/supabase/server";

/**
 * Sign out. POST only.
 *
 * On GET, a prefetched link or an <img> pointing here would sign a user out of
 * a page they were reading; a form post cannot be triggered that way. Next
 * answers any other method on this route with 405 on its own.
 */
export async function POST() {
  const supabase = await createClient();

  // Default (global) scope, so the refresh token is revoked at Supabase rather
  // than merely dropped here. Local scope would leave a live token inside a
  // cookie we just handed back to a browser that may not be the user's own -
  // and "sign out" has to mean it on a shared machine.
  //
  // auth-js clears the local session before surfacing a failure, so the cookies
  // are gone either way. The only thing left to get right is where they land.
  await supabase.auth.signOut();

  // 303: the browser must follow this with GET. A 307 would replay the POST
  // against /login.
  return NextResponse.redirect(new URL("/login", await requestOrigin()), 303);
}
