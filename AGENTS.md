# AGENTS.md

Cloudflare-native ledger app: Hono on Workers, D1 (Drizzle), R2, and a touch-first
PWA capture UI in `public/`. This file captures the non-obvious, verified facts.

## Commands (always `rtk`-prefixed)

| Task | Command |
|---|---|
| Dev server | `rtk npm run dev` (binds `DB`+`BUCKET` locally; serves `public/`) |
| Typecheck | `rtk npm run typecheck` |
| Generate D1 migration | `rtk npm run db:generate` (drizzle-kit) |
| Apply migration locally | `rtk npm run db:migrate` (`wrangler d1 migrations apply DB --local`) |
| Apply to prod | `rtk npm run db:migrate:remote` |
| Deploy | `rtk npm run deploy` |
| Bundle-only check | `rtk npx wrangler deploy --dry-run --outdir=dist` |

Verification order after any change: `typecheck` → `db:generate` (no-diff check) →
`deploy --dry-run` → smoke test against `wrangler dev`.

## Dependencies / versions (verified)

- `typescript` is pinned to `~5.9.0`. **Do not bump to TS 7** — the native compiler
  chokes on drizzle-orm's generic insert/update overloads (hundreds of false
  `TS2769` errors).
- `drizzle-kit` ≥0.31 removed the `driver: "d1"` config option. `drizzle.config.ts`
  is just `dialect: "sqlite"` + schema/out. Migrations are applied via wrangler,
  not `drizzle-kit migrate`.
- `sqlite-core` exports `alias()` for self-joins (NOT `aliasedTable`, which is
  `drizzle-orm` root only and not exported from sqlite-core).

## Architecture & wiring

- Single Worker `src/index.ts` mounts `/api` routes (`src/routes/api.ts`) and serves
  the PWA from `public/` via Workers Static Assets (assets run *before* the Worker,
  so only unmatched paths hit the `*` 404 handler).
- `Env` is typed in `src/env.ts`. Secrets (`AUTH_SECRET`, `DATA_KEY_SECRET`,
  `VISION_API_KEY`, `ENROLL_KEY`, `COOKIE_SECURE`, `ALLOWED_ORIGINS`) come from
  `.dev.vars` locally and `wrangler secret put` in prod — never `wrangler.jsonc` vars.
- D1 access goes through `getDb(env)` (`src/lib/auth.ts`) → `drizzle(env.DB)`.

## Auth model (`src/lib/auth.ts`)

- Persistent farmer token: random 32-byte token, stored hashed (SHA-256) in the
  `sessions` table, delivered as an HttpOnly `snap_session` cookie. Issued once via
  `POST /api/auth/enroll` (optionally gated by `ENROLL_KEY`).
- Accountant magic-link tokens: `snap.magic.<b64payload>.<hmac>` signed with
  `AUTH_SECRET` (Web Crypto HMAC-SHA-256), short TTL. Issued via
  `POST /api/auth/accountant-link` (farmer), recorded in `magic_links` for
  **single-use**, consumed by `POST /api/auth/accountant/consume` which swaps it
  for a persistent accountant session cookie.
- Every write path that touches PII/images uses `requireFarmer`. Preview/read routes
  also require a session. All `/api/accountant/*` routes are behind `requireAccountant`.

## R2 encryption (must not regress)

Check/invoice images are stored **encrypted at rest** in R2 via an AES-GCM envelope
(`src/lib/crypto.ts`): each doc gets a fresh random data key, sealed under a master
key derived from `DATA_KEY_SECRET` (SHA-256). R2 objects are `docs/<uuid>.enc`.
Decryption happens only on `GET /api/documents/:id/preview` (which is why the DB
stores `r2_key`, not a public URL). If you add a download route, route it through
`decryptDocument`, never expose raw `.enc` bytes.

## Ingestion / pairing

- `POST /api/upload` accepts multipart (`file` field, optional `doc_type` hint) or
  a raw binary body (with `x-doc-type` header). Always writes to R2 first, then D1.
- Extraction (`src/lib/vision.ts`) calls Gemini Flash (`VISION_MODEL`) and validates
  output with `extractionSchema` (`src/lib/validation.ts`, zod discriminated union).
  No API key locally → returns `error: "vision_api_key_missing"` and stores the doc
  with `status: "error"` (graceful, not a crash). Use `POST /api/documents/:id/extract`
  to retry.
