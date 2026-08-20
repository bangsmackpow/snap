import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { adminUsers, enrollCodes, sessions } from "../db/schema";
import { getDb, sessionCookie, clearSessionCookie } from "../lib/auth";
import {
  bootstrapAdmin,
  generateEnrollCode,
  hashPassword,
  issueAdminSession,
  requireAdmin,
  verifyPassword,
} from "../lib/admin";
import { z } from "zod";

const admin = new Hono<AppEnv>();

// ---- login (no auth required) ----------------------------------------------

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

admin.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  // Ensure a first admin exists if bootstrap secrets are configured.
  await bootstrapAdmin(c.env);

  const db = getDb(c.env);
  const users = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.username, parsed.data.username))
    .limit(1);
  const user = users[0];
  if (!user || user.active !== 1) return c.json({ error: "bad_credentials" }, 401);

  const ok = await verifyPassword(parsed.data.password, user.salt, user.password_hash);
  if (!ok) return c.json({ error: "bad_credentials" }, 401);

  const token = await issueAdminSession(c.env, user.id);
  await db
    .update(adminUsers)
    .set({ last_login_at: Date.now() })
    .where(eq(adminUsers.id, user.id));

  const secure = c.env.COOKIE_SECURE !== "false";
  c.header("Set-Cookie", sessionCookie(token, { secure, maxAgeSec: 12 * 60 * 60 }));
  return c.json({ authenticated: true, role: "admin", username: user.username });
});

admin.post("/logout", (c) => {
  const secure = c.env.COOKIE_SECURE !== "false";
  c.header("Set-Cookie", clearSessionCookie({ secure }));
  return c.json({ authenticated: false });
});

admin.get("/me", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const adminId = c.var.session.user_id ?? c.var.session.id;
  const users = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, adminId))
    .limit(1);
  const user = users[0];
  if (!user) return c.json({ error: "not_found" }, 404);
  return c.json({ authenticated: true, role: "admin", username: user.username });
});

// ---- users (requireAdmin) ---------------------------------------------------

const createUserSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(256),
});

admin.get("/users", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: adminUsers.id,
      username: adminUsers.username,
      active: adminUsers.active,
      last_login_at: adminUsers.last_login_at,
      created_at: adminUsers.created_at,
    })
    .from(adminUsers)
    .orderBy(desc(adminUsers.created_at));
  return c.json({ users: rows });
});

admin.post("/users", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const db = getDb(c.env);
  const existing = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.username, parsed.data.username))
    .limit(1);
  if (existing[0]) return c.json({ error: "username_taken" }, 409);

  const { hash, salt } = await hashPassword(parsed.data.password);
  const row = await db
    .insert(adminUsers)
    .values({ username: parsed.data.username, password_hash: hash, salt })
    .returning();
  return c.json({
    user: {
      id: row[0].id,
      username: row[0].username,
      active: row[0].active,
      created_at: row[0].created_at,
    },
  });
});

const updateUserSchema = z.object({
  password: z.string().min(8).max(256).optional(),
  active: z.number().int().optional(),
});

admin.patch("/users/:id", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const db = getDb(c.env);
  const id = c.req.param("id");
  const existing = (
    await db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1)
  )[0];
  if (!existing) return c.json({ error: "not_found" }, 404);

  const patch: { password_hash?: string; salt?: string; active?: number } = {};
  if (parsed.data.password) {
    const { hash, salt } = await hashPassword(parsed.data.password);
    patch.password_hash = hash;
    patch.salt = salt;
  }
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;

  await db.update(adminUsers).set(patch).where(eq(adminUsers.id, id));
  const updated = (
    await db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1)
  )[0];
  return c.json({
    user: {
      id: updated.id,
      username: updated.username,
      active: updated.active,
      created_at: updated.created_at,
    },
  });
});

admin.delete("/users/:id", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const selfId = c.var.session.user_id ?? c.var.session.id;
  if (id === selfId) return c.json({ error: "cannot_delete_self" }, 400);
  await db.delete(adminUsers).where(eq(adminUsers.id, id));
  return c.json({ deleted: true });
});

// ---- enrollment codes (requireAdmin) ----------------------------------------

const createCodeSchema = z.object({
  label: z.string().max(120).optional(),
  expires_at: z.number().nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
});

admin.get("/enroll-codes", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(enrollCodes)
    .orderBy(desc(enrollCodes.created_at));
  return c.json({ codes: rows });
});

admin.post("/enroll-codes", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createCodeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const { code, id } = await generateEnrollCode(c.env, {
    label: parsed.data.label,
    createdBy: c.var.session.id,
    expiresAt: parsed.data.expires_at ?? null,
    maxUses: parsed.data.max_uses ?? null,
  });
  // Plaintext code is returned exactly once; only the hash is stored.
  return c.json({ code, id });
});

admin.patch("/enroll-codes/:id", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const active = body?.active;
  if (typeof active !== "number") return c.json({ error: "invalid_body" }, 400);
  const db = getDb(c.env);
  await db
    .update(enrollCodes)
    .set({ active })
    .where(eq(enrollCodes.id, c.req.param("id")));
  return c.json({ updated: true });
});

admin.delete("/enroll-codes/:id", requireAdmin, async (c) => {
  const db = getDb(c.env);
  await db.delete(enrollCodes).where(eq(enrollCodes.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// ---- active sessions (requireAdmin) -----------------------------------------

admin.get("/sessions", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: sessions.id,
      user_role: sessions.user_role,
      expires_at: sessions.expires_at,
      created_at: sessions.created_at,
    })
    .from(sessions)
    .orderBy(desc(sessions.created_at))
    .limit(200);
  return c.json({ sessions: rows });
});

admin.post("/sessions/:id/revoke", requireAdmin, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  if (id === c.var.session.id) return c.json({ error: "cannot_revoke_self" }, 400);
  await db.delete(sessions).where(eq(sessions.id, id));
  return c.json({ revoked: true });
});

export { admin as adminRoutes };