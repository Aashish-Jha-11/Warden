import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import type { z } from "zod";

/**
 * One response shape for the whole API.
 *
 * Every route answers `{ ok: true, data }` or `{ ok: false, error }`, so a
 * caller branches once on `ok` and never on the status code. The status code
 * still means what it should - a client just does not have to know HTTP to
 * read an answer, and a fetch() wrapper cannot quietly treat a 409 as success.
 */

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string };
export type ApiResult<T> = ApiOk<T> | ApiErr;

type Init = { status?: number; headers?: HeadersInit };

export function ok<T>(data: T, init: Init = {}): NextResponse<ApiOk<T>> {
  return NextResponse.json<ApiOk<T>>(
    { ok: true, data },
    { status: init.status ?? 200, headers: init.headers },
  );
}

function fail(error: string, status: number): NextResponse<ApiErr> {
  return NextResponse.json<ApiErr>({ ok: false, error }, { status });
}

/** The caller sent something we cannot act on. Say what, in words they can fix. */
export function badRequest(message: string): NextResponse<ApiErr> {
  return fail(message, 400);
}

/**
 * The default wording is for a person whose session expired. The public webhook
 * passes its own, because telling a form provider to "sign in" is advice no
 * machine can act on.
 */
export function unauthorized(message = "Sign in to use this endpoint."): NextResponse<ApiErr> {
  return fail(message, 401);
}

/**
 * Also the answer for a row that exists under another tenant. A 403 there would
 * confirm the id is real, which is a slower way of leaking exactly what the
 * tenant filter is in place to prevent.
 */
export function notFound(message: string): NextResponse<ApiErr> {
  return fail(message, 404);
}

/** The request was fine; the thing it addresses has already moved on. */
export function conflict(message: string): NextResponse<ApiErr> {
  return fail(message, 409);
}

/**
 * The only place a thrown error becomes a response, and it deliberately tells
 * the caller almost nothing.
 *
 * A Prisma error carries table names, column names and often the offending
 * value - a unique violation on `users.email` will happily quote the email
 * back. None of that belongs in a response body that may be rendered in a
 * browser or written to a third party's webhook log. The real error goes to
 * the server log under a short reference, and the caller gets the reference,
 * so a support ticket months later still leads to the exact failure.
 */
export function serverError(cause: unknown): NextResponse<ApiErr> {
  const ref = randomUUID().slice(0, 8);
  console.error(`[api:${ref}]`, cause);
  return fail(`Something went wrong on our side. Reference ${ref}.`, 500);
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Enough to fix the request without pasting the caller's whole body back. */
const MAX_REPORTED_ISSUES = 5;

/**
 * Body parsing that returns its failure instead of throwing it.
 *
 * A throw would land in the route's catch and come back as a 500 - our fault -
 * when a malformed body is the caller's. Keeping the two apart matters most on
 * the public webhook, where "500" sends a form provider into a retry loop
 * against a request that will never succeed, and "400" makes it stop.
 */
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // Covers the empty body a webhook sends when its own template rendered to
    // nothing, which is otherwise indistinguishable from a truncated request.
    return { ok: false, error: "Body must be JSON." };
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: describe(parsed.error) };
}

/**
 * `source: Invalid option; city: Too small` - one line, aimed at whoever is
 * reading a webhook delivery log rather than at a stack trace.
 */
function describe(error: z.ZodError): string {
  const reported = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    // A symbol key throws inside Array.join, so each segment is stringified
    // explicitly before anything tries to concatenate it.
    const path = issue.path.map((segment) => String(segment)).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  const hidden = error.issues.length - reported.length;
  const line = reported.join("; ") || "Body did not match the expected shape.";
  return hidden > 0 ? `${line} (+${hidden} more)` : line;
}
