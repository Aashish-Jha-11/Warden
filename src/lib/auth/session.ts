import type { User as AuthUser } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import type { Tenant, User } from "@/generated/prisma/client";
import { record } from "@/lib/agent/audit";
import { ActionTypeSchema } from "@/lib/agent/types";
import { db } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { TEMPLATE_IDS } from "@/lib/templates";

/**
 * The bridge between a Supabase auth identity and our own rows.
 *
 * Supabase knows who signed in. It knows nothing about tenants, policies or
 * anything the runtime enforces, so every server render re-establishes that
 * here rather than trusting a claim carried over from the last one.
 */

export type Session = { user: User; tenant: Tenant };

/**
 * What a workspace is allowed to do before anyone has configured it.
 *
 * Exported because scripts/seed.ts seeds the demo tenant from this exact
 * object rather than from a copy of it. A demo workspace that behaves
 * differently from a real first sign-in is a lie told to whoever is watching,
 * and two hand-maintained copies of a policy diverge the first time one of
 * them is edited.
 *
 * The auto-approve list is the line that matters here, and it is drawn by
 * asking one question of every action: does it make a commitment to a customer
 * on the business's behalf, or can it not be taken back?
 *
 *   update_case         writes to our own database and reaches nobody. No
 *                       commitment, fully reversible, so it runs unattended.
 *   escalate_to_human   its entire effect is putting the case in front of a
 *                       person. Gating it would mean asking a human for
 *                       permission to ask a human.
 *
 * Everything else waits, for a stated reason:
 *
 *   schedule_callback   promises that a named person will be phoned at a named
 *                       time. Nobody signed that sentence in advance and the
 *                       business has to keep it, so a person commits to it.
 *   close_case          decides an enquiry will never be answered. Reversible
 *                       in the database and not in the world - the lead has
 *                       gone cold by the time anybody notices the row.
 *   send_email/_sms     free text to a real recipient, and unrecallable once
 *                       sent. policy.ts refuses to auto-approve these even if
 *                       a tenant lists them, so leaving them off is agreement
 *                       rather than the mechanism.
 *
 * send_templated_reply is absent and does not belong here: its approval
 * happened when a human signed the wording, and policy.ts lets an approved
 * template through on that basis. That is the one path to a real recipient
 * that does not stop for a person, and it is narrow on purpose.
 *
 * place_call is not on `allowedActions` at all. Outbound Indian telephony
 * needs DLT registration we do not hold, so the honest configuration is one
 * where the engine refuses the call outright rather than one where a
 * misconfiguration could dial.
 */
export const DEFAULT_POLICY = {
  maxAttemptsPerCase: 3,
  maxActionsPerRun: 8,
  maxRunSteps: 24,
  contactWindowStartHour: 9,
  contactWindowEndHour: 20,
  contactOnWeekends: false,
  inboundReplyGraceMinutes: 30,
  allowedActions: ActionTypeSchema.options.filter((a) => a !== "place_call") as string[],
  autoApproveActions: ["update_case", "escalate_to_human"],
  // The registry in src/lib/templates.ts is the artifact a human signs, so
  // approving exactly it is what "signed off in advance" means here.
  approvedTemplates: [...TEMPLATE_IDS] as string[],
  // Zero rather than a figure somebody picked: a workspace nobody has
  // configured has no authority to spend the business's money. Every proposal
  // the agent has made against this policy carries valuePaise 0, so this
  // refuses a costed action instead of rubber-stamping one with no budget
  // behind it - and an owner raising it is a deliberate act with a name on it.
  maxValuePerActionPaise: 0,
};

/** How many readable slugs to try before giving up on the email local-part. */
const SLUG_ATTEMPTS = 6;

type Identity = { authId: string; email: string; displayName: string | null };

type AuthState =
  | { kind: "anonymous" }
  | { kind: "unusable"; reason: "missing_email" }
  | { kind: "identity"; identity: Identity };

/**
 * The session, or the login page. Use this in every server component and
 * layout that renders tenant data.
 *
 * On first sign-in there are no rows for this person yet, so this provisions
 * them - see `provision()` for why that is one transaction.
 */
