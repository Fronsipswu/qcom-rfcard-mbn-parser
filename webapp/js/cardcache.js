// IndexedDB cache of parsed card tables, keyed by record sha256 (Task 11
// Step 5). The DB sits behind a two-method backend ({ get(key), put(key, value) })
// so the keying + wrapper logic is testable without IndexedDB; idbBackend()
// provides the real backend and memoryBackend() a per-page fallback.
export function cacheKey(record) {
  const sha = record && record.sha256 ? record.sha256 : "";
  if (sha) return `tables:sha256:${sha}`;
  const name = record && record.name ? record.name : "unknown";
  return `tables:name:${name}`;
}

// The exact shape generateWebTables produces: all four table keys, each an
// array of row objects (an explicit empty record is valid). Anything else is
// cache corruption (a poisoned or stale-writer entry) and must never reach the
// viewer, which would render "Empty"/"0 combos" forever.
const TABLE_KEYS = ["lte_ca", "nr_ca", "endc", "nrdc"];

export function isValidTablesShape(tables) {
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) return false;
  for (const key of TABLE_KEYS) {
    const rows = tables[key];
    if (!Array.isArray(rows)) return false;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    }
  }
  return true;
}

export function createCardCache(backend) {
  const drop = async (key) => {
    try {
      await backend.delete(key);
    } catch {
      // a backend without delete (or a failing one) still counts as a miss
    }
  };
  return {
    async get(record) {
      try {
        const value = await backend.get(cacheKey(record));
        if (value === null || value === undefined) return null;
        if (
          !value || typeof value !== "object" || !isValidTablesShape(value.tables)
        ) {
          await drop(cacheKey(record)); // malformed entry -> miss + delete
          return null;
        }
        return value;
      } catch {
        return null; // a broken cache must never break card rendering
      }
    },
    async put(record, tables) {
      if (!isValidTablesShape(tables)) return; // never poison the cache
      try {
        await backend.put(cacheKey(record), { tables, recordName: record && record.name ? record.name : "", cachedAt: Date.now() });
      } catch {
        // quota/errors are non-fatal
      }
    },
    // Full wipe for the Clear button: every cached parse is dropped so the
    // next open re-parses from the File. Backend failures are non-fatal, and
    // a backend without clear() (older fake/custom backends) is a no-op.
    async clearAll() {
      try {
        await backend.clear();
      } catch {
        // a broken cache must never break clearing the UI
      }
    },
  };
}

export function memoryBackend() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async clear() {
      map.clear();
    },
  };
}

export function idbBackend({ database = "rfcard-webapp", store = "tables" } = {}) {
  let dbPromise = null;
  const open = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(database, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  };
  return {
    async get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    },
    async put(key, value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    async delete(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    async clear() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}
