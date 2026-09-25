"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BarChart3, Inbox, Mic } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Client component only because the active state needs the pathname. The rail
 * itself is rendered by the server layout, so this ships almost no JS.
 *
 * Two layouts, one link list. The usage scene is a phone, one-handed,
 * thirty seconds at a time - and the rail is hidden under `md`, so until this
 * had a `bar` form there was no way to reach Approvals from a phone at all.
 * Sharing the list rather than writing a second one is the point: a route added
 * to one and forgotten in the other is a section that exists on a desktop and
 * not on the device the operator actually holds.
 */

const LINKS = [
  { href: "/", label: "Inbox", icon: Inbox, exact: true },
  { href: "/approvals", label: "Approvals", icon: Activity, exact: false },
  { href: "/eval", label: "Evidence", icon: BarChart3, exact: false },
  { href: "/voice", label: "Voice", icon: Mic, exact: false },
];

export type NavLayout = "rail" | "bar";

export function ConsoleNav({ layout = "rail" }: { layout?: NavLayout }) {
  // usePathname() is typed as a string but answers null outside a router
  // context, and this is the one component rendered on every authed screen -
  // a throw here takes out the whole console rather than one section.
  const pathname = usePathname() ?? "";
  const bar = layout === "bar";

  return (
    <nav
      aria-label="Sections"
      className={cn(
        bar
          ? // Scrolls rather than wraps: a second row of tabs would push the
            // page content down on exactly the screen that has least of it.
            "-mx-4 flex gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "flex flex-col gap-0.5",
      )}
    >
      {LINKS.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "pressable flex cursor-pointer items-center gap-2.5 rounded-sm text-sm",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
              bar ? "shrink-0 gap-1.5 px-2.5 py-1.5" : "px-2.5 py-1.5",
              active
                ? "bg-raised text-fg"
                : "text-muted hover:bg-raised/60 hover:text-fg",
            )}
          >
            <Icon aria-hidden className="size-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