- Heuristic pairing (`src/lib/pairing.ts`): amounts compared in cents, vendor names
  normalized (stopword suffix list), 90-day window. `AUTO_PAIR_THRESHOLD = 60`.
  Manual "Save & Pair" uses `POST /api/transactions/pair` (requires both docs `ready`).

## Export engine (`src/services/`)

- `iif.ts` emits QuickBooks IIF (`!TRNS`/`!SPL`/`!ENDTRNS`). Txn type per row:
  no check → `BILL` (Accounts Payable split); paired check+invoice → `BILLPAY`;
  check only → `CHECK`. TRNS amount is negative for bank outflows; SPL positive
  against the Schedule F expense account.
- `csv.ts` infers Schedule F category from payee/memo keywords (`inferCategory`,
  keyword-order matters — put specific phrases before generic "supplies").
- `export.ts` queries paired/unpaired transactions in a date range (joined to
  check/invoice docs), builds a single ZIP (`fflate` `zipSync`) containing
  `ledger.iif`, `ledger.csv`, and decrypted images as `images/<date>_<Check#|kind>_<vendor>.<ext>`.
  Saves the zip to R2 `exports/<stamp>.zip` and records an `export_batches` row.
- Routes: `GET /api/exports/bundle?range=month|quarter|ytd|from:to` (streams zip),
  `GET /api/exports` (history), `GET /api/exports/:id/download` (re-fetch from R2).
- `fflate`'s `zipSync` output validates fine in Python `zipfile`; the node CJS
  `unzipSync` can report "invalid zip data" on the same bytes — trust Python for
  manual bundle inspection.

## Accountant portal (Phase 3, `src/routes/accountant.ts` + `public/accountant.*`)

- Desktop portal at `/accountant.html` (separate from the farmer PWA). Auth is a
  magic link (`?t=...`) consumed into an accountant session cookie.
- Split-pane review: left = review queue, center = check/invoice image viewer
  (zoom/pan/rotate), right = editable form + Chart of Accounts dropdown.
  Keyboard: `A` approve & next, `F` flag, `U` unlink, `R` rotate, `←/→` navigate.
- `PATCH /api/accountant/transactions/:id` approves (sets `status=verified` +
  `verified_at`/`verified_by`), flags, or edits fields; every action writes an
  `audit_log` row. `POST .../:id/unlink` splits a pair back to unpaired.
- Category rules live in `category_rules` (vendor/memo keyword → ledger account,
  `priority`-ordered). CRUD via `/api/accountant/category-rules`. Batch updates via
  `POST /api/accountant/batch-categorize`. NOTE: rules are stored/editable but NOT
  yet auto-applied by extraction/pairing — only the accountant's explicit category
  assignment and the static `inferCategory` heuristic in csv.ts drive categorization.
- `POST /api/accountant/export` triggers the Phase 2 bundle builder (writes an
  `export` audit row + stamps `exported_at`).
- Audit trail: `audit_log` (immutable append-only). `GET /api/accountant/audit`.

## Schema & data model (`src/db/schema.ts`)

- IDs are generated by drizzle `$defaultFn(() => crypto.randomUUID())` — do NOT pass
  `id` on insert (drizzle's D1 type will reject it).
- `documents` stores the typed extraction as `extraction_json` (string); parse it
  with `parseExtraction` before using. `doc_type` is a union enum.
- `transactions` links `check_doc_id` / `invoice_doc_id` and mirrors denormalized
  `vendor_payee`, `amount` (cents, integer), `transaction_date` (epoch ms).
- Amounts in DB are integer cents; `toCents()` converts. The PWA formats via
  `moneyCents`.

## Frontend (PWA, `public/`)

- Vanilla ES module (`app.js`) + `index.html` + `styles.css`; no framework. `capture`
  attribute on the file input opens the camera. `manifest.webmanifest` + `sw.js`
  provide installability/offline shell.
- "Pair Recent" flow is client-state only (`state.pair`): snap invoice, then check,
  then `POST /api/transactions/pair`. No typing required.
- The Export dialog (`<dialog>`) in the header: "Download Accountant Package" builds
  `/api/exports/bundle` from a radio-selected range and triggers a client-side download.

## Local dev quirks

- The local D1 lives under `.wrangler/state/...` (gitignored). Reset local data by
  deleting `.wrangler/` and re-running `db:migrate`.
- `wrangler dev` prints a "Local Explorer API" banner — ignore it; the app is on the
  configured port. Smoke-test auth'd flows with `curl -c/-b` cookie jars.
- `.dev.vars` is gitignored; keep `.dev.vars.example` in sync when adding a secret.
