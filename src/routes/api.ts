import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AppEnv } from "../env";
import { documents, exportBatches, magicLinks, transactions } from "../db/schema";
import type { DocRow, DocStatus, DocType } from "../db/schema";
import {
  clearSessionCookie,
  createMagicLinkToken,
  exchangeMagicForSession,
  getDb,
  hashToken,
  issueSessionToken,
  sessionCookie,
} from "../lib/auth";
import { requireFarmer, getSessionFromRequest } from "../lib/auth";
import { decryptDocument, encryptDocument } from "../lib/crypto";
import { runExtraction, isUsableDocType } from "../lib/vision";
import { autoPair, pairTwoDocs } from "../lib/pairing";
import { buildExportBundle } from "../services/export";
import { enrollRequestSchema, pairRequestSchema, uploadHintSchema } from "../lib/validation";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const api = new Hono<AppEnv>();

// ---- auth ------------------------------------------------------------------

api.post("/auth/enroll", async (c) => {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // body optional
  }
  const parsed = enrollRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const requiredKey = c.env.ENROLL_KEY;
  if (requiredKey && parsed.data.enroll_key !== requiredKey) {
    return c.json({ error: "bad_enroll_key" }, 401);
  }

  const ttlDays = Number(c.env.AUTH_TOKEN_TTL_DAYS ?? 365);
  const token = await issueSessionToken(c.env, { role: "farmer", ttlMs: ttlDays * 86_400_000 });
  const secure = c.env.COOKIE_SECURE !== "false";
  c.header("Set-Cookie", sessionCookie(token, { secure, maxAgeSec: ttlDays * 86_400 }));
  return c.json({ authenticated: true, role: "farmer" });
});

api.get("/auth/me", async (c) => {
  const session = await getSessionFromRequest(c.env, c.req.raw);
  if (!session) return c.json({ authenticated: false }, 200);
  return c.json({ authenticated: true, role: session.user_role });
});

api.post("/auth/logout", (c) => {
  const secure = c.env.COOKIE_SECURE !== "false";
  c.header("Set-Cookie", clearSessionCookie({ secure }));
  return c.json({ authenticated: false });
});

// Generate a time-limited accountant magic link (farmer-initiated). The URL is
// HMAC-signed, recorded in D1 for single-use, and expires after MAGIC_LINK_TTL.
api.post("/auth/accountant-link", requireFarmer, async (c) => {
  const ttlMinutes = Math.max(1, Number(c.env.MAGIC_LINK_TTL_MINUTES ?? 15) || 15);
  const token = await createMagicLinkToken(c.env, {
    sub: c.var.session.id,
    role: "accountant",
    ttlMs: ttlMinutes * 60_000,
  });

  const db = getDb(c.env);
  await db.insert(magicLinks).values({
    token_hash: await hashToken(token),
    role: "accountant",
    expires_at: Date.now() + ttlMinutes * 60_000,
  });

  const base = new URL(c.req.url).origin;
  const url = `${base}/accountant.html?t=${encodeURIComponent(token)}`;
  return c.json({ url, expires_in_minutes: ttlMinutes });
});

// Consume a magic-link token (from accountant.html?t=...). Exchanges it for a
// persistent accountant session cookie, then redirects to the portal.
api.post("/auth/accountant/consume", async (c) => {
  const body = await c.req.json().catch(() => null);
  const token = (body?.t as string | undefined) ?? c.req.query("t");
  const result = await exchangeMagicForSession(c.env, token);
  if (!result) return c.json({ error: "invalid_or_expired_link" }, 401);
  const secure = c.env.COOKIE_SECURE !== "false";
  c.header(
    "Set-Cookie",
    sessionCookie(result.token, {
      secure,
      maxAgeSec: (Number(c.env.MAGIC_LINK_TTL_MINUTES ?? 15) || 15) * 60,
    })
  );
  return c.json({ authenticated: true, role: "accountant" });
});

// ---- upload & ingestion -----------------------------------------------------

