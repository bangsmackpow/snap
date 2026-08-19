import { Hono } from "hono";
import { asc, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AppEnv } from "../env";
import {
  auditLog,
  categoryRules,
  documents,
  transactions,
} from "../db/schema";
import type { DocRow, TxRow } from "../db/schema";
import { getDb, requireAccountant } from "../lib/auth";
import { recordAudit } from "../lib/audit";
import { buildExportBundle } from "../services/export";
import { z } from "zod";

const accountant = new Hono<AppEnv>();
accountant.use("*", requireAccountant);

const checkDoc = alias(documents, "check_doc");
const invoiceDoc = alias(documents, "invoice_doc");

const TXN_COLS = {
  id: transactions.id,
  status: transactions.status,
  flagged: transactions.flagged,
  flag_reason: transactions.flag_reason,
  amount: transactions.amount,
  transaction_date: transactions.transaction_date,
  vendor_payee: transactions.vendor_payee,
  check_number: transactions.check_number,
  memo: transactions.memo,
  category_code: transactions.category_code,
  confidence_score: transactions.confidence_score,
  verified_at: transactions.verified_at,
  verified_by: transactions.verified_by,
  exported_at: transactions.exported_at,
  created_at: transactions.created_at,
  check_doc_id: transactions.check_doc_id,
  invoice_doc_id: transactions.invoice_doc_id,
  check: checkDoc,
  invoice: invoiceDoc,
};

// ---- review queue -----------------------------------------------------------

accountant.get("/queue", async (c) => {
  const db = getDb(c.env);
  const filter = c.req.query("filter") || "open";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);

  let where;
  if (filter === "verified") where = eq(transactions.status, "verified");
  else if (filter === "flagged") where = eq(transactions.flagged, 1);
  // default ("open" / "unverified") = anything not yet verified
  else where = ne(transactions.status, "verified");

  const rows = await db
    .select(TXN_COLS)
    .from(transactions)
    .leftJoin(checkDoc, eq(transactions.check_doc_id, checkDoc.id))
    .leftJoin(invoiceDoc, eq(transactions.invoice_doc_id, invoiceDoc.id))
    .where(where)
    .orderBy(asc(transactions.transaction_date))
    .limit(limit);
  return c.json({ transactions: rows });
});

// ---- single transaction review + image URLs ---------------------------------

accountant.get("/transactions/:id", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select(TXN_COLS)
    .from(transactions)
    .leftJoin(checkDoc, eq(transactions.check_doc_id, checkDoc.id))
    .leftJoin(invoiceDoc, eq(transactions.invoice_doc_id, invoiceDoc.id))
    .where(eq(transactions.id, c.req.param("id")))
    .limit(1);
  const tx = rows[0];
  if (!tx) return c.json({ error: "not_found" }, 404);

  // Build authenticated preview URLs for the images.
  const preview = (doc: DocRow | null) =>
    doc ? `/api/documents/${doc.id}/preview` : null;
  return c.json({
    transaction: {
      ...tx,
      check_preview_url: preview(tx.check),
      invoice_preview_url: preview(tx.invoice),
    },
  });
});

const txnUpdateSchema = z.object({
  vendor_payee: z.string().optional(),
  check_number: z.string().optional(),
  transaction_date: z.number().nullable().optional(),
  amount: z.number().nullable().optional(),
  memo: z.string().optional(),
  category_code: z.string().optional(),
  flag_reason: z.string().nullable().optional(),
  flagged: z.number().optional(),
  status: z.enum(["unpaired", "paired", "verified"]).optional(),
});

// Update editable fields + one-tap approve/flag. Records an audit entry.
accountant.patch("/transactions/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = txnUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const db = getDb(c.env);
  const id = c.req.param("id");
  const existing = (
    await db.select().from(transactions).where(eq(transactions.id, id)).limit(1)
  )[0];
  if (!existing) return c.json({ error: "not_found" }, 404);

  const data = parsed.data;
  const patch: Partial<TxRow> = {};
  if (data.vendor_payee !== undefined) patch.vendor_payee = data.vendor_payee;
  if (data.check_number !== undefined) patch.check_number = data.check_number;
  if (data.transaction_date !== undefined) patch.transaction_date = data.transaction_date;
  if (data.amount !== undefined) patch.amount = data.amount;
  if (data.memo !== undefined) patch.memo = data.memo;
  if (data.category_code !== undefined) patch.category_code = data.category_code;
  if (data.flag_reason !== undefined) patch.flag_reason = data.flag_reason;
  if (data.flagged !== undefined) patch.flagged = data.flagged;
  if (data.status !== undefined) patch.status = data.status;

  // Approve marks verified + timestamp + actor.
  const becomingVerified =
    data.status === "verified" && existing.status !== "verified";
  if (becomingVerified) {
    patch.status = "verified";
    patch.verified_at = Date.now();
    patch.verified_by = c.var.session.id;
  }

  await db.update(transactions).set(patch).where(eq(transactions.id, id));

  await recordAudit(db, {
    actorId: c.var.session.id,
    action: becomingVerified ? "verify" : data.flagged === 1 ? "flag" : "update",
    transactionId: id,
    detail: JSON.stringify(patch),
  });

  const updated = (
    await db.select().from(transactions).where(eq(transactions.id, id)).limit(1)
  )[0];
  return c.json({ transaction: updated });
});

