import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { createMiddleware } from "hono/factory";
import * as schema from "../db/schema";
import type { Env, AppEnv } from "../env";
import { bytesToHex, constantTimeEqual, fromBase64Url, toBase64Url } from "./encoding";

export const SESSION_COOKIE = "snap_session";
export const MAGIC_TOKEN_PREFIX = "snap.magic.";

export type Db = DrizzleD1Database<typeof schema>;

export function getDb(env: Env): Db {
  return drizzle(env.DB, { schema });
}

// ---- token primitives ------------------------------------------------------

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64Url(new Uint8Array(sig));
}

// ---- persistent session (farmer device enroll / accountant cookie) --------

export async function issueSessionToken(
  env: Env,
  opts: { role: schema.UserRole; ttlMs: number }
): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = toBase64Url(raw);
  const db = getDb(env);
  await db.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    user_role: opts.role,
    token_hash: await hashToken(token),
    expires_at: Date.now() + opts.ttlMs,
  });
  return token;
}

export async function verifySessionToken(
  env: Env,
  token: string | undefined | null
): Promise<schema.SessionRow | null> {
  if (!token) return null;
  const db = getDb(env);
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.token_hash, await hashToken(token)))
    .limit(1);
  const session = rows[0];
  if (!session || session.expires_at <= Date.now()) return null;
  return session;
}

export function getTokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

export async function getSessionFromRequest(
  env: Env,
  request: Request
): Promise<schema.SessionRow | null> {
  return verifySessionToken(env, getTokenFromRequest(request));
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSec: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

// ---- scoped magic-link tokens (accountant verification access) ------------

type MagicPayload = {
  kind: "magic";
  sub: string;
  role: schema.UserRole;
  exp: number;
};

export async function createMagicLinkToken(
  env: Env,
  opts: { sub: string; role: schema.UserRole; ttlMs: number }
): Promise<string> {
  const payload: MagicPayload = {
    kind: "magic",
    sub: opts.sub,
    role: opts.role,
    exp: Date.now() + opts.ttlMs,
  };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(env.AUTH_SECRET, body);
  return MAGIC_TOKEN_PREFIX + body + "." + sig;
}

export async function verifyMagicLinkToken(
  env: Env,
  token: string | undefined | null
): Promise<MagicPayload | null> {
  if (!token || !token.startsWith(MAGIC_TOKEN_PREFIX)) return null;
  const body = token.slice(MAGIC_TOKEN_PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  const expected = await hmacSign(env.AUTH_SECRET, payloadB64);
  if (!constantTimeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as MagicPayload;
    if (payload.kind !== "magic" || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Exchange a valid magic-link token for a persistent accountant session.
// Enforces single-use via the magic_links table. Returns the raw session token
// (deliver as the HttpOnly cookie) or null if invalid/expired/already-used.
export async function exchangeMagicForSession(
  env: Env,
  magicToken: string | undefined | null
): Promise<{ token: string; session: schema.SessionRow } | null> {
  const payload = await verifyMagicLinkToken(env, magicToken);
  if (!payload || payload.role !== "accountant") return null;

  const db = getDb(env);
  const tokenHash = await hashToken(magicToken as string);
  const links = await db
    .select()
    .from(schema.magicLinks)
    .where(eq(schema.magicLinks.token_hash, tokenHash))
    .limit(1);
  const link = links[0];
  // Reject if never recorded or already consumed.
  if (!link || link.used_at != null) return null;
  await db
    .update(schema.magicLinks)
    .set({ used_at: Date.now() })
    .where(eq(schema.magicLinks.id, link.id));

  const ttlMs = (Number(env.MAGIC_LINK_TTL_MINUTES ?? 15) || 15) * 60 * 1000;
  const token = await issueSessionToken(env, { role: "accountant", ttlMs });
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.token_hash, await hashToken(token)))
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  return { token, session };
}

// ---- Hono middleware -------------------------------------------------------

export const requireFarmer = createMiddleware<AppEnv>(async (c, next) => {
  const session = await getSessionFromRequest(c.env, c.req.raw);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.user_role !== "farmer") return c.json({ error: "forbidden" }, 403);
  c.set("session", session);
  await next();
});

export const requireAccountant = createMiddleware<AppEnv>(async (c, next) => {
  const session = await getSessionFromRequest(c.env, c.req.raw);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.user_role !== "accountant") return c.json({ error: "forbidden" }, 403);
  c.set("session", session);
  await next();
});

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await getSessionFromRequest(c.env, c.req.raw);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("session", session);
  await next();
});