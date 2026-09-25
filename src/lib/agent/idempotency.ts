import { createHash } from "node:crypto";

/**
 * Write-ahead idempotency.
 *
 * The key is derived only from things that identify the action itself - never
 * from a timestamp, a run id, or a random value. So if the same agent reaches
 * the same conclusion twice (a retry, a resumed run, a duplicate webhook), it
 * computes the same key, and the unique index on proposed_actions.idempotency_key
 * rejects the second write.
 *
 * The guarantee is enforced by Postgres, not by this function. Application-level
 * dedupe loses to a race; a unique constraint does not.
 */
export function idempotencyKey(input: {
  tenantId: string;
  caseId: string;
  type: string;
  args: Record<string, unknown>;
  /** Bump when the same action is legitimately allowed to repeat, e.g. attempt 2. */
  attempt: number;
}): string {
  const canonical = JSON.stringify({
    t: input.tenantId,
    c: input.caseId,
    a: input.type,
    g: canonicalize(input.args),
    n: input.attempt,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Key order in a JS object is insertion order, so {a:1,b:2} and {b:2,a:1}
 * stringify differently and would produce two different keys for one action.
 * Sorting recursively removes that.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}
