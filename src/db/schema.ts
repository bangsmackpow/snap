import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const userRoles = ["farmer", "accountant"] as const;
export type UserRole = (typeof userRoles)[number];

export const docTypes = ["check", "invoice", "receipt", "unknown"] as const;
export type DocType = (typeof docTypes)[number];

export const docStatuses = ["processing", "ready", "error"] as const;
export type DocStatus = (typeof docStatuses)[number];

export const transactionStatuses = ["unpaired", "paired", "verified"] as const;
export type TransactionStatus = (typeof transactionStatuses)[number];

export const auditActions = ["verify", "flag", "unlink", "reopen", "categorize", "export", "update"] as const;
export type AuditAction = (typeof auditActions)[number];

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  user_role: text("user_role", { enum: userRoles }).notNull(),
  token_hash: text("token_hash").notNull(),
  expires_at: integer("expires_at").notNull(),
  created_at: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    doc_type: text("doc_type", { enum: docTypes }).notNull(),
    r2_key: text("r2_key").notNull(),
    mime_type: text("mime_type").notNull(),
    status: text("status", { enum: docStatuses }).notNull().default("processing"),
    extraction_json: text("extraction_json"),
    extraction_error: text("extraction_error"),
    created_at: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [
    index("documents_type_status_idx").on(t.doc_type, t.status),
  ]
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    check_doc_id: text("check_doc_id").references(() => documents.id, { onDelete: "set null" }),
    invoice_doc_id: text("invoice_doc_id").references(() => documents.id, { onDelete: "set null" }),
    vendor_payee: text("vendor_payee"),
    amount: integer("amount"),
    transaction_date: integer("transaction_date"),
    check_number: text("check_number"),
    memo: text("memo"),
    category_code: text("category_code"),
    confidence_score: integer("confidence_score"),
    status: text("status", { enum: transactionStatuses }).notNull().default("unpaired"),
    flagged: integer("flagged").notNull().default(0),
    flag_reason: text("flag_reason"),
    verified_at: integer("verified_at"),
    verified_by: text("verified_by"),
    exported_at: integer("exported_at"),
    created_at: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [
    index("transactions_status_idx").on(t.status),
    index("transactions_flagged_idx").on(t.flagged),
    index("transactions_check_doc_idx").on(t.check_doc_id),
    index("transactions_invoice_doc_idx").on(t.invoice_doc_id),
  ]
);

export const exportBatches = sqliteTable("export_batches", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  exported_by: text("exported_by").notNull(),
  file_r2_key: text("file_r2_key").notNull(),
  record_count: integer("record_count").notNull(),
  created_at: integer("created_at").notNull().$defaultFn(() => Date.now()),
});

// Auto-categorization rules: vendor/memo keyword -> QuickBooks ledger account.
// Matched in priority order (lower `priority` wins). `match_on` is "vendor",
// "memo", or "both".
export const categoryRules = sqliteTable(
  "category_rules",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    match_on: text("match_on", { enum: ["vendor", "memo", "both"] }).notNull().default("vendor"),
    keyword: text("keyword").notNull(),
    account: text("account").notNull(),
    priority: integer("priority").notNull().default(100),
    active: integer("active").notNull().default(1),
    created_at: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [index("category_rules_priority_idx").on(t.priority, t.active)]
);

// Immutable audit trail for accountant actions + exports.
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    actor_id: text("actor_id"),
    action: text("action", { enum: auditActions }).notNull(),
    transaction_id: text("transaction_id"),
    batch_id: text("batch_id"),
    detail: text("detail"),
    created_at: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [
    index("audit_log_transaction_idx").on(t.transaction_id),
    index("audit_log_created_idx").on(t.created_at),
  ]
);

// Issued accountant magic links. The token itself is HMAC-signed and expires,
// but we keep a row here for single-use enforcement + audit.
export const magicLinks = sqliteTable(
  "magic_links",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    token_hash: text("token_hash").notNull(),
    role: text("role", { enum: userRoles }).notNull(),
    expires_at: integer("expires_at").notNull(),
    used_at: integer("used_at"),
    created_at: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (t) => [index("magic_links_token_idx").on(t.token_hash)]
);

export type SessionRow = typeof sessions.$inferSelect;
export type DocRow = typeof documents.$inferSelect;
export type TxRow = typeof transactions.$inferSelect;
export type CategoryRuleRow = typeof categoryRules.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;