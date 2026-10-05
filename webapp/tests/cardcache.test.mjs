// Unit tests for the IndexedDB card-table cache: key building (sha256-keyed per
// plan Task 11 Step 5) and the backend-abstracted cache wrapper. The IDB
// backend itself is DOM-only; the pure part runs against a memory backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_SCHEMA_VERSION, cacheKey, createCardCache, memoryBackend, metaKey } from "../js/cardcache.js";

const RECORD = {
  name: "1426_0_0_0170.mbn",
  inner_path: "/so/rfcards/1426_0_0_0170.mbn",
  generation: "DAT/protobuf",
  sha256: "abc123",
  lte_combos: 1515,
  nr_combos: "5+2855+0=2855",
};

test("cacheKey embeds the schema version and is keyed by sha256", () => {
  assert.equal(cacheKey(RECORD), `tables:v${CACHE_SCHEMA_VERSION}:sha256:abc123`);
  assert.equal(cacheKey({ ...RECORD, sha256: "" }), `tables:v${CACHE_SCHEMA_VERSION}:name:1426_0_0_0170.mbn`);
  assert.equal(cacheKey({ ...RECORD, sha256: null }), `tables:v${CACHE_SCHEMA_VERSION}:name:1426_0_0_0170.mbn`);
  assert.equal(cacheKey({}), `tables:v${CACHE_SCHEMA_VERSION}:name:unknown`);
  assert.equal(cacheKey(null), `tables:v${CACHE_SCHEMA_VERSION}:name:unknown`);
  assert.ok(cacheKey(RECORD).startsWith(`tables:v${CACHE_SCHEMA_VERSION}:`), "the key is version-prefixed");
});

test("createCardCache: get/put round-trip through the injected backend", async () => {
  const cache = createCardCache(memoryBackend());
  assert.equal(await cache.get(RECORD), null); // miss
  const tables = { lte_ca: [{ "LTE DL": "1A" }], nr_ca: [], endc: [], nrdc: [] };
  await cache.put(RECORD, tables);
  const hit = await cache.get(RECORD);
  assert.deepEqual(hit.tables, tables); // hit returns the stored tables
  assert.equal(hit.recordName, RECORD.name);
  // Same sha256, different name/counts: still a hit (content-addressed).
  const twin = { ...RECORD, name: "other.mbn", lte_combos: 0 };
  assert.equal(await cache.get(twin).then((v) => v.tables.lte_ca.length), 1);
});

test("createCardCache: backend failures never break callers", async () => {
  const failing = {
    async get() { throw new Error("idb broken"); },
    async put() { throw new Error("idb broken"); },
  };
  const cache = createCardCache(failing);
  assert.equal(await cache.get(RECORD), null); // get failure -> null miss
  await cache.put(RECORD, {}); // put failure swallowed
});

test("memoryBackend stores and returns values without leaking references", async () => {
  const backend = memoryBackend();
  const value = { a: 1 };
  await backend.put("k", value);
  const out = await backend.get("k");
  assert.deepEqual(out, value);
  assert.equal(await backend.get("missing"), null);
});

// --- shape validation (Rec-1: corrupt cache entry -> empty viewer forever) -------

const TABLES = {
  lte_ca: [{ "LTE DL": "1A + 3A", "LTE MIMO DL": "2 + 2" }],
  nr_ca: [],
  endc: [{ "LTE DL": "1A", "NR DL": "n78" }],
  nrdc: [],
};

test("isValidTablesShape accepts exactly the shape generateWebTables produces", async () => {
  const cardcache = await import("../js/cardcache.js");
  const { isValidTablesShape } = cardcache;
  assert.equal(typeof isValidTablesShape, "function");
  // All four table keys, each an array of row objects (possibly empty).
  assert.equal(isValidTablesShape(TABLES), true);
  assert.equal(isValidTablesShape({ lte_ca: [], nr_ca: [], endc: [], nrdc: [] }), true); // explicit empty record
  // Rows must be objects, not scalars/arrays.
  assert.equal(
    isValidTablesShape({ lte_ca: ["garbage"], nr_ca: [], endc: [], nrdc: [] }),
    false,
  );
});