api.post("/upload", requireFarmer, async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let file: File | undefined;
  let hint: "check" | "invoice" | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) return c.json({ error: "missing_file" }, 400);
    file = f;
    const rawHint = form.get("doc_type")?.toString();
    if (rawHint) {
      const parsed = uploadHintSchema.safeParse(rawHint);
      if (!parsed.success) return c.json({ error: "bad_doc_type" }, 400);
      hint = parsed.data;
    }
  } else {
    const bytes = await c.req.arrayBuffer();
    const mime = contentType || "image/jpeg";
    const fname = c.req.header("x-filename") ?? "upload";
    file = new File([bytes], fname, { type: mime });
    const rawHint = c.req.header("x-doc-type");
    if (rawHint) {
      const parsed = uploadHintSchema.safeParse(rawHint);
      if (!parsed.success) return c.json({ error: "bad_doc_type" }, 400);
      hint = parsed.data;
    }
  }

  if (!file || file.size === 0) return c.json({ error: "empty_file" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "file_too_large" }, 413);

  const id = crypto.randomUUID();
  const imageBytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = file.type || "image/jpeg";

  const result = await runExtraction(c.env, { imageBytes, mimeType, hint });

  const docType = result.ok
    ? result.data.doc_type
    : hint ?? "unknown";

  const envelope = await encryptDocument(c.env.DATA_KEY_SECRET, imageBytes);
  const r2Key = `docs/${id}.enc`;
  await c.env.BUCKET.put(r2Key, envelope, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { originalMime: mimeType, docType },
  });

  const db = getDb(c.env);
  const doc: DocRow = {
    id,
    doc_type: docType,
    r2_key: r2Key,
    mime_type: mimeType,
    status: result.ok ? "ready" : "error",
    extraction_json: result.ok ? JSON.stringify(result.data) : null,
    extraction_error: result.ok ? null : result.error,
    created_at: Date.now(),
  };
  await db.insert(documents).values(doc);

  let transaction = null;
  let matched = null;
  if (result.ok && isUsableDocType(docType)) {
    const pair = await autoPair(db, doc);
    transaction = pair.transaction;
    matched = pair.matched;
  }

  return c.json(
    {
      document: doc,
      extraction: result.ok
        ? result.data
        : { doc_type: "unknown", error: result.error },
      transaction,
      matched,
    },
    201
  );
});

// ---- documents --------------------------------------------------------------

api.get("/documents", requireFarmer, async (c) => {
  const type = c.req.query("type");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const db = getDb(c.env);
  const where = type ? eq(documents.doc_type, type as DocType) : undefined;
  const rows = where
    ? await db.select().from(documents).where(where).orderBy(desc(documents.created_at)).limit(limit)
    : await db.select().from(documents).orderBy(desc(documents.created_at)).limit(limit);
  return c.json({ documents: rows });
});

api.get("/documents/:id", requireFarmer, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, c.req.param("id")))
    .limit(1);
  const doc = rows[0];
  if (!doc) return c.json({ error: "not_found" }, 404);
  return c.json({ document: doc });
});

api.get("/documents/:id/preview", requireFarmer, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, c.req.param("id")))
    .limit(1);
  const doc = rows[0];
  if (!doc) return c.json({ error: "not_found" }, 404);

  const object = await c.env.BUCKET.get(doc.r2_key);
  if (!object) return c.json({ error: "not_found" }, 404);

  const plaintext = await decryptDocument(c.env.DATA_KEY_SECRET, await object.arrayBuffer());
  return new Response(plaintext, {
    headers: {
      "Content-Type": doc.mime_type || "image/jpeg",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${doc.id}"`,
    },
  });
});

