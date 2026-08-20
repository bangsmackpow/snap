# Snap Ledger

A lean, document-pairing ledger for non-technical farm operators, built entirely on
the Cloudflare ecosystem. Capture checks and invoices with a phone, have the details
extracted automatically, pair them, review them, and hand the accountant a
QuickBooks-ready export — all without typing a single line.

- **API runtime:** Cloudflare Workers + [Hono](https://honojs.dev)
- **Database:** Cloudflare D1 (SQLite) via [Drizzle ORM](https://orm.drizzle.team)
- **Storage:** Cloudflare R2 — check/invoice images encrypted at rest
- **Vision:** Gemini Flash extracts structured JSON from check/invoice photos
- **Frontends:** touch-first PWA (farmer) + desktop accountant portal, both vanilla JS
- **Exports:** QuickBooks IIF, Schedule F CSV, and a ZIP reconciliation package

## Features

### Farmer PWA (`/`)
- One-tap camera capture of checks and invoices
- Auto-detect type, instant extraction card, no typing required
- **Pair Recent** mode: snap invoice → snap check → **Save & Pair**
- Optional device enrollment key; persistent HttpOnly session cookie

### Accountant Portal (`/accountant.html`)
- Desktop split-pane review workspace
- Side-by-side check/invoice image viewer (zoom, pan, rotate)
- Editable fields + Chart of Accounts / Schedule F dropdown
- Keyboard-driven review: `A` approve & next, `F` flag, `U` unlink, `←/→` navigate
- Magic-link auth with single-use tokens

### Admin Area (`/admin`)
- Username/password login with PBKDF2-hashed accounts in D1
- Dedicated `snap_admin` session cookie, so admin sessions never clash with the
  farmer/accountant `snap_session` cookie
- Manage admin users (create, reset password, disable, delete)
- Generate and revoke per-user farmer enrollment codes
- View and force-logout active sessions
- First admin bootstrapped from `ADMIN_BOOTSTRAP_USERNAME`/`ADMIN_BOOTSTRAP_PASSWORD`

### Export Engine
- QuickBooks **IIF** (`CHECK` / `BILL` / `BILLPAY`)
- Schedule F **CSV** with category inference
- **ZIP** bundle containing `.iif`, `.csv`, and decrypted image pairs
- Bundles saved to R2 with an immutable audit history

## Getting started

Requires Node 20+ and [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
npm install
cp .dev.vars.example .dev.vars   # add your secrets
npm run db:generate              # generate a D1 migration from the schema
npm run db:migrate               # apply migrations to local D1
npm run dev                      # local worker + D1 + R2 + static assets
```

Open `http://localhost:8787` for the farmer PWA. Generate an accountant link from the
farmer session (or call `POST /api/auth/accountant-link`) and visit
`/accountant.html?t=<token>`.

### Scripts

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Generate D1 migration | `npm run db:generate` |
| Apply migration (local) | `npm run db:migrate` |
| Apply migration (prod) | `npm run db:migrate:remote` |
| Deploy | `npm run deploy` |

## Configuration

Bindings are defined in `wrangler.jsonc`:

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 | SQLite database (sessions, documents, transactions, rules, audit) |
| `BUCKET` | R2 | Encrypted image + export bundle storage |

Secrets come from `.dev.vars` locally and `wrangler secret put` in production
(`AUTH_SECRET`, `DATA_KEY_SECRET`, `VISION_API_KEY`, `ENROLL_KEY`, `COOKIE_SECURE`,
`ALLOWED_ORIGINS`).

## Architecture

```
public/            Farmer PWA + accountant portal (static assets)
src/
  index.ts         Hono app: mounts /api, serves static assets, healthz
  env.ts           Typed Env bindings
  routes/
    api.ts         Farmer routes: auth, upload, documents, preview, transactions
    accountant.ts  Accountant routes: review queue, categorize, audit, export
  services/
    iif.ts         QuickBooks IIF generator
    csv.ts         Schedule F CSV generator + category inference
    export.ts      Range query + ZIP bundle builder (fflate)
  lib/
    auth.ts        Web Crypto HMAC sessions + magic links + middleware
    crypto.ts      AES-GCM envelope encryption for R2
    vision.ts      Gemini extraction + zod validation
    pairing.ts     Heuristic check/invoice pairing
    validation.ts  zod extraction schemas
  db/schema.ts     Drizzle schema (D1)
```

### Security model

- **Sessions:** random 32-byte tokens, stored hashed (SHA-256) in D1, delivered as
  HttpOnly cookies. Farmer/accountant sessions use `snap_session`; **admin sessions
  use a separate `snap_admin` cookie** so the three roles never clobber each other.
- **Magic links:** `snap.magic.<payload>.<hmac>` signed with `AUTH_SECRET`, recorded in
  `magic_links` for single-use, exchanged for a persistent accountant session.
- **R2 encryption:** every document image is encrypted with AES-GCM using a fresh data
  key sealed under a master key derived from `DATA_KEY_SECRET`. R2 objects are
  `docs/<uuid>.enc` and are decrypted only on `GET /api/documents/:id/preview`.
- **Admin passwords:** stored as salted PBKDF2 hashes (Web Crypto) in `admin_users`,
  never plaintext; admin sessions are stored in `sessions` with `user_role = 'admin'`.

### Data model

- `sessions` — farmer/accountant auth tokens
- `documents` — uploaded images + typed `extraction_json`
- `transactions` — paired/unpaired check+invoice records (amounts in integer cents)
- `category_rules` — vendor/memo keyword → ledger account mappings
- `audit_log` — immutable append-only audit trail
- `export_batches` — history of generated bundles
- `magic_links` — issued accountant magic links

## Deployment

The project deploys as a single Cloudflare Worker (`snap`) at
`https://snap.curtislamasters.workers.dev`.

### One-time setup

1. Create the D1 database and R2 bucket (or `wrangler d1 create` / `wrangler r2 bucket create`).
2. Set the real `database_id` in `wrangler.jsonc`.
3. `wrangler secret put` for each of the secrets (`AUTH_SECRET`, `DATA_KEY_SECRET`,
   `VISION_API_KEY`, `COOKIE_SECURE`, `ALLOWED_ORIGINS`).
4. `npm run db:migrate:remote` to apply migrations.
5. `npm run deploy`.

### Auto-deploy (Workers Builds)

The `snap` Worker is connected to this GitHub repo via **Workers Builds**. Pushing to
the `main` branch automatically installs dependencies, runs `npm run deploy`
(`wrangler deploy`), and promotes the new version to Active. No manual deploy needed
for routine changes — just push to `main`.

- Trigger branch: `main`
- Deploy command: `npm run deploy`
- Build history: Cloudflare dashboard → **Workers & Pages** → `snap` → **Deployments**

## Repository notes

- TypeScript is pinned to `~5.9.0` — do **not** bump to TS 7 (the native compiler
  chokes on Drizzle's generic overloads).
- `drizzle-kit` ≥ 0.31 dropped `driver: "d1"`; migrations are applied via `wrangler d1
  migrations apply`, not `drizzle-kit migrate`.
- Drizzle self-joins use `alias()` from `sqlite-core` (not `aliasedTable`).
- See `AGENTS.md` for the full verified command set and operational gotchas.