test("isValidTablesShape rejects malformed cached values", async () => {
  const cardcache = await import("../js/cardcache.js");
  const { isValidTablesShape } = cardcache;
  for (const bad of [
    null,
    undefined,
    "cached-string",
    42,
    [],
    { lte_ca: null, nr_ca: [], endc: [], nrdc: [] }, // missing table as null
    { lte_ca: [], nr_ca: [], endc: [] }, // a table key dropped entirely
    { lte_ca: {}, nr_ca: [], endc: [], nrdc: [] }, // table not an array
    { lte_ca: [null], nr_ca: [], endc: [], nrdc: [] }, // row not an object
    { lte_ca: [[]], nr_ca: [], endc: [], nrdc: [] }, // row an array, not a record
  ]) {
    assert.equal(isValidTablesShape(bad), false, JSON.stringify(bad));
  }
});

test("corrupt cache entries are treated as a miss AND deleted so the worker re-parses", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend);
  const key = cacheKey(RECORD);
  await backend.put(key, "cached-garbage-string"); // simulates a corrupt/poisoned entry
  assert.equal(await cache.get(RECORD), null, "malformed entry must not be returned as a hit");
  assert.equal(await backend.get(key), null, "the bad entry must be deleted from the backend");
  // The following put (worker re-parse) then round-trips normally.
  await cache.put(RECORD, TABLES);
  const hit = await cache.get(RECORD);
  assert.deepEqual(hit.tables, TABLES);
});

test("corrupt entries with wrong row shapes are also dropped", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend);
  const key = cacheKey(RECORD);
  await backend.put(key, {
    tables: { lte_ca: ["not-a-row"], nr_ca: [], endc: [], nrdc: [] },
    recordName: RECORD.name,
    cachedAt: 1,
  });
  assert.equal(await cache.get(RECORD), null);
  assert.equal(await backend.get(key), null);
});

test("put refuses to store malformed tables (no poisoning through the writer)", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend);
  await cache.put(RECORD, "garbage");
  assert.equal(await backend.get(cacheKey(RECORD)), null);
});

test("a backend without delete support still misses cleanly on corrupt entries", async () => {
  const cache = createCardCache({
    async get() { return "garbage"; },
    async put() {},
  });
  assert.equal(await cache.get(RECORD), null);
});

// --- clearAll (Clear button wipes the whole parse cache) --------------------------

test("clearAll empties the cache so every get misses again", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend);
  const other = { ...RECORD, name: "other.mbn", sha256: "def456" };
  await cache.put(RECORD, TABLES);
  await cache.put(other, TABLES);
  assert.notEqual(await cache.get(RECORD), null); // pre-check: actually cached
  await cache.clearAll();
  assert.equal(await cache.get(RECORD), null);
  assert.equal(await cache.get(other), null);
  assert.equal(await backend.get(cacheKey(RECORD)), null);
  assert.equal(await backend.get(cacheKey(other)), null);
  // The emptied cache is writable again (Clear then re-import must work).
  await cache.put(RECORD, TABLES);
  const hit = await cache.get(RECORD);
  assert.deepEqual(hit.tables, TABLES);
});

test("clearAll tolerates a backend without clear support (fake {get, put} pattern)", async () => {
  const cache = createCardCache({
    async get() { return null; },
    async put() {},
  });
  await cache.clearAll(); // must not throw
});

test("clearAll swallows a failing backend like get/put do", async () => {
  const cache = createCardCache({
    async get() { throw new Error("idb broken"); },
    async put() { throw new Error("idb broken"); },
    async clear() { throw new Error("idb broken"); },
  });
  await cache.clearAll(); // must not throw
});

// --- eviction (Step 5: bound the persistent cache) --------------------------------

const tableWithRows = (rows) => ({
  lte_ca: Array.from({ length: rows }, (_, i) => ({ "LTE DL": `B${i}` })),
  nr_ca: [],
  endc: [],
  nrdc: [],
});

test("put stores cachedAt and an approximate row count", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend);
  await cache.put(RECORD, tableWithRows(7));
  const stored = await backend.get(cacheKey(RECORD));
  assert.equal(stored.rowCount, 7);
  assert.equal(typeof stored.cachedAt, "number");
});

