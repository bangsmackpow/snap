import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import type { AppEnv } from "./env";
import { requireSession } from "./lib/auth";
import { apiRoutes } from "./routes/api";
import { accountantRoutes } from "./routes/accountant";
import { adminRoutes } from "./routes/admin";

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: (origin: string, c: Context<AppEnv>) => {
      if (!origin) return undefined;
      const allowed = (c.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return allowed.includes(origin) ? origin : undefined;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

app.get("/healthz", requireSession, (c) =>
  c.json({ ok: true, role: c.var.session.user_role, at: Date.now() })
);

app.route("/api", apiRoutes);
app.route("/api/accountant", accountantRoutes);
app.route("/api/admin", adminRoutes);

// Static assets in public/ are served by Workers Static Assets before this
// Worker runs (assets-first). Anything that reaches here is an API 404.
app.all("*", (c) => c.text("Not found", 404));

export default app;