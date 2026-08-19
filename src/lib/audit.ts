import type { AuditAction } from "../db/schema";
import { auditLog } from "../db/schema";
import type { Db } from "./auth";

export async function recordAudit(
  db: Db,
  entry: {
    actorId?: string | null;
    action: AuditAction;
    transactionId?: string | null;
    batchId?: string | null;
    detail?: string | null;
  }
): Promise<void> {
  await db.insert(auditLog).values({
    actor_id: entry.actorId ?? null,
    action: entry.action,
    transaction_id: entry.transactionId ?? null,
    batch_id: entry.batchId ?? null,
    detail: entry.detail ?? null,
  });
}