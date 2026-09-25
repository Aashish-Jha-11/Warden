import type { ReactNode } from "react";

/**
 * Sets the `--i` stagger index each child animates against.
 *
 * A component rather than nth-child CSS because these lists are dynamic - a
 * table of 3 leads and a table of 50 need the same rule, and hand-writing
 * fifty nth-child delays is how stagger normally rots.
 *
 * Server-renderable: no state, no effects, no client bundle. The animation
 * itself is pure CSS (see globals.css), so it survives a busy main thread
 * during hydration, which is exactly when a list first appears.
 */
export function stagger(index: number): React.CSSProperties {
  // Capped so a long table does not take four seconds to finish arriving.
  return { "--i": Math.min(index, 14) } as React.CSSProperties;
}

export function Stagger({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
}