test("eviction drops the oldest entries beyond maxEntries", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend, { maxEntries: 3, maxRows: 1e9 });
  // Distinct cachedAt so the eviction order is deterministic.
  const origNow = Date.now;
  let clock = 1000;
  Date.now = () => (clock += 1);
  try {
    for (let i = 0; i < 5; i++) {
      await cache.put({ ...RECORD, name: `card${i}.mbn`, sha256: `sha${i}` }, tableWithRows(1));
    }
  } finally {
    Date.now = origNow;
  }
  const keys = (await backend.list("tables:")).map((e) => e.key).sort();
  assert.equal(keys.length, 3, "capped at maxEntries");
  assert.ok(!keys.includes(cacheKey({ ...RECORD, sha256: "sha0" })), "oldest evicted");
  assert.ok(!keys.includes(cacheKey({ ...RECORD, sha256: "sha1" })), "second oldest evicted");
  assert.ok(keys.includes(cacheKey({ ...RECORD, sha256: "sha4" })), "newest retained");
});

test("eviction also caps total rows", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend, { maxEntries: 100, maxRows: 10 });
  const origNow = Date.now;
  let clock = 2000;
  Date.now = () => (clock += 1);
  try {
    for (let i = 0; i < 4; i++) {
      await cache.put({ ...RECORD, name: `row${i}.mbn`, sha256: `rows${i}` }, tableWithRows(6));
    }
  } finally {
    Date.now = origNow;
  }
  const rows = (await backend.list("meta:")).reduce((n, e) => n + (e.value?.rowCount ?? 0), 0);
  assert.ok(rows <= 10, `row budget exceeded: ${rows}`);
});

test("a backend without list() simply never evicts", async () => {
  const cache = createCardCache({ async get() { return null; }, async put() {}, async delete() {}, async clear() {} });
  await cache.put(RECORD, tableWithRows(1)); // must not throw
});

test("put writes a small meta sibling; eviction lists only meta entries", async () => {
  const backend = memoryBackend();
  const prefixes = [];
  const spy = { ...backend, list: (prefix) => (prefixes.push(prefix), backend.list(prefix)) };
  const cache = createCardCache(spy, { maxEntries: 2, maxRows: 1e9 });
  await cache.put(RECORD, tableWithRows(3));
  const meta = await backend.get(metaKey(cacheKey(RECORD)));
  assert.deepEqual(Object.keys(meta).sort(), ["cachedAt", "rowCount"], "meta carries no tables");
  assert.equal(meta.rowCount, 3);
  assert.ok(prefixes.length > 0 && prefixes.every((p) => p.startsWith("meta:")), `eviction listed ${prefixes}`);
});

test("evicting an entry deletes both the tables and its meta sibling", async () => {
  const backend = memoryBackend();
  const cache = createCardCache(backend, { maxEntries: 1, maxRows: 1e9 });
  const origNow = Date.now;
  let clock = 3000;
  Date.now = () => (clock += 1);
  try {
    await cache.put({ ...RECORD, sha256: "old" }, tableWithRows(1));
    await cache.put({ ...RECORD, sha256: "new" }, tableWithRows(1));
  } finally {
    Date.now = origNow;
  }
  const oldKey = cacheKey({ ...RECORD, sha256: "old" });
  assert.equal(await backend.get(oldKey), null);
  assert.equal(await backend.get(metaKey(oldKey)), null);
  assert.equal((await backend.keys()).length, 2, "only the newest tables + meta remain");
});

test("the first eviction sweeps keys from older cache schemas", async () => {
  const backend = memoryBackend();
  await backend.put("tables:sha256:legacy", { tables: tableWithRows(1) }); // pre-version key
  await backend.put("tables:v1:sha256:orphan", { tables: tableWithRows(1) }); // v1: no meta sibling
  const cache = createCardCache(backend);
  await cache.put(RECORD, tableWithRows(1));
  const keys = (await backend.keys()).sort();
  assert.deepEqual(keys, [cacheKey(RECORD), metaKey(cacheKey(RECORD))].sort());
});
