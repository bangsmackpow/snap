import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { adminUsers, enrollCodes } from "../db/schema";
import type { Env, AppEnv } from "../env";
import { getDb, getSessionFromRequest, hashToken, issueSessionToken, type Db } from "./auth";
import { bytesToHex, toBase64Url } from "./encoding";

// ---- password hashing (PBKDF2 via Web Crypto, no external deps) -------------

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = saltHex
    ? hexToBytes(saltHex)
    : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const salt = bytesToHex(saltBytes);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_BYTES * 8
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt };
}

export async function verifyPassword(password: string, saltHex: string, expectedHash: string): Promise<boolean> {
  const { hash } = await hashPassword(password, saltHex);
  return constantTimeHexEqual(hash, expectedHash);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- admin session ----------------------------------------------------------

export async function issueAdminSession(env: Env, adminId: string): Promise<string> {
  const ttlMs = 12 * 60 * 60 * 1000; // 12h admin session
  // Store the admin user id on the session so /me and self-guards resolve the
  // admin user from the session alone. Session id stays unique per login.
  return issueSessionToken(env, { role: "admin", ttlMs, userId: adminId });
}

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const session = await getSessionFromRequest(c.env, c.req.raw);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.user_role !== "admin") return c.json({ error: "forbidden" }, 403);
  c.set("session", session);
  await next();
});

// ---- enrollment codes -------------------------------------------------------

export async function generateEnrollCode(
  env: Env,
  opts: { label?: string; createdBy?: string; expiresAt?: number | null; maxUses?: number | null }
): Promise<{ code: string; id: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(9)); // 12 base64url chars
  const code = toBase64Url(raw);
  const db = getDb(env);
  const row = await db
    .insert(enrollCodes)
    .values({
      code_hash: await hashToken(code),
      label: opts.label ?? null,
      created_by: opts.createdBy ?? null,
      expires_at: opts.expiresAt ?? null,
      max_uses: opts.maxUses ?? null,
    })
    .returning();
  return { code, id: row[0].id };
}

// Validate + consume an enrollment code. Returns true if the code is valid and
// was consumed (used_count incremented). Returns false if invalid/expired/used-up.
export async function consumeEnrollCode(env: Env, code: string): Promise<boolean> {
  const db = getDb(env);
  const codeHash = await hashToken(code);
  const rows = await db
    .select()
    .from(enrollCodes)
    .where(eq(enrollCodes.code_hash, codeHash))
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (row.active !== 1) return false;
  if (row.expires_at != null && row.expires_at <= Date.now()) return false;
  if (row.max_uses != null && row.used_count >= row.max_uses) return false;

  await db
    .update(enrollCodes)
    .set({ used_count: row.used_count + 1 })
    .where(eq(enrollCodes.id, row.id));
  return true;
}

// ---- bootstrap first admin --------------------------------------------------

// If ADMIN_BOOTSTRAP_USERNAME + ADMIN_BOOTSTRAP_PASSWORD are set and no admin
// exists yet, create the first admin. Returns true if one was created.
export async function bootstrapAdmin(env: Env): Promise<boolean> {
  const username = env.ADMIN_BOOTSTRAP_USERNAME;
  const password = env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!username || !password) return false;

  const db = getDb(env);
  const existing = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.username, username))
    .limit(1);
  if (existing[0]) return false;

  const { hash, salt } = await hashPassword(password);
  await db.insert(adminUsers).values({ username, password_hash: hash, salt });
  return true;
}

export { getDb, type Db };