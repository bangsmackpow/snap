import { and, desc, eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { DocRow, TxRow } from "../db/schema";
import { extractionSchema, type CheckExtraction, type InvoiceExtraction } from "./validation";
import type { Db } from "./auth";

export const AUTO_PAIR_THRESHOLD = 60;
export const DATE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type PairResult = {
  transaction: TxRow | null;
  matched: DocRow | null;
};

const NAME_SUFFIXES = new Set([
  "inc", "llc", "ltd", "limited", "co", "company", "corporation", "corp",
  "incorporated", "service", "services", "supply", "supplies", "farms", "farm",
  "ag", "agricultural", "llp", "pllc",
]);

export function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 2 && !NAME_SUFFIXES.has(w))
    .join(" ");
}

export function toCents(n: number | null | undefined): number | null {
  if (n == null || Number.isNaN(n) || !Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function parseDateToMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return Date.UTC(y, +m[1] - 1, +m[2]);
  }
  const ts = Date.parse(t);
  return Number.isNaN(ts) ? null : ts;
}

export function parseExtraction(json: string | null): CheckExtraction | InvoiceExtraction | null {
  if (!json) return null;
  try {
    const parsed = extractionSchema.parse(JSON.parse(json));
    if (parsed.doc_type !== "check" && parsed.doc_type !== "invoice") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function computeScore(check: CheckExtraction, invoice: InvoiceExtraction): number {
  let score = 0;

  const checkAmt = check.amount_numeric;
  const invAmt = invoice.total_due;
  if (checkAmt != null && invAmt != null) {
    const diff = Math.abs(checkAmt - invAmt);
    if (diff < 0.001) score += 50;
    else if (diff <= 0.05) score += 45;
    else if (diff <= Math.max(1, invAmt * 0.01)) score += 30;
  }

  const v1 = normalizeName(check.payee);
  const v2 = normalizeName(invoice.vendor_name);
  if (v1 && v2) {
    if (v1.includes(v2) || v2.includes(v1)) score += 30;
    else {
      const t1 = v1.split(" ");
      const t2 = v2.split(" ");
      if (Math.max(t1.length, t2.length) <= 5) {
        const overlap = t1.filter((w) => t2.includes(w)).length;
        if (overlap >= 1) score += 15;
      }
    }
  }

  const d1 = parseDateToMs(check.date);
  const d2 = parseDateToMs(invoice.invoice_date);
  if (d1 != null && d2 != null) {
    const days = Math.abs(d1 - d2) / 86_400_000;
    if (days <= 30) score += 20;
    else if (days <= 60) score += 10;
  }

  return Math.max(0, Math.min(100, score));
}

function extractionFor(doc: DocRow): CheckExtraction | InvoiceExtraction | null {
  return parseExtraction(doc.extraction_json);
}

export async function autoPair(db: Db, doc: DocRow): Promise<PairResult> {
  const ex = extractionFor(doc);
  if (!ex) return { transaction: null, matched: null };

  if (ex.doc_type === "check") return linkCheck(db, doc, ex);
  if (ex.doc_type === "invoice") return linkInvoice(db, doc, ex);
  return { transaction: null, matched: null };
}

async function linkCheck(db: Db, checkDoc: DocRow, check: CheckExtraction): Promise<PairResult> {
  const candidates = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.doc_type, "invoice"), eq(schema.documents.status, "ready")))
    .orderBy(desc(schema.documents.created_at))
    .limit(50);

  let bestInvoice: DocRow | null = null;
  let bestScore = 0;
  for (const invDoc of candidates) {
    const inv = parseExtraction(invDoc.extraction_json) as InvoiceExtraction | null;
    if (!inv) continue;
    const s = computeScore(check, inv);
    if (s > bestScore) {
      bestScore = s;
      bestInvoice = invDoc;
    }
  }

  if (bestInvoice && bestScore >= AUTO_PAIR_THRESHOLD) {
    const existing = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.invoice_doc_id, bestInvoice.id),
          isNull(schema.transactions.check_doc_id)
        )
      )
      .limit(1);
    const tx = await writePairedTransaction(db, checkDoc, bestInvoice, bestScore, existing[0]?.id);
    return { transaction: tx, matched: bestInvoice };
  }

  const tx = await db
    .insert(schema.transactions)
    .values({
      check_doc_id: checkDoc.id,
      vendor_payee: check.payee || null,
      amount: toCents(check.amount_numeric),
      transaction_date: parseDateToMs(check.date),
      check_number: check.check_number || null,
      memo: check.memo_line || null,
      confidence_score: 0,
      status: "unpaired",
    })
    .returning();
  return { transaction: tx[0] ?? null, matched: null };
}

