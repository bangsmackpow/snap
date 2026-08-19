import { and, desc, eq, gte, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { zipSync } from "fflate";
import { documents, exportBatches, transactions } from "../db/schema";
import type { DocRow, TxRow } from "../db/schema";
import type { Env } from "../env";
import { getDb, type Db } from "../lib/auth";
import { recordAudit } from "../lib/audit";
import { decryptDocument } from "../lib/crypto";
import { parseExtraction } from "../lib/pairing";
import { buildIIF, txToIifRow } from "./iif";
import { buildCSV, inferCategory, toCsvRow } from "./csv";

const checkDoc = alias(documents, "check_doc");
const invoiceDoc = alias(documents, "invoice_doc");

export type DateRange = "month" | "quarter" | "ytd" | { from: number; to: number };

export function resolveRange(range: DateRange, now: Date = new Date()): { from: number; to: number } {
  const end = now.getTime();
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1).getTime();

  if (typeof range === "object") return range;

  switch (range) {
    case "month":
      return { from: startOfMonth(now), to: end };
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3);
      return { from: new Date(now.getFullYear(), q * 3, 1).getTime(), to: end };
    }
    case "ytd":
      return { from: startOfYear(now), to: end };
  }
}

export type ExportTxRow = TxRow & { check: DocRow | null; invoice: DocRow | null };

export async function fetchTransactionsInRange(
  db: Db,
  range: DateRange,
  now: Date = new Date()
): Promise<ExportTxRow[]> {
  const { from, to } = resolveRange(range, now);
  return db
    .select({
      id: transactions.id,
      status: transactions.status,
      amount: transactions.amount,
      transaction_date: transactions.transaction_date,
      vendor_payee: transactions.vendor_payee,
      check_number: transactions.check_number,
      memo: transactions.memo,
      category_code: transactions.category_code,
      confidence_score: transactions.confidence_score,
      flagged: transactions.flagged,
      flag_reason: transactions.flag_reason,
      verified_at: transactions.verified_at,
      verified_by: transactions.verified_by,
      exported_at: transactions.exported_at,
      created_at: transactions.created_at,
      check_doc_id: transactions.check_doc_id,
      invoice_doc_id: transactions.invoice_doc_id,
      check: checkDoc,
      invoice: invoiceDoc,
    })
    .from(transactions)
    .leftJoin(checkDoc, eq(transactions.check_doc_id, checkDoc.id))
    .leftJoin(invoiceDoc, eq(transactions.invoice_doc_id, invoiceDoc.id))
    .where(and(gte(transactions.transaction_date, from), lte(transactions.transaction_date, to)))
    .orderBy(desc(transactions.transaction_date));
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_ -]/g, "").replace(/\s+/g, "_").slice(0, 60) || "Unknown";
}

function imageFileName(tx: ExportTxRow, doc: DocRow | null, kind: "check" | "invoice"): string | null {
  if (!doc) return null;
  const d = tx.transaction_date ? new Date(tx.transaction_date).toISOString().slice(0, 10) : "nodate";
  const who = sanitizeName(tx.vendor_payee ?? "Vendor");
  const ck = tx.check_number ?? "";
  const name = `${d}_${kind === "check" && ck ? `Check${ck}` : kind}_${who}`;
  const ext = doc.mime_type?.split("/")[1] === "png" ? "png" : "jpg";
  return `${name}.${ext}`;
}

export type BundleResult = {
  zipBytes: Uint8Array;
  zipKey: string;
  fileName: string;
  recordCount: number;
};

export async function buildExportBundle(
  env: Env,
  opts: { range: DateRange; exportedBy: string; now?: Date }
): Promise<BundleResult> {
  const db = getDb(env);
  const rows = await fetchTransactionsInRange(db, opts.range, opts.now);
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Build the IIF and CSV from the same joined rows.
  const iifRows = rows.map((tx) => {
    const invoice = tx.invoice ? parseExtraction(tx.invoice.extraction_json) : null;
    const invoiceRef = invoice && invoice.doc_type === "invoice" ? invoice.invoice_number : "";
    const category = tx.category_code || inferCategory(tx.vendor_payee ?? "", tx.memo ?? "");
    return txToIifRow(tx, { invoiceRef, category });
  });
  const csvRows = rows.map((tx) => {
    const invoice = tx.invoice ? parseExtraction(tx.invoice.extraction_json) : null;
    const invoiceRef = invoice && invoice.doc_type === "invoice" ? invoice.invoice_number : "";
    const category = tx.category_code || inferCategory(tx.vendor_payee ?? "", tx.memo ?? "");
    return toCsvRow(tx, { invoiceRef, category });
  });

  const files: Record<string, Uint8Array> = {
    "ledger.iif": new TextEncoder().encode(buildIIF(iifRows)),
    "ledger.csv": new TextEncoder().encode(buildCSV(csvRows)),
  };

  // Decrypt + add paired image pairs.
  let imageCount = 0;
  for (const tx of rows) {
    for (const [kind, doc] of [
      ["check", tx.check],
      ["invoice", tx.invoice],
    ] as const) {
      if (!doc) continue;
      const object = await env.BUCKET.get(doc.r2_key);
      if (!object) continue;
      const plaintext = await decryptDocument(env.DATA_KEY_SECRET, await object.arrayBuffer());
      const name = imageFileName(tx, doc, kind);
      if (name) {
        files[`images/${name}`] = plaintext;
        imageCount++;
      }
    }
  }

  const zipBytes = zipSync(files, { level: 6 });
  const zipKey = `exports/${stamp}.zip`;
  const fileName = `snap-accountant-${stamp}.zip`;

  await env.BUCKET.put(zipKey, zipBytes, {
    httpMetadata: { contentType: "application/zip" },
    customMetadata: { recordCount: String(rows.length), imageCount: String(imageCount) },
  });

  // Audit history in D1 + stamp exported transactions.
  const batchInsert = await db
    .insert(exportBatches)
    .values({
      exported_by: opts.exportedBy,
      file_r2_key: zipKey,
      record_count: rows.length,
    })
    .returning();
  const batchId = batchInsert[0]?.id;

  const exportedAt = Date.now();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    for (const id of ids) {
      await db
        .update(transactions)
        .set({ exported_at: exportedAt })
        .where(eq(transactions.id, id));
    }
  }

  if (batchId) {
    await recordAudit(db, {
      actorId: opts.exportedBy,
      action: "export",
      batchId,
      detail: `exported ${rows.length} transactions to ${zipKey}`,
    });
  }

  return { zipBytes, zipKey, fileName, recordCount: rows.length };
}