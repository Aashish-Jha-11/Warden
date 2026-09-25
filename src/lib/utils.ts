import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional classes, with later Tailwind utilities winning over earlier ones
 * in the same group.
 *
 * Plain string concatenation loses that: `"px-3" + " px-2"` emits both and the
 * winner is whichever the stylesheet happens to order last, which is not a
 * thing a caller can reason about. Every primitive here takes a `className`
 * override, and this is what makes those overrides actually override.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