// Unlink / split a paired transaction back into separate unpaired rows.
accountant.post("/transactions/:id/unlink", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const existing = (
    await db.select().from(transactions).where(eq(transactions.id, id)).limit(1)
  )[0];
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (!existing.check_doc_id && !existing.invoice_doc_id) {
    return c.json({ error: "nothing_to_unlink" }, 409);
  }

  // Remove pairing: clear both doc links and revert to unpaired.
  const wasPaired = !!(existing.check_doc_id && existing.invoice_doc_id);
  await db
    .update(transactions)
    .set({
      check_doc_id: null,
      invoice_doc_id: null,
      status: "unpaired",
      verified_at: null,
      verified_by: null,
      flagged: 0,
      flag_reason: null,
    })
    .where(eq(transactions.id, id));

  await recordAudit(db, {
    actorId: c.var.session.id,
    action: "unlink",
    transactionId: id,
    detail: wasPaired ? "split paired check+invoice" : "cleared doc links",
  });

  const updated = (
    await db.select().from(transactions).where(eq(transactions.id, id)).limit(1)
  )[0];
  return c.json({ transaction: updated });
});

// ---- category rules ---------------------------------------------------------

const ruleSchema = z.object({
  match_on: z.enum(["vendor", "memo", "both"]).default("vendor"),
  keyword: z.string().min(1),
  account: z.string().min(1),
  priority: z.number().int().default(100),
  active: z.number().int().default(1),
});

accountant.get("/category-rules", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(categoryRules)
    .orderBy(asc(categoryRules.priority), asc(categoryRules.created_at));
  return c.json({ rules: rows });
});

accountant.post("/category-rules", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const db = getDb(c.env);
  const row = await db
    .insert(categoryRules)
    .values({
      match_on: parsed.data.match_on,
      keyword: parsed.data.keyword.trim(),
      account: parsed.data.account.trim(),
      priority: parsed.data.priority,
      active: parsed.data.active,
    })
    .returning();
  return c.json({ rule: row[0] });
});

accountant.delete("/category-rules/:id", async (c) => {
  const db = getDb(c.env);
  await db
    .delete(categoryRules)
    .where(eq(categoryRules.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// ---- batch categorization ---------------------------------------------------

const batchCategorizeSchema = z.object({
  transaction_ids: z.array(z.string().min(1)).min(1),
  category_code: z.string().min(1),
});

accountant.post("/batch-categorize", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = batchCategorizeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const db = getDb(c.env);
  const { transaction_ids, category_code } = parsed.data;

  for (const id of transaction_ids) {
    await db
      .update(transactions)
      .set({ category_code })
      .where(eq(transactions.id, id));
  }
  await recordAudit(db, {
    actorId: c.var.session.id,
    action: "categorize",
    detail: `batch ${category_code} applied to ${transaction_ids.length} transactions`,
  });
  return c.json({ updated: transaction_ids.length });
});

// ---- audit log --------------------------------------------------------------

accountant.get("/audit", async (c) => {
  const db = getDb(c.env);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.created_at))
    .limit(limit);
  return c.json({ audit: rows });
});

// ---- direct export trigger (Phase 2 engine) ---------------------------------

const exportRangeSchema = z.enum(["month", "quarter", "ytd"]);

accountant.post("/export", async (c) => {
  const body = await c.req.json().catch(() => null);
  const range = body?.range ? exportRangeSchema.safeParse(body.range) : null;
  const chosen = range?.success ? range.data : "month";
  const { zipKey, fileName, recordCount } = await buildExportBundle(c.env, {
    range: chosen,
    exportedBy: c.var.session.id,
  });
  return c.json({ zipKey, fileName, recordCount });
});

export { accountant as accountantRoutes };