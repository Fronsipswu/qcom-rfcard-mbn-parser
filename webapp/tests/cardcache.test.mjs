// Unit tests for the IndexedDB card-table cache: key building (sha256-keyed per
// plan Task 11 Step 5) and the backend-abstracted cache wrapper. The IDB
// backend itself is DOM-only; the pure part runs against a memory backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, createCardCache, memoryBackend } from "../js/cardcache.js";

const RECORD = {
  name: "1426_0_0_0170.mbn",
  inner_path: "/so/rfcards/1426_0_0_0170.mbn",
  generation: "DAT/protobuf",
  sha256: "abc123",
  lte_combos: 1515,
  nr_combos: "5+2855+0=2855",
};

test("cacheKey is keyed by sha256", () => {
  assert.equal(cacheKey(RECORD), "tables:sha256:abc123");
  assert.equal(cacheKey({ ...RECORD, sha256: "" }), "tables:name:1426_0_0_0170.mbn");
  assert.equal(cacheKey({ ...RECORD, sha256: null }), "tables:name:1426_0_0_0170.mbn");
  assert.equal(cacheKey({}), "tables:name:unknown");
  assert.equal(cacheKey(null), "tables:name:unknown");
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
