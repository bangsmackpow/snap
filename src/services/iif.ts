import type { TxRow } from "../db/schema";

// QuickBooks IIF (Intuit Interchange Format) generator.
//
// IIF is a tab-delimited text format. Every column block starts with a header
// line whose first cell is prefixed with "!" (e.g. "!TRNS"), followed by one
// data row per record with the same number of tab-separated columns.
//
// For an expense paid by check we emit a CHECK transaction. Vendors we owe
// money to (invoice captured but no check yet) are emitted as BILL; and once
// paid they become BILLPAY. All split lines write to the Schedule F expense
// account, and the TRNS total must match the sum of its SPL lines.

export type IifTxnType = "CHECK" | "BILL" | "BILLPAY";

export const SCHEDULE_F_ACCOUNT = "Schedule F:Expense";
export const BANK_ACCOUNT = "Checking";

const IIF_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// QuickBooks wants dates as MM/DD/YYYY (or a valid date string it parses).
export function toIIFDate(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export function parseISOToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(IIF_DATE_RE);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return null;
}

function tab(parts: (string | number | null | undefined)[]): string {
  return parts.map((p) => (p == null ? "" : String(p))).join("\t");
}

export type IifExportRow = {
  txnType: IifTxnType;
  dateMs: number | null;
  checkNumber: string;
  payee: string;
  amountCents: number;
  memo: string;
  category: string;
  invoiceRef: string;
};

// Map a stored transaction to an IIF row. The caller supplies the resolved
// check/invoice extractions so category + invoice ref can be denormalized.
export function txToIifRow(
  tx: TxRow,
  opts: { invoiceRef?: string; category?: string } = {}
): IifExportRow {
  const paired = !!tx.check_doc_id && !!tx.invoice_doc_id;
  const txnType: IifTxnType = !tx.check_doc_id ? "BILL" : paired ? "BILLPAY" : "CHECK";

  const amountCents = tx.amount ?? 0;
  return {
    txnType,
    dateMs: tx.transaction_date ?? null,
    checkNumber: tx.check_number ?? "",
    payee: tx.vendor_payee ?? "",
    amountCents,
    memo: tx.memo ?? "",
    category: opts.category || tx.category_code || SCHEDULE_F_ACCOUNT,
    invoiceRef: opts.invoiceRef ?? "",
  };
}

// Generate the full IIF document (tab-delimited) for a set of rows.
export function buildIIF(rows: IifExportRow[]): string {
  const lines: string[] = [];
  lines.push("!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO\tCLEAR\tTOPRINT\tNAMEISTAXABLE");
  lines.push("!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO\tCLEAR\tCLASS\tPAID\tTAXABLE");
  lines.push("!ENDTRNS");

  for (const row of rows) {
    const amt = Math.abs(row.amountCents) / 100;

    if (row.txnType === "BILL") {
      // Bill payable to vendor: liability account increases, expense split.
      lines.push(
        tab([
          "TRNS",
          row.checkNumber,
          "BILL",
          toIIFDate(row.dateMs),
          "Accounts Payable",
          row.payee,
          amt.toFixed(2),
          row.memo,
          "N",
          "N",
          "N",
        ])
      );
      lines.push(
        tab([
          "SPL",
          "",
          "BILL",
          toIIFDate(row.dateMs),
          row.category,
          row.payee,
          amt.toFixed(2),
          row.memo,
          "N",
          "",
          "N",
          "N",
        ])
      );
      lines.push("ENDTRNS");
      continue;
    }

    if (row.txnType === "BILLPAY") {
      // Paying an outstanding bill out of the bank account.
      lines.push(
        tab([
          "TRNS",
          row.checkNumber,
          "BILLPAY",
          toIIFDate(row.dateMs),
          BANK_ACCOUNT,
          row.payee,
          `-${amt.toFixed(2)}`,
          row.memo,
          "N",
          "N",
          "N",
        ])
      );
      lines.push(
        tab([
          "SPL",
          "",
          "BILLPAY",
          toIIFDate(row.dateMs),
          "Accounts Payable",
          row.payee,
          amt.toFixed(2),
          row.memo,
          "N",
          "",
          "N",
          "N",
        ])
      );
      lines.push("ENDTRNS");
      continue;
    }

    // CHECK
    lines.push(
      tab([
        "TRNS",
        row.checkNumber,
        "CHECK",
        toIIFDate(row.dateMs),
        BANK_ACCOUNT,
        row.payee,
        `-${amt.toFixed(2)}`,
        row.memo,
        "N",
        "N",
        "N",
      ])
    );
    lines.push(
      tab([
        "SPL",
        "",
        "CHECK",
        toIIFDate(row.dateMs),
        row.category,
        row.payee,
        amt.toFixed(2),
        row.memo,
        "N",
        "",
        "N",
        "N",
      ])
    );
    lines.push("ENDTRNS");
  }

  return lines.join("\n");
}