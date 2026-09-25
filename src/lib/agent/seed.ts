/**
 * Common random numbers.
 *
 * Both arms of an eval get the same seed for the same case, so any stochastic
 * choice resolves identically in each. That removes luck from the comparison:
 * whatever difference shows up between arms is the decisions, not the dice.
 *
 * mulberry32 - small, fast, and deterministic across machines, which matters
 * because an eval has to reproduce on a judge's laptop as well as mine.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash so a string seed maps to the same number every time. */
export function seedToInt(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function rngFor(seed: string): () => number {
  return mulberry32(seedToInt(seed));
}
