const ENVELOPE_VERSION = 1;
const KEY_IV_LEN = 12;
const DATA_KEY_LEN = 32;
const GCM_TAG_LEN = 16;

// Envelope layout (all offsets in bytes):
//   [0]            version (1)
//   [1..13)        keyIv (12)          - IV wrapping the data key
//   [13..45)       wrapped data key (32) - AES-GCM ciphertext of the data key
//   [45..61)       wrap tag (16)
//   [61..73)       docIv (12)          - IV used on the document
//   [73..end)      document ciphertext + GCM tag (16)
//
// Each document gets a fresh random 256-bit data key. That key is sealed
// under the master key derived from DATA_KEY_SECRET. Stored in R2, so an R2
// leak alone cannot decrypt the checks/invoices.
export async function encryptDocument(
  secret: string,
  plaintext: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  const master = await deriveMasterKey(secret);
  const dataKeyRaw = crypto.getRandomValues(new Uint8Array(DATA_KEY_LEN));
  const dataKey = await importKey(dataKeyRaw);
  const keyIv = crypto.getRandomValues(new Uint8Array(KEY_IV_LEN));
  const docIv = crypto.getRandomValues(new Uint8Array(KEY_IV_LEN));

  const sealedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: keyIv }, master, dataKeyRaw));
  const sealedDoc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: docIv }, dataKey, plaintext));

  const out = new Uint8Array(1 + KEY_IV_LEN + sealedKey.length + KEY_IV_LEN + sealedDoc.length);
  let off = 0;
  out[off++] = ENVELOPE_VERSION;
  out.set(keyIv, off); off += KEY_IV_LEN;
  out.set(sealedKey, off); off += sealedKey.length;
  out.set(docIv, off); off += KEY_IV_LEN;
  out.set(sealedDoc, off);
  return out;
}

export async function decryptDocument(
  secret: string,
  envelope: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  const data = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  if (data.length < 1 + KEY_IV_LEN + DATA_KEY_LEN + GCM_TAG_LEN + KEY_IV_LEN + GCM_TAG_LEN) {
    throw new Error("corrupt envelope: too short");
  }
  if (data[0] !== ENVELOPE_VERSION) throw new Error("corrupt envelope: bad version");

  let off = 1;
  const keyIv = data.slice(off, off + KEY_IV_LEN); off += KEY_IV_LEN;
  const sealedKey = data.slice(off, off + DATA_KEY_LEN + GCM_TAG_LEN); off += DATA_KEY_LEN + GCM_TAG_LEN;
  const docIv = data.slice(off, off + KEY_IV_LEN); off += KEY_IV_LEN;
  const sealedDoc = data.slice(off);

  const master = await deriveMasterKey(secret);
  const dataKeyRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: keyIv }, master, sealedKey));
  const dataKey = await importKey(dataKeyRaw);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: docIv }, dataKey, sealedDoc));
}

async function deriveMasterKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return importKey(new Uint8Array(digest));
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}