export async function requireUser(): Promise<Session> {
  const state = await readAuthState();

  // redirect() throws, so these stay outside anything that catches.
  if (state.kind === "anonymous") redirect("/login");
  if (state.kind === "unusable") redirect(`/login?error=${state.reason}`);

  return loadOrProvision(state.identity);
}

/**
 * The same answer without the redirect, for the API layer - a route handler
 * needs to reply 401 in JSON, not hand a fetch() an HTML login page.
 */
export async function getUserOrNull(): Promise<Session | null> {
  const state = await readAuthState();
  if (state.kind !== "identity") return null;
  return loadOrProvision(state.identity);
}

// ---------------------------------------------------------------- identity

async function readAuthState(): Promise<AuthState> {
  const supabase = await createClient();

  // getUser(), not getSession(). The session cookie is data the browser sends
  // us and is not evidence of anything until the auth server has vouched for
  // it, and the answer here is what selects a tenant's rows. Middleware does
  // the cheap per-navigation check; this is the one that has to be right.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { kind: "anonymous" };

  const identity = identityFrom(data.user);
  // Google always returns an email. Another provider might not, and User is
  // keyed on (tenantId, email), so there is nothing to provision - say so on
  // the login page instead of bouncing them around a redirect loop.
  return identity ? { kind: "identity", identity } : { kind: "unusable", reason: "missing_email" };
}

function identityFrom(authUser: AuthUser): Identity | null {
  const email = authUser.email?.trim().toLowerCase();
  if (!email) return null;

  const metadata = authUser.user_metadata ?? {};
  const displayName = asName(metadata.full_name) ?? asName(metadata.name) ?? null;

  return { authId: authUser.id, email, displayName };
}

function asName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : null;
}

// ---------------------------------------------------------------- our rows

async function loadOrProvision(identity: Identity): Promise<Session> {
  const existing = await loadByAuthId(identity.authId);
  if (existing) return existing;

  const claimed = await claimWaitingRow(identity);
  return claimed ?? provision(identity);
}

/**
 * Links a Supabase identity to a User row that already existed for this email
 * address but has never been signed in to.
 *
 * Without this, a workspace can only ever be reached by whoever happened to
 * create it through this code path. `pnpm seed` writes its owner and operator
 * with `authId = null` - there is no Supabase identity to point at until a real
 * person signs in - so the first sign-in fell through to `provision()` and
 * minted a second, empty tenant for the same human. The demo workspace and its
 * cases were still in the database, permanently unreachable, and the account
 * that could see them did not exist.
 *
 * Matching on the email address is the same trust model as an invitation:
 * Supabase has already established that this person controls it (Google
 * vouches for the account; password sign-up requires a confirmed address), and
 * it is the only thing a row written before first sign-in can be keyed on.
 */
async function claimWaitingRow(identity: Identity): Promise<Session | null> {
  const waiting = await db.user.findMany({
    where: { email: identity.email, authId: null },
    select: { id: true, tenantId: true },
  });

  // Exactly one, or we do not guess. `email` is unique per tenant and not
  // globally, so two workspaces can both be waiting on the same address, and
  // picking between them would show one business's leads to another's owner.
  const row = waiting.length === 1 ? waiting[0] : undefined;
  if (!row) return null;

  const { count } = await db.user.updateMany({
    // The `authId: null` guard is what makes this safe to run concurrently: the
    // OAuth callback's redirect and a prefetch of the page it lands on both
    // arrive, and only one of them may write the link.
    where: { id: row.id, authId: null },
    data: { authId: identity.authId, name: identity.displayName ?? undefined },
  });
  if (count === 0) return loadByAuthId(identity.authId);

  const session = await loadByAuthId(identity.authId);
  if (!session) return null;

  // Recorded against the Policy row for the same reason provisioning is: the
  // log has no tenant entity, and that row is the workspace's identity here. It
  // means one query - entity=policy - returns who was ever let into an account
  // alongside every change to what that account is allowed to do.
  const policy = await db.policy.findUnique({
    where: { tenantId: row.tenantId },
    select: { id: true },
  });
  if (policy) {
    await record({
      tenantId: row.tenantId,
      entity: "policy",
      entityId: policy.id,
      event: "identity_linked",
      actor: `user:${row.id}`,
      data: { userId: row.id, email: identity.email, authId: identity.authId },
    });
  }

  return session;
}

