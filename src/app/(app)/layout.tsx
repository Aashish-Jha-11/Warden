import { ShieldCheck } from "lucide-react";

import { ConsoleNav } from "@/components/console-nav";
import { buttonClasses } from "@/components/ui/button";
import { Mono } from "@/components/ui/mono";
import { requireUser } from "@/lib/auth/session";

/**
 * Every route under (app) is per-request, never prerendered.
 *
 * requireUser() reads cookies(), which would normally mark these dynamic on its
 * own - but the Supabase client throws on missing env BEFORE reaching cookies(),
 * so the signal never fires and the build tries to prerender a page that cannot
 * exist without a request. Declaring it here is also simply true: none of these
 * pages has a meaningful static form.
 */
export const dynamic = "force-dynamic";

/**
 * The authed console shell.
 *
 * requireUser() runs here rather than in each page, so every route under (app)
 * is provisioned and tenant-scoped before it renders. A page that forgets to
 * check cannot leak anything, because it never gets mounted unauthenticated.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, tenant } = await requireUser();

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-subtle bg-surface px-3 py-4 md:flex">
        <div className="flex items-center gap-2 px-2.5 pb-5">
          <ShieldCheck aria-hidden className="size-4 shrink-0 text-accent-soft" />
          <span className="text-base font-semibold tracking-tight">Warden</span>
        </div>

        <ConsoleNav />

        <div className="mt-auto space-y-2 border-t border-subtle pt-3">
          <div className="px-2.5">
            <div className="truncate text-xs text-muted" title={tenant.name}>
              {tenant.name}
            </div>
            <Mono tone="faint" className="block truncate text-2xs" title={user.email}>
              {user.email}
            </Mono>
          </div>
          <form action="/auth/signout" method="post" className="px-1.5">
            <button type="submit" className={buttonClasses("ghost", "sm") + " w-full"}>
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The rail collapses under md, so everything on it has to live here too -
          the product name, whose workspace this is, the way out, and above all
          the sections. Sticky because the operator is on a phone for thirty
          seconds: reaching Approvals should never mean scrolling back up first.
        */}
        <header className="sticky top-0 z-20 space-y-2 border-b border-subtle bg-surface px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4 shrink-0 text-accent-soft" />
            <span className="text-base font-semibold tracking-tight">Warden</span>
            <span
              className="ml-auto min-w-0 truncate text-xs text-muted"
              title={tenant.name}
            >
              {tenant.name}
            </span>
            <form action="/auth/signout" method="post" className="shrink-0">
              <button type="submit" className={buttonClasses("ghost", "sm")}>
                Sign out
              </button>
            </form>
          </div>
          <ConsoleNav layout="bar" />
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