api.post("/documents/:id/extract", requireFarmer, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, c.req.param("id")))
    .limit(1);
  const doc = rows[0];
  if (!doc) return c.json({ error: "not_found" }, 404);

  const object = await c.env.BUCKET.get(doc.r2_key);
  if (!object) return c.json({ error: "not_found" }, 404);

  const plaintext = await decryptDocument(c.env.DATA_KEY_SECRET, await object.arrayBuffer());
  const hint = isUsableDocType(doc.doc_type) ? doc.doc_type : undefined;
  const result = await runExtraction(c.env, {
    imageBytes: plaintext,
    mimeType: doc.mime_type,
    hint,
  });

  const update = {
    status: (result.ok ? "ready" : "error") as DocStatus,
    extraction_json: result.ok ? JSON.stringify(result.data) : null,
    extraction_error: result.ok ? null : result.error,
  };

  await db
    .update(documents)
    .set(update)
    .where(eq(documents.id, doc.id));

  let transaction = null;
  let matched = null;
  if (result.ok) {
    const refreshed = (await db.select().from(documents).where(eq(documents.id, doc.id)).limit(1))[0];
    if (isUsableDocType(refreshed.doc_type)) {
      const pair = await autoPair(db, refreshed);
      transaction = pair.transaction;
      matched = pair.matched;
    }
  }

  return c.json({
    document: { ...doc, ...update },
    extraction: result.ok ? result.data : { doc_type: "unknown", error: result.error },
    transaction,
    matched,
  });
});

// ---- transactions -----------------------------------------------------------

const checkDoc = alias(documents, "check_doc");
const invoiceDoc = alias(documents, "invoice_doc");

api.get("/transactions", requireFarmer, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const db = getDb(c.env);
  const rows = await db
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
    .orderBy(desc(transactions.created_at))
    .limit(limit);
  return c.json({ transactions: rows });
});

api.post("/transactions/pair", requireFarmer, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = pairRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const { check_doc_id, invoice_doc_id } = parsed.data;

  const db = getDb(c.env);
  const checkDocs = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, check_doc_id), eq(documents.doc_type, "check")));
  const invoiceDocs = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, invoice_doc_id), eq(documents.doc_type, "invoice")));
  const checkDocRow = checkDocs[0];
  const invoiceDocRow = invoiceDocs[0];
  if (!checkDocRow || !invoiceDocRow) return c.json({ error: "not_found" }, 404);
  if (checkDocRow.status !== "ready" || invoiceDocRow.status !== "ready") {
    return c.json({ error: "doc_not_ready" }, 409);
  }

  const tx = await pairTwoDocs(db, checkDocRow, invoiceDocRow);
  return c.json({ transaction: tx });
});

// ---- exports ---------------------------------------------------------------

const EXPORT_RANGES = new Set(["month", "quarter", "ytd"]);

function parseRange(q: string | undefined): { from: number; to: number } | "month" | "quarter" | "ytd" | null {
  if (!q) return "month";
  if (EXPORT_RANGES.has(q)) return q as "month" | "quarter" | "ytd";
  if (q.includes(":")) {
    const [a, b] = q.split(":").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && a <= b) return { from: a, to: b };
  }
  return null;
}

// Generate + download an accountant bundle as a ZIP stream.
api.get("/exports/bundle", requireFarmer, async (c) => {
  const range = parseRange(c.req.query("range"));
  if (!range) return c.json({ error: "bad_range" }, 400);
  const session = c.var.session;
  try {
    const { zipBytes, fileName } = await buildExportBundle(c.env, {
      range,
      exportedBy: session.id,
    });
    return c.newResponse(zipBytes.slice().buffer, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    });
  } catch (err) {
    return c.json({ error: "export_failed" }, 500);
  }
});

// List export history.
api.get("/exports", requireFarmer, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(exportBatches)
    .orderBy(desc(exportBatches.created_at))
    .limit(limit);
  return c.json({ exports: rows });
});

// Re-download a previously saved bundle from R2.
api.get("/exports/:id/download", requireFarmer, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(exportBatches)
    .where(eq(exportBatches.id, c.req.param("id")))
    .limit(1);
  const batch = rows[0];
  if (!batch) return c.json({ error: "not_found" }, 404);
  const object = await c.env.BUCKET.get(batch.file_r2_key);
  if (!object) return c.json({ error: "not_found" }, 404);
  const bytes = await object.arrayBuffer();
  const name = batch.file_r2_key.split("/").pop() ?? "snap-export.zip";
  return c.newResponse(bytes, 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${name}"`,
  });
});

export { api as apiRoutes };