async function loadByAuthId(authId: string): Promise<Session | null> {
  const row = await db.user.findUnique({
    where: { authId },
    include: { tenant: true },
  });
  if (!row) return null;

  const { tenant, ...user } = row;
  return { user, tenant };
}

/**
 * First sign-in. Creates the tenant, its owner and its policy together.
 *
 * One transaction, because a half-provisioned account is a support ticket with
 * no fix: runtime.ts refuses to advance a run whose tenant has no policy row,
 * so an account that got a Tenant and a User but no Policy would sign in
 * cleanly and then be quietly unable to do anything. The Policy is created
 * here rather than lazily for the same reason - "create it when first needed"
 * means the first thing that needs it decides what the guardrails are.
 */
async function provision(identity: Identity): Promise<Session> {
  const base = slugBase(identity.email);

  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${suffix()}`;

    try {
      return await db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: { name: workspaceName(identity), slug },
        });

        const user = await tx.user.create({
          data: {
            tenantId: tenant.id,
            authId: identity.authId,
            email: identity.email,
            name: identity.displayName,
            role: "OWNER",
          },
        });

        const policy = await tx.policy.create({
          data: { tenantId: tenant.id, ...DEFAULT_POLICY },
        });

        // The audit log has no tenant entity, and the Policy is the row that
        // matters anyway: it is what the runtime refuses to act without.
        // Recording provisioning against it puts the guardrails an account
        // started life with in the same append-only log as every decision
        // later made under them, so "who widened this, and when" is one query.
        await record(
          {
            tenantId: tenant.id,
            entity: "policy",
            entityId: policy.id,
            event: "provisioned",
            actor: "system",
            data: {
              userId: user.id,
              email: user.email,
              slug: tenant.slug,
              allowedActions: policy.allowedActions,
              autoApproveActions: policy.autoApproveActions,
              approvedTemplates: policy.approvedTemplates,
              maxAttemptsPerCase: policy.maxAttemptsPerCase,
              contactWindow: `${policy.contactWindowStartHour}-${policy.contactWindowEndHour}`,
            },
          },
          tx,
        );

        return { user, tenant };
      });
    } catch (err) {
      // Two requests for the same new person can be in flight at once - the
      // OAuth callback's redirect and a prefetch of the page it lands on.
      // Whichever lost reads the winner's rows rather than minting a second
      // tenant for the same human. Swallow a failure of this lookup itself:
      // whatever is wrong with the database is better reported as the original
      // error than as a second one raised while investigating it.
      const raced = await loadByAuthId(identity.authId).catch(() => null);
      if (raced) return raced;

      if (isUniqueViolationOn(err, "slug")) continue;
      throw err;
    }
  }

  throw new Error(`Could not allocate a tenant slug from "${base}" after ${SLUG_ATTEMPTS} tries.`);
}

// ---------------------------------------------------------------- naming

/** `priya.sharma+leads@clinic.in` -> `priya-sharma`. */
function slugBase(email: string): string {
  const local = email.split("@")[0]?.split("+")[0] ?? "";
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  // An address that is entirely punctuation slugifies to nothing.
  return slug || "workspace";
}

/** Only has to differ from the slug that just collided, never to be unguessable. */
function suffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

function workspaceName(identity: Identity): string {
  const first = identity.displayName?.split(/\s+/)[0];
  const local = identity.email.split("@")[0]?.split("+")[0] ?? "New";
  const who = first ?? (local.charAt(0).toUpperCase() + local.slice(1));
  return `${who}'s workspace`;
}

/**
 * Matched on the error code rather than `instanceof`, so a second copy of the
 * Prisma runtime - a driver adapter, a dev-server module reload - cannot turn a
 * retryable name collision into a 500 on somebody's first sign-in.
 */
function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code !== "P2002") return false;

  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  return JSON.stringify(target ?? "").includes(column);
}
