import { z } from "zod";

export const checkExtractionSchema = z.object({
  doc_type: z.literal("check"),
  check_number: z.string().default(""),
  date: z.string().nullable().default(null),
  payee: z.string().default(""),
  amount_numeric: z.number().nullable().default(null),
  memo_line: z.string().default(""),
  routing_last4: z.string().default(""),
  account_last4: z.string().default(""),
});
export type CheckExtraction = z.infer<typeof checkExtractionSchema>;

export const invoiceExtractionSchema = z.object({
  doc_type: z.literal("invoice"),
  vendor_name: z.string().default(""),
  invoice_number: z.string().default(""),
  invoice_date: z.string().nullable().default(null),
  total_due: z.number().nullable().default(null),
  line_items_summary: z.string().default(""),
});
export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;

export const unknownExtractionSchema = z.object({
  doc_type: z.literal("unknown"),
  error: z.string().default(""),
});
export type UnknownExtraction = z.infer<typeof unknownExtractionSchema>;

export const extractionSchema = z.discriminatedUnion("doc_type", [
  checkExtractionSchema,
  invoiceExtractionSchema,
  unknownExtractionSchema,
]);
export type Extraction = z.infer<typeof extractionSchema>;

export const pairRequestSchema = z.object({
  check_doc_id: z.string().min(1),
  invoice_doc_id: z.string().min(1),
});

export const enrollRequestSchema = z.object({
  enroll_key: z.string().optional(),
});

export const uploadHintSchema = z.enum(["check", "invoice"]).optional();