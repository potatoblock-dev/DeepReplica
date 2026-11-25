const DB_NAME = "deepreplica";
const DB_VERSION = 2;

/** Opens the single IndexedDB database used for vault, settings, conversations, and usage. */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("vault")) {
        db.createObjectStore("vault");
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings");
      }
      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("usage")) {
        const usage = db.createObjectStore("usage", { keyPath: "id" });
        usage.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
  });
}

/** Runs a read-only or readwrite transaction and resolves with the request result. */
export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}
