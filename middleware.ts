import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next 16 renamed this convention to `proxy.ts` and kept `middleware.ts`
 * working. It stays named this way deliberately: `proxy` is pinned to the
 * Node.js runtime, while everything this file does is a token check over Web
 * APIs that belongs at the edge, in front of the server rather than inside it.
 * The rename is a one-line `mv` the day that stops being true.
 *
 * The logic itself lives in src/lib/supabase/middleware.ts. Only one of these
 * files is allowed to exist per project, so keeping it thin is what lets
 * anything else that needs to run here be added without a merge conflict.
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  /**
   * Everything except what Next serves without rendering.
   *
   * A matcher that swallows `_next/static`, `_next/image` or a file in
   * `public/` does not fail loudly - the app renders with no CSS, no fonts and
   * no images, which reads as a broken product rather than a broken regex. So
   * the exclusions are listed by the two paths Next reserves plus an explicit
   * extension list, and nothing else.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf|txt|xml|webmanifest)$).*)",
  ],
};
