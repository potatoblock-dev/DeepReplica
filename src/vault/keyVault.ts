import { idbRequest, openDb } from "../db/openDb";

const MASTER_KEY_ID = "masterKey";
const API_KEY_CIPHER_ID = "apiKeyCipher";

export type ApiKeyCipher = {
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

/** Loads or creates a non-extractable AES-GCM master key stored in IndexedDB. */
async function getOrCreateMasterKey(): Promise<CryptoKey> {
  const db = await openDb();
  const existing = await idbRequest(
    db.transaction("vault", "readonly").objectStore("vault").get(MASTER_KEY_ID),
  );
  if (existing instanceof CryptoKey) {
    return existing;
  }

  const masterKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await idbRequest(
    db.transaction("vault", "readwrite").objectStore("vault").put(masterKey, MASTER_KEY_ID),
  );
  return masterKey;
}

/** Encrypts the provider API key and stores only ciphertext in IndexedDB. */
export async function saveApiKey(plaintext: string): Promise<void> {
  const trimmed = plaintext.trim();
  if (!trimmed) {
    throw new Error("API key is empty");
  }
  const masterKey = await getOrCreateMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(trimmed);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, masterKey, encoded);
  const record: ApiKeyCipher = {
    iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
    ciphertext,
  };
  const db = await openDb();
  await idbRequest(
    db.transaction("vault", "readwrite").objectStore("vault").put(record, API_KEY_CIPHER_ID),
  );
}

/** Decrypts the stored API key into memory for the current request; never writes plaintext back. */
export async function loadApiKey(): Promise<string | null> {
  const db = await openDb();
  const record = (await idbRequest(
    db.transaction("vault", "readonly").objectStore("vault").get(API_KEY_CIPHER_ID),
  )) as ApiKeyCipher | undefined;
  if (!record?.iv || !record.ciphertext) {
    return null;
  }
  const masterKey = await getOrCreateMasterKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(record.iv) },
    masterKey,
    record.ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

/** Reports whether an encrypted API key blob is present (does not decrypt). */
export async function hasApiKey(): Promise<boolean> {
  const db = await openDb();
  const record = await idbRequest(
    db.transaction("vault", "readonly").objectStore("vault").get(API_KEY_CIPHER_ID),
  );
  return Boolean(record);
}

/** Removes the encrypted API key; leaves the master key so a new key can be sealed later. */
export async function clearApiKey(): Promise<void> {
  const db = await openDb();
  await idbRequest(
    db.transaction("vault", "readwrite").objectStore("vault").delete(API_KEY_CIPHER_ID),
  );
}
