import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * Append-only audit log.
 *
 * Nothing in this module updates or deletes. Every decision the system makes
 * lands here as a new row, which is what makes `pnpm replay` able to rebuild
 * a run's entire decision history from the database alone - and what makes a
 * disputed action answerable months later.
 */
export type AuditActor = "agent" | "system" | `user:${string}`;

export async function record(
  args: {
    tenantId: string;
    entity: "run" | "action" | "case" | "policy" | "eval";
    entityId: string;
    event: string;
    actor: AuditActor;
    data?: Prisma.InputJsonValue;
  },
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db;
  await client.auditEvent.create({
    data: {
      tenantId: args.tenantId,
      entity: args.entity,
      entityId: args.entityId,
      event: args.event,
      actor: args.actor,
      data: args.data ?? {},
    },
  });
}

/** Full history for one entity, oldest first - the order a replay needs. */
export async function historyFor(entity: string, entityId: string) {
  return db.auditEvent.findMany({
    where: { entity, entityId },
    orderBy: { createdAt: "asc" },
  });
}
