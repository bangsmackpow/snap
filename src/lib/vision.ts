import type { Env } from "../env";
import type { DocType } from "../db/schema";
import { extractionSchema, type Extraction } from "./validation";
import { toBase64 } from "./encoding";

const EXTRACT_PROMPT = `You are a bank-document extraction engine for a farm bookkeeping ledger.
Look at the attached image and decide what it is.
If it is a bank check, respond ONLY with JSON matching this shape:
{"doc_type":"check","check_number":"...","date":"YYYY-MM-DD","payee":"...","amount_numeric":123.45,"memo_line":"...","routing_last4":"...","account_last4":"..."}
If it is an invoice, respond ONLY with JSON matching this shape:
{"doc_type":"invoice","vendor_name":"...","invoice_number":"...","invoice_date":"YYYY-MM-DD","total_due":123.45,"line_items_summary":"one short line"}
If it is neither a check nor an invoice, respond ONLY with:
{"doc_type":"unknown","error":"short reason"}
Rules:
- amount_numeric and total_due are plain numbers in USD dollars (no currency symbol, no commas).
- If a field is not visible in the image, use "" for text fields and null for numeric/date fields.
- Never invent values. Return ONLY valid JSON with no markdown fences.`;

export type ExtractionResult =
  | { ok: true; data: Extraction }
  | { ok: false; error: string };

export async function runExtraction(
  env: Env,
  opts: { imageBytes: Uint8Array; mimeType: string; hint?: "check" | "invoice" }
): Promise<ExtractionResult> {
  const key = env.VISION_API_KEY;
  if (!key) return { ok: false, error: "vision_api_key_missing" };

  const model = env.VISION_MODEL ?? "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const prompt = opts.hint
    ? `${EXTRACT_PROMPT}\nThe user believes this image is a ${opts.hint === "check" ? "bank check" : "invoice"}. Extract that type if it matches; otherwise classify the image honestly.`
    : EXTRACT_PROMPT;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: opts.mimeType || "image/jpeg",
              data: toBase64(opts.imageBytes),
            },
          },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "vision_network_error" };
  }

  if (!res.ok) {
    return { ok: false, error: `vision_http_${res.status}` };
  }

  const data = (await res.json()) as GeminiResponse;
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";

  const jsonText = stripFences(text).trim();
  if (!jsonText) return { ok: false, error: "vision_empty_response" };

  try {
    const parsed = extractionSchema.parse(JSON.parse(jsonText));
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, error: "vision_bad_json" };
  }
}

export function isUsableDocType(docType: DocType): docType is "check" | "invoice" {
  return docType === "check" || docType === "invoice";
}

type GeminiResponse = {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
};

function stripFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
}