async function linkInvoice(db: Db, invoiceDoc: DocRow, invoice: InvoiceExtraction): Promise<PairResult> {
  const candidates = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.doc_type, "check"), eq(schema.documents.status, "ready")))
    .orderBy(desc(schema.documents.created_at))
    .limit(50);

  let bestCheck: DocRow | null = null;
  let bestScore = 0;
  for (const chkDoc of candidates) {
    const chk = parseExtraction(chkDoc.extraction_json) as CheckExtraction | null;
    if (!chk) continue;
    const s = computeScore(chk, invoice);
    if (s > bestScore) {
      bestScore = s;
      bestCheck = chkDoc;
    }
  }

  if (bestCheck && bestScore >= AUTO_PAIR_THRESHOLD) {
    const existing = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.check_doc_id, bestCheck.id),
          isNull(schema.transactions.invoice_doc_id)
        )
      )
      .limit(1);
    const tx = await writePairedTransaction(db, bestCheck, invoiceDoc, bestScore, existing[0]?.id);
    return { transaction: tx, matched: bestCheck };
  }

  const tx = await db
    .insert(schema.transactions)
    .values({
      invoice_doc_id: invoiceDoc.id,
      vendor_payee: invoice.vendor_name || null,
      amount: toCents(invoice.total_due),
      transaction_date: parseDateToMs(invoice.invoice_date),
      confidence_score: 0,
      status: "unpaired",
    })
    .returning();
  return { transaction: tx[0] ?? null, matched: null };
}

async function writePairedTransaction(
  db: Db,
  checkDoc: DocRow,
  invoiceDoc: DocRow,
  score: number,
  existingId: string | undefined
): Promise<TxRow> {
  const check = extractionFor(checkDoc) as CheckExtraction;
  const invoice = extractionFor(invoiceDoc) as InvoiceExtraction;
  const values = {
    check_doc_id: checkDoc.id,
    invoice_doc_id: invoiceDoc.id,
    vendor_payee: check.payee || invoice.vendor_name || null,
    amount: toCents(check.amount_numeric ?? invoice.total_due),
    transaction_date: parseDateToMs(check.date) ?? parseDateToMs(invoice.invoice_date),
    check_number: check.check_number || null,
    memo: check.memo_line || null,
    confidence_score: Math.round(score),
    status: "paired" as const,
  };

  if (existingId) {
    await db.update(schema.transactions).set(values).where(eq(schema.transactions.id, existingId));
    const updated = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, existingId))
      .limit(1);
    return updated[0];
  }

  const inserted = await db
    .insert(schema.transactions)
    .values(values)
    .returning();
  return inserted[0];
}

export async function pairTwoDocs(
  db: Db,
  checkDoc: DocRow,
  invoiceDoc: DocRow
): Promise<TxRow> {
  const check = extractionFor(checkDoc) as CheckExtraction;
  const invoice = extractionFor(invoiceDoc) as InvoiceExtraction;
  const score = computeScore(check, invoice);

  // Relink if either side already sits in an unpaired transaction.
  const orphanCheckTx = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.check_doc_id, checkDoc.id),
        isNull(schema.transactions.invoice_doc_id)
      )
    )
    .limit(1);
  const orphanInvoiceTx = await db
    .select()
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.invoice_doc_id, invoiceDoc.id),
        isNull(schema.transactions.check_doc_id)
      )
    )
    .limit(1);

  const existingId = orphanCheckTx[0]?.id ?? orphanInvoiceTx[0]?.id;
  return writePairedTransaction(db, checkDoc, invoiceDoc, Math.max(score, AUTO_PAIR_THRESHOLD), existingId);
}