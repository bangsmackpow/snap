import type { TxRow } from "../db/schema";

// Farm ledger CSV with Schedule F expense categories for direct import into a
// spreadsheet or QuickBooks Chart of Accounts.

export const SCHEDULE_F_CATEGORIES = [
  "Chemicals",
  "Feed",
  "Fertilizer",
  "Fuel",
  "Machine Hire",
  "Repairs & Maintenance",
  "Supplies",
] as const;
export type ScheduleFCategory = (typeof SCHEDULE_F_CATEGORIES)[number];

// Case-insensitive keyword -> Schedule F category heuristic. Order matters:
// more specific phrases are matched first so e.g. "diesel fuel" -> Fuel and
// "repairs to tractor" -> Repairs & Maintenance.
const CATEGORY_RULES: { category: ScheduleFCategory; keywords: string[] }[] = [
  { category: "Chemicals", keywords: ["chemical", "herbicide", "pesticide", "fungicide", "insecticide", "defoliant"] },
  { category: "Feed", keywords: ["feed", "grain", "hay", "corn", "soybean meal", "mineral", "supplement", "silage", "alfalfa"] },
  { category: "Fertilizer", keywords: ["fertilizer", "fertiliser", "urea", "anhydrous", "nitrogen", "lime", "manure"] },
  { category: "Fuel", keywords: ["fuel", "diesel", "gasoline", "gas", "propane", "petroleum"] },
  { category: "Machine Hire", keywords: ["machine hire", "custom work", "custom hire", "custom applicator", "spraying service", "trucking"] },
  { category: "Repairs & Maintenance", keywords: ["repair", "maintenance", "parts", "tire", "tyre", "lubricant", "oil filter", "mechanic"] },
  { category: "Supplies", keywords: ["supply", "supplies", "seed", "twine", "fencing", "hardware", "gloves", "tools"] },
];

export function inferCategory(payee: string, memo: string): ScheduleFCategory {
  const haystack = `${payee} ${memo}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) return rule.category;
  }
  return "Supplies";
}

export type CsvExportRow = {
  date: string;
  checkNumber: string;
  payee: string;
  memo: string;
  category: string;
  amount: string;
  invoiceRef: string;
  status: string;
};

export function toCsvRow(
  tx: TxRow,
  opts: { category?: string; invoiceRef?: string } = {}
): CsvExportRow {
  const d = tx.transaction_date ? new Date(tx.transaction_date) : null;
  const date = d ? d.toISOString().slice(0, 10) : "";
  const amount = tx.amount != null ? (tx.amount / 100).toFixed(2) : "";
  const category = opts.category || inferCategory(tx.vendor_payee ?? "", tx.memo ?? "");
  return {
    date,
    checkNumber: tx.check_number ?? "",
    payee: tx.vendor_payee ?? "",
    memo: tx.memo ?? "",
    category,
    amount,
    invoiceRef: opts.invoiceRef ?? "",
    status: tx.status ?? "unpaired",
  };
}

function csvField(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

const CSV_HEADER = [
  "Date",
  "Check #",
  "Payee",
  "Memo",
  "Category",
  "Amount",
  "Invoice Ref",
  "Verification Status",
];

export function buildCSV(rows: CsvExportRow[]): string {
  const lines = [CSV_HEADER.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [r.date, r.checkNumber, r.payee, r.memo, r.category, r.amount, r.invoiceRef, r.status]
        .map(csvField)
        .join(",")
    );
  }
  return lines.join("\n");
}