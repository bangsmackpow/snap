import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { SessionRow } from "./db/schema";

export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH_SECRET: string;
  DATA_KEY_SECRET: string;
  VISION_API_KEY?: string;
  VISION_MODEL?: string;
  AUTH_TOKEN_TTL_DAYS?: string;
  MAGIC_LINK_TTL_MINUTES?: string;
  ENROLL_KEY?: string;
  ADMIN_BOOTSTRAP_USERNAME?: string;
  ADMIN_BOOTSTRAP_PASSWORD?: string;
  COOKIE_SECURE?: string;
  ALLOWED_ORIGINS?: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    session: SessionRow;
  };
};