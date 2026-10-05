// Parse worker (Task 11 Step 1). Message protocol, exactly per the plan:
//
// main -> worker
//   { type: "scan",      id, files: [{ sourceId, file }, ...] }  File handles
//                                                   pass through structured
//                                                   clone ONCE and are held in
//                                                   the worker's `sources` map;
//                                                   sourceId is a stable,
//                                                   never-reused id assigned by
//                                                   main.js per imported File
//   { type: "parseCard", id, sourceId, fileIndex?, record, fast? }  sourceId
//                                                   resolves bytes; fileIndex is
//                                                   bookkeeping only; fast routes
//                                                   to the parse lane (not queued
//                                                   behind a running scan)
//   { type: "export",    id, sourceId, fileIndex?, record, format }  mbn|json|csv|
//                                                   webcsv|b0cd|b826
//   { type: "importCards", id, sourceId, fileIndex?, record } -> both DIAG texts
//   { type: "release" }  drop every registered source + memo (Clear button)
//   { type: "cancel",    id }
// worker -> main
//   { type: "progress",  phase, source, done, total, currentFile, detail? }
//                                                   detail: unit-level scan
//                                                   progress ("banks a/b",
//                                                   "counting a/b",
//                                                   "extracting") on scan
//                                                   progress posts only
//   { type: "records",   fileIndex, records, warnings? }  plain JSON-able
//                                                         ModuleRecord list
//   { type: "tables",    id, fileIndex, recordName, tables }
//   { type: "exportBlob", id, files: [{ filename, bytes } | { filename, text }, ...] }
//   { type: "error",     id?, message, source? }
//   { type: "debug",     enabled, reset? } -> { type: "debug", enabled, debugCounters }
//                                                   (Step 0 instrumentation)
//
// Debug counters: when enabled (main.js posts {type:"debug",enabled:true} from
// `?debug`, or a test calls setDebugCounters(true)), every reply additionally
// carries `debugCounters` — extraction/parse/table/walk/post counters used by
// the performance work. Disabled by default; reply shapes are otherwise
// unchanged, so the UI ignores the extra field.
//
// Additive protocol details (documented deviations, needed by the UI layer):
// - "records" carries an optional `warnings` array ({tool, message}) so the
//   detect-and-warn panel can list them next to the records they belong to.
// - Apple ftab scans post "records" INCREMENTALLY: the ftab's banks are fanned
//   out to a pool of scan-worker.js units (see "apple scan pool" below), and
//   every contiguous in-order group of completed banks is posted as a partial
//   "records" reply (progressive card list). The final full "records" reply is
//   still sent (main.js dedupes by card key, so partials are idempotent);
//   warnings are split so they are never delivered twice.
// - parseCard/export/importCards reference the card by its stable `sourceId`,
//   never by a session fileIndex. main.js registers each File once at scan time
//   and the worker keeps it in `sources`; a fileIndex alone can point at the
//   wrong file (cards accumulate across imports and session state resets on
//   every scan). Replies carry the request `id`; the main thread correlates on
//   it. `fileIndex` stays on the messages for bookkeeping only.
// - errors for an id-bearing op echo that `id` so pending replies can be
//   released; `source` names the record or file instead of being undefined.
//
// Per-card parseCard re-slices only the MBN buffer: re-read via the
// BrowserFileSource registered for the sourceId, direct MBNs read the whole
// file, FAT16 records use an exact-path Fat16Image.findFile lookup, container
// records re-extract and match by normalized inner_path (scratch-dir tags
// differ between runs). Blobs + parsed modules are memoized per sourceId, then
// by (record name, sha256): a different import's File gets a different
// sourceId, so a stale fileIndex or colliding card name can never hit another
// card's memo entry, and equal (name, sha256) pairs are content-identical by
// construction. Cancellation: a cancelled flag checked between files and, via
// the scanSource shouldCancel hook, inside the FAT walk loop; {type:"cancel"}
// also resets scan state.
import { BrowserFileSource } from "./lib/source.js";
import { Fat16Image } from "./lib/fat16.js";
import {
  scanSource,
  parseModule,
  generateWebTables,
  exportModule,
  normalizeInnerPath,
  matchesCandidate,
  ScanCancelled,
  ToolError,
  toCsvText,
} from "./lib/analyzer.js";
import { extractContainer, discoverCandidates } from "./lib/extractor.js";
import { extractFtabMember } from "./lib/apple_ftab.js";
import { lzfseDecode } from "./lib/lzfse.js";
import {
  parseAppleBank,
  requireValidBank,
  generateAppleTables,
  exportAppleDiag,
} from "./lib/apple_cr.js";
import {
  bump,
  snapshotDebugCounters,
  resetDebugCounters,
  debugCounters,
} from "./lib/debug.js";

// Debug counters (Step 0 instrumentation): attached to every reply only when
// enabled. Off by default so replies and timings are unchanged; toggle from the
// page with `?debug` (main.js posts {type:"debug"}) or from a Node protocol test
// via setDebugCounters(). Re-exported here so the test can import them.
export { debugCounters };
export let DEBUG_COUNTERS = false;
export const setDebugCounters = (enabled) => {
  DEBUG_COUNTERS = !!enabled;
};
export const getDebugCounters = () => snapshotDebugCounters();
export { resetDebugCounters };

const cancelled = new Set();
let session = null; // { scanId }
let chain = Promise.resolve(); // serialize scan/parseCard/export handling
let parseChain = Promise.resolve(); // fast lane for mobile parseCard (see onmessage)
let currentOp = null;

// Stable source registry (Step 2). A File posted to a worker is structured-
// cloned into a NEW wrapper on every message, so a WeakMap keyed by the File
// object never hits across requests (measured: the same Blob sent twice is not
// `===`). main.js therefore assigns a monotonically increasing `sourceId` per
// imported File (never reused — cards accumulate across imports) and sends the
// File exactly once in the scan registration; every parseCard/export/
// importCards afterwards carries only the id. `sources` holds the registered
// BrowserFileSource until Clear posts {type:"release"}.
const sources = new Map(); // sourceId -> { file, source: BrowserFileSource }
// Every memo below is keyed by sourceId (content-addressed by name/sha256 within
// a source). Cards from different imports never collide; within one source the
// (name, sha256) pair is content-identical by construction.
const parseMemo = new Map(); // sourceId -> Map<`${name}\u0000${sha256}`, {blob, parsed}>
const fatMemo = new Map(); // sourceId -> Fat16Image | null (null = init failed: not FAT16)
// sourceId -> Promise<Map<`${name}\u0000${inner_path}`, Uint8Array>>: extraction
// may release VFiles it returns (VFile.release drops consumed members), so the
// memo harvests the extracted mbn bytes once and lets the virtual tree go.
const containerMemo = new Map();
// Apple card-open memo (mirrors parseMemo): sourceId -> Map<`${name}\u0000${sha256}`,
// {bank, parsed}> where bank is the DECOMPRESSED CR bank. Zip/bbfw inputs also
// memoize the inflated ftab member they were sliced from.
const appleBankMemo = new Map(); // sourceId -> Map<key, {bank, parsed}>
const appleMemberMemo = new Map(); // sourceId -> Map<memberName, Promise<Uint8Array>>

// --- apple scan pool --------------------------------------------------------------
//
// A ftab carries ~58 independent CR banks; per bank, 99% of the scan work is
// the LZFSE decode (measured: ~115 ms/bank desktop, ~6.8 s serial for all 58).
// The scan coordinator therefore fans banks out to a lazily created pool of
// scan-worker.js units (one decode each, compressed stream transferred
// zero-copy) while it keeps sha256/record assembly in-process. Results are
// folded back in descriptor order by scanAppleFtab, so record order, warnings
// and the golden byte-parity of the sequential path are unchanged. Units stay
// alive between scans (idle cost is negligible); a reset settles queued tasks
// so a cancelled scan cannot strand the coordinator's await.

const SCAN_POOL_SIZE = Math.min(Math.max((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2, 1), 6);
let scanPool = null; // [{ worker, onDone }] — onDone non-null = slot busy
const scanPoolQueue = []; // pending { stream, uncompSize, settle }
let scanPoolTaskId = 0;

function scanPoolFor() {
  if (scanPool) return scanPool;
  scanPool = [];
  for (let i = 0; i < SCAN_POOL_SIZE; i++) {
    const worker = new Worker(new URL("./scan-worker.js", import.meta.url), { type: "module" });
    const slot = { worker, onDone: null };
    worker.onmessage = (event) => {
      const msg = event.data;
      if (!slot.onDone) return; // stale reply (should not happen) — ignore
      const done = slot.onDone;
      slot.onDone = null;
      done(msg);
      dispatchScanPool();
    };
    worker.onerror = (event) => {
      if (!slot.onDone) return; // idle worker failed to load; next dispatch retries
      const done = slot.onDone;
      slot.onDone = null;
      done({ ok: false, message: event.message || "scan unit failed" });
      dispatchScanPool();
    };
    scanPool.push(slot);
  }
  return scanPool;
}

function dispatchScanPool() {
  for (const slot of scanPool) {
    if (slot.onDone) continue;
    const task = scanPoolQueue.shift();
    if (!task) return;
    slot.onDone = (msg) => task.settle(msg);
    // Transfer the stream's ArrayBuffer (zero-copy); the coordinator already
    // took the digest and never reuses the stream after the hook returns.
    slot.worker.postMessage(
      { type: "appleBank", id: ++scanPoolTaskId, stream: task.stream, uncompSize: task.uncompSize },
      [task.stream],
    );
  }
}

// Runs one bank's decode+inspect on the pool. `streamBuffer` must be a
// standalone (transferable) ArrayBuffer holding the compressed bank. Resolves
// with the inspect payload ({layout, counts}) or rejects with the unit's error
// message.
function inspectBankInPool(streamBuffer, uncompSize) {
  return new Promise((resolve, reject) => {
    scanPoolFor(); // lazily create the pool on the first bank — dispatchScanPool iterates it, so it must exist before the first dispatch
    scanPoolQueue.push({
      stream: streamBuffer,
      uncompSize,
      settle: (msg) => (msg && msg.ok ? resolve(msg.appleInfo) : reject(new Error((msg && msg.message) || "scan unit failed"))),
    });
    dispatchScanPool();
  });
}

function drainScanPoolQueue() {
  // Settle (reject) queued-but-undispatched tasks: their promises hang off the
  // abandoned scan's Promise.all (handlers attached), so rejecting them is
  // absorbed there and cannot surface as an unhandled rejection. In-flight
  // banks (≤ pool size) are left to finish their single ~100 ms decode.
  for (const task of scanPoolQueue.splice(0)) task.settle({ ok: false, message: "scan cancelled" });
}

function post(message, transfer = []) {
  bump("postMessage");
  // Debug builds carry a counter snapshot on every reply; the spread keeps the
  // message shape identical otherwise (receiver ignores the extra field).
  self.postMessage(DEBUG_COUNTERS ? { ...message, debugCounters: snapshotDebugCounters() } : message, transfer);
}

function resetSession() {
  session = null;
  drainScanPoolQueue();
}

// Registered source for a sourceId. main.js sends the File once at scan time;
// every later request must reference the same id. A missing id means a stale or
// malformed request — fail loudly so the reply carries an error instead of
// silently reading the wrong bytes.
function sourceEntry(sourceId) {
  const entry = sources.get(sourceId);
  if (!entry) throw new Error(`unknown sourceId ${sourceId} (source was never registered)`);
  return entry;
}

async function fatFor(sourceId, source) {
  if (fatMemo.has(sourceId)) return fatMemo.get(sourceId);
  const fat = new Fat16Image(source);
  try {
    await fat.init();
  } catch {
    fatMemo.set(sourceId, null); // not FAT16; do not re-init per record
    return null;
  }
  fatMemo.set(sourceId, fat);
  return fat;
}

function extractContainerMemoized(sourceId, source, fallbackName) {
  let pending = containerMemo.get(sourceId);
  if (!pending) {
    pending = (async () => {
      bump("extractContainer");
      const { outputs } = await extractContainer(source, fallbackName);
      const { mbns } = discoverCandidates(outputs);
      const blobs = new Map();
      for (const { vfile, path } of mbns) {
        // Eagerly harvest every candidate (required: VFile members are
        // release()d after extraction, so lazy reads would hit dead files).
        // Region-backed reads are Promises; a rejected read for a candidate
        // nobody requests must not surface as an unhandled rejection, so each
        // promise gets a no-op .catch() to mark it handled. The stored promise
        // itself still rejects for a genuinely requested candidate. Mem/text-
        // backed reads yield a plain Uint8Array (no .catch), hence the guard.
        const read = vfile.read();
        if (typeof read.catch === "function") read.catch(() => {});
        blobs.set(`${vfile.name}\u0000${normalizeInnerPath(path)}`, read);
      }
      return blobs;
    })();
    containerMemo.set(sourceId, pending);
    pending.catch(() => containerMemo.delete(sourceId)); // failed extraction is not memoized
  }
  return pending;
}

// Blob for a record: direct MBN (whole file) / FAT16 cluster chain / container
// re-extraction, in that order. `file` supplies the display label for
// container extraction; bytes always come from `source`.
async function readRecordBlob(sourceId, file, source, record) {
  if (record.external && record.inner_path === record.name && matchesCandidate(record.name)) {
    return source.read(0, source.size);
  }
  const fat = await fatFor(sourceId, source);
  if (fat) {
    try {
      const entry = await fat.findFile(record.inner_path);
      if (entry) return (await fat.readClusters(entry.firstCluster)).slice(0, entry.size);
    } catch {
      // Base worker semantics: a corrupt-but-initialized FAT (ParseError from
      // findFile/readClusters) falls through to container extraction instead
      // of propagating — only init() failures mean "not FAT16". The memoized
      // image stays cached (it is read-only after init(), so re-lookups are
      // deterministic) and every lookup re-routes through the container path
      // exactly like the unmemoized base worker did.
    }
  }
  const blobs = await extractContainerMemoized(sourceId, source, file && file.name ? file.name : record.name);
  const blob = blobs.get(`${record.name}\u0000${normalizeInnerPath(record.inner_path)}`);
  if (blob !== undefined) return blob;
  throw new Error(`record not found in source: ${record.name} (${record.inner_path})`);
}

// Blob + memo entry for a record: extracts the raw blob once per sourceId via the
// (name, sha256) memo key. No parsing happens here — a pure "mbn" export must
// be a byte-for-byte extraction that never invokes the parser
// (qualcomm_rf_combo_analyzer.py export_module: a pure MBN dump "must not
// invoke either the legacy or modern parser").
async function ensureBlob(sourceId, fileIndex, record) {
  const { file, source } = sourceEntry(sourceId);
  let memo = parseMemo.get(sourceId);
  if (!memo) {
    memo = new Map();
    parseMemo.set(sourceId, memo);
  }
  const key = `${record.name}\u0000${record.sha256 ?? ""}`;
  let entry = memo.get(key);
  if (!entry) {
    const blob = await readRecordBlob(sourceId, file, source, record);
    entry = { blob, parsed: null };
    memo.set(key, entry);
  }
  return entry;
}

async function ensureParsed(sourceId, fileIndex, record) {
  const entry = await ensureBlob(sourceId, fileIndex, record);
  if (!entry.parsed) {
    bump("parseModule");
    entry.parsed = parseModule(record, entry.blob);
  }
  return entry;
}

// --- Apple C-series card open / export ------------------------------------------
//
// record.apple carries the envelope of the COMPRESSED stream: for a raw ftab
// input the stream is a file slice at offset+12; for a bbfw/zip input it is a
// slice of the INFLATED ftab member (record.apple.member names it), which is
// re-extracted and memoized per sourceId. Decompression is deferred to card
// open and memoized per sourceId by (record name, sha256 of the compressed
// stream) — the same content-addressing rule as parseMemo.

async function appleFtabMember(sourceId, record) {
  let memo = appleMemberMemo.get(sourceId);
  if (!memo) {
    memo = new Map();
    appleMemberMemo.set(sourceId, memo);
  }
  const memberName = record.apple.member;
  let pending = memo.get(memberName);
  if (!pending) {
    pending = (async () => {
      // record.apple.member may be "outer!inner" for nested bbfw zip members;
      // extractFtabMember re-reads the member list per zip scope.
      return extractFtabMember(sourceEntry(sourceId).source, memberName);
    })();
    memo.set(memberName, pending);
    pending.catch(() => memo.delete(memberName));
  }
  return pending;
}

async function ensureAppleBank(sourceId, fileIndex, record) {
  const { source } = sourceEntry(sourceId);
  let memo = appleBankMemo.get(sourceId);
  if (!memo) {
    memo = new Map();
    appleBankMemo.set(sourceId, memo);
  }
  const key = `${record.name}\u0000${record.sha256 ?? ""}`;
  let entry = memo.get(key);
  if (!entry) {
    const comp = record.apple.member
      ? (await appleFtabMember(sourceId, record)).subarray(record.apple.offset + 12, record.apple.offset + 12 + record.apple.compSize)
      : await source.read(record.apple.offset + 12, record.apple.compSize);
    const bank = lzfseDecode(comp, record.apple.uncompSize);
    entry = { bank, parsed: null };
    memo.set(key, entry);
  }
  return entry;
}

async function ensureAppleParsed(sourceId, fileIndex, record) {
  const entry = await ensureAppleBank(sourceId, fileIndex, record);
  if (!entry.parsed) {
    bump("parseAppleBank");
    entry.parsed = parseAppleBank(entry.bank, record.inner_path);
    requireValidBank(entry.parsed); // main.py flow: parse_bank + require_valid_bank before any use
  }
  return entry;
}

// Export dispatch for apple records. mbn = the raw decompressed bank (pure
// dump, no parse); json/csv/webcsv/b0cd/b826 go through the parsed bank.
async function exportAppleFiles(sourceId, fileIndex, record, format) {
  const stem = record.inner_path;
  if (format === "mbn") {
    const { bank } = await ensureAppleBank(sourceId, fileIndex, record);
    return [{ filename: `${stem}.bin`, bytes: bank }];
  }
  const { parsed } = await ensureAppleParsed(sourceId, fileIndex, record);
  if (format === "json") {
    const text =
      JSON.stringify({ name: record.name, profile_id: parsed.profile_id, tables: generateAppleTables(parsed) }, null, 2) + "\n";
    return [{ filename: `${stem}_all_combos.json`, text }];
  }
  if (format === "csv" || format === "webcsv") {
    // The qcom csv exporter is parser-coupled (combinations/components); apple
    // banks have viewer tables only, so both formats write the four viewer
    // tables through the shared toCsvText writer (same file shape).
    const tables = generateAppleTables(parsed);
    const names = { lte_ca: "lteca", nr_ca: "nrca", endc: "endc", nrdc: "nrdc" };
    const files = [];
    for (const table of ["lte_ca", "nr_ca", "endc", "nrdc"]) {
      if (!tables[table] || tables[table].length === 0) continue;
      const text = toCsvText(tables[table]);
      if (text !== null) files.push({ filename: `${stem}_${names[table]}.csv`, text });
    }
    return files;
  }
  if (format === "b0cd" || format === "b826") {
    return exportAppleDiag(parsed, format);
  }
  throw new ToolError(`Unsupported export format: ${format}`);
}

async function handleScan(msg) {
  resetSession();
  session = { scanId: msg.id };
  const { id, files } = msg;
  const total = files.length;
  for (let fileIndex = 0; fileIndex < total; fileIndex++) {
    if (cancelled.has(id)) break;
    // Registration: each entry is { sourceId, file }. The File is structured-
    // cloned once here and kept in `sources`; every later request carries only
    // the stable id, so the per-source memos actually hit across messages.
    const entry = files[fileIndex];
    const sourceId = entry.sourceId;
    const file = entry.file;
    sources.set(sourceId, { file, source: new BrowserFileSource(file) });
    post({ type: "progress", phase: "scan", source: file.name, done: fileIndex, total, currentFile: file.name });
    try {
      let postedWarnings = 0; // partial batches already delivered these
      const source = sources.get(sourceId).source;
      const { records, warnings } = await scanSource(source, file.name, {
        shouldCancel: () => cancelled.has(id),
        // Fan the ftab's banks out to the scan pool (measured: 99% of apple
        // scan time is the per-bank LZFSE decode; sha256/inspect are ~1%).
        // The hook receives the stream AFTER its digest was taken and may
        // detach it: raw-ftab reads are compact standalone buffers (transfer
        // as-is), bbfw banks are subarray views of the inflated member (copy
        // the range into a standalone buffer first).
        inspectAppleBankAsync: (stream, uncompSize) =>
          inspectBankInPool(
            stream.byteOffset === 0 && stream.byteLength === stream.buffer.byteLength ? stream.buffer : stream.slice().buffer,
            uncompSize,
          ),
        // Progressive card list: each contiguous, in-order group of completed
        // banks is posted immediately (main.js dedupes by card key; the final
        // "records" reply below still carries the authoritative full set).
        onAppleBatch: (batchRecords, batchWarnings) => {
          if (cancelled.has(id)) return;
          postedWarnings += batchWarnings.length;
          post({ type: "records", fileIndex, records: batchRecords, warnings: batchWarnings });
        },
        // Unit-level progress (per apple bank / per counted MBN record /
        // container extraction): the bar stays file-fraction based — main.js
        // adds the parsed sub-file fraction to `done`. Suppressed after cancel
        // so a cancelled scan cannot re-show the progress row.
        onScanProgress: (info) => {
          if (cancelled.has(id)) return;
          const detail = info.stage === "apple" ? `banks ${info.done}/${info.total}`
            : info.stage === "count" ? `counting ${info.done}/${info.total}`
            : info.stage === "extract" ? "extracting" : "";
          post({ type: "progress", phase: "scan", source: file.name, done: fileIndex, total, currentFile: file.name, detail });
        },
      });
      if (cancelled.has(id)) break;
      post({ type: "records", fileIndex, records, warnings: warnings.slice(postedWarnings) });
    } catch (err) {
      if (err instanceof ScanCancelled || cancelled.has(id)) break;
      post({ type: "error", message: err && err.message ? err.message : String(err), source: file.name });
    }
  }
  if (cancelled.has(id)) {
    resetSession(); // cancel resets scan state
  } else {
    post({ type: "progress", phase: "scan", source: "", done: total, total, currentFile: "" });
  }
}

async function handleParseCard(msg) {
  if (msg.record.apple) {
    // Apple CR bank: parse + audit + viewer tables (same reply shape as qcom;
    // cardcache validates the shape the same way).
    const { parsed } = await ensureAppleParsed(msg.sourceId, msg.fileIndex, msg.record);
    bump("generateAppleTables");
    const tables = generateAppleTables(parsed);
    post({ type: "tables", id: msg.id, fileIndex: msg.fileIndex, recordName: msg.record.name, tables });
    return;
  }
  const { parsed } = await ensureParsed(msg.sourceId, msg.fileIndex, msg.record);
  bump("generateWebTables");
  const tables = generateWebTables(parsed.combinations, parsed.components);
  post({ type: "tables", id: msg.id, fileIndex: msg.fileIndex, recordName: msg.record.name, tables });
}

async function handleExport(msg) {
  let files;
  if (msg.record.apple) {
    files = await exportAppleFiles(msg.sourceId, msg.fileIndex, msg.record, msg.format);
  } else if (msg.format === "mbn") {
    // Raw .mbn dump (Python export_module "mbn"): the untouched blob under
    // record.name — byte-for-byte, no parse, no text encoding. Reuses the
    // ensureBlob path incl. the per-source memo, so a batch that also exports
    // text formats extracts the container exactly once.
    const { blob } = await ensureBlob(msg.sourceId, msg.fileIndex, msg.record);
    files = [{ filename: msg.record.name, bytes: blob }];
  } else {
    const { parsed } = await ensureParsed(msg.sourceId, msg.fileIndex, msg.record);
    files = exportModule(msg.record, parsed, msg.format);
  }
  // One reply per export request: every file the format produced travels
  // together (mbn=1, json=1, csv=2, webcsv=1-4, b0cd/b826=1), so the main
  // thread can await the complete reply when running batch exports.
  // Binary files travel as transferable ArrayBuffers (one worker-side copy so
  // the memoized blob stays usable — transferring would detach it); text
  // files travel as plain strings. No base64 round-trip.
  const transfer = [];
  const payload = files.map((f) => {
    if (f.bytes !== undefined) {
      const copy = new Uint8Array(f.bytes.byteLength);
      copy.set(f.bytes);
      transfer.push(copy.buffer);
      return { filename: f.filename, bytes: copy };
    }
    return { filename: f.filename, text: f.text };
  });
  post({ type: "exportBlob", id: msg.id, files: payload }, transfer);
}

// Import-to-parser support: the main thread uploads a single card's DIAG
// packet texts to uecaps.hennes.xyz/parse/multiPart. Both packet sets are
// forced here regardless of the export checkboxes (import is ticked-only,
// not export-ticked-only). An empty packet set (rare, legacy-only cards) is
// OMITTED — exportModule would happily write a header-only text for `[]`,
// which the parser would accept as an (empty) capability, so the length
// check here is what makes "send only non-empty entries" true; a card with
// both sets empty is reported by the main thread. The reply reuses the
// exportBlob shape (files as text), so the existing waiter/error/clear
// plumbing applies unchanged.
async function handleImportCards(msg) {
  const files = [];
  for (const format of ["b0cd", "b826"]) {
    try {
      // Apple records export DIAG texts from the parsed CR bank; qcom records
      // through the analyzer exporter. The filename tails are identical
      // (`_0xB0CD_v41.txt` / `_0xB826_v22.txt`), so the main thread's textFor
      // lookups and the uecaps upload flow work unchanged for both.
      let produced;
      if (msg.record.apple) {
        const { parsed } = await ensureAppleParsed(msg.sourceId, msg.fileIndex, msg.record);
        produced = exportAppleDiag(parsed, format);
        // A bank with zero packets for this format yields a header-only text
        // (no "Payload:" blocks) — omit it, same rule as the qcom empty-set
        // path below. (exportAppleDiag itself is golden-pinned byte-exact and
        // must not change.)
        if (!produced.some((f) => f.text.includes("Payload:"))) continue;
      } else {
        const { parsed } = await ensureParsed(msg.sourceId, msg.fileIndex, msg.record);
        if (!Array.isArray(parsed.diag?.[format]) || parsed.diag[format].length === 0) {
          continue; // empty packet set — omit this format from the import payload
        }
        produced = exportModule(msg.record, parsed, format);
      }
      files.push(...produced.map((f) => ({ filename: f.filename, text: f.text })));
    } catch {
      // Belt-and-braces: a ToolError here also means "omit this set".
    }
  }
  post({ type: "exportBlob", id: msg.id, files }, []);
}

function handleRelease() {
  // Clear button: drop every registered source and memo. A new scan must NOT do
  // this (cards accumulate across imports and keep referencing earlier
  // sourceIds); only an explicit release does.
  sources.clear();
  parseMemo.clear();
  fatMemo.clear();
  containerMemo.clear();
  appleBankMemo.clear();
  appleMemberMemo.clear();
  resetSession();
}

function handle(msg) {
  if (msg.type === "scan") return handleScan(msg);
  if (msg.type === "parseCard") return handleParseCard(msg);
  if (msg.type === "export") return handleExport(msg);
  if (msg.type === "importCards") return handleImportCards(msg);
  if (msg.type === "release") return handleRelease();
  throw new Error(`unknown message type: ${msg.type}`);
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  // Cancel is handled immediately, never queued: it must be able to interrupt
  // between awaits. A cancel without id (or for the current operation) also
  // resets worker state (Task 11 Step 1).
  if (msg.type === "cancel") {
    if (msg.id !== undefined) cancelled.add(msg.id);
    else if (currentOp) cancelled.add(currentOp.id);
    if (msg.id === undefined || (currentOp && msg.id === currentOp.id)) resetSession();
    return;
  }

  // Debug instrumentation toggle (Step 0): flips counter attachment on replies
  // and resets to a known state so a session can measure a single window.
  if (msg.type === "debug") {
    DEBUG_COUNTERS = !!msg.enabled;
    if (msg.reset) resetDebugCounters();
    post({ type: "debug", enabled: DEBUG_COUNTERS, debugCounters: snapshotDebugCounters() });
    return;
  }

  // Mobile fast lane (main.js sets `fast` in the stacked layout): a card open
  // must not queue behind the running scan of the whole file batch — on a
  // phone that is seconds x N files, which made clicks appear dead. parseCard
  // is a pure read over the registered source + the per-sourceId memos (it never
  // touches session state, the cancelled set or currentOp), so running it
  // alongside the scan is safe; the lane is still serialized against other fast
  // opens. Desktop omits `fast` and keeps the fully serialized chain
  // byte-identical.
  if (msg.type === "parseCard" && msg.fast) {
    const op = msg;
    parseChain = parseChain
      .then(() => handle(op))
      .catch((err) => {
        post({
          type: "error",
          id: op.id,
          message: err && err.message ? err.message : String(err),
          source: (op.record && op.record.name) || (op.file && op.file.name) || op.source,
        });
      });
    return;
  }

  const op = msg;
  currentOp = op;
  chain = chain
    .then(() => handle(op))
    .catch((err) => {
      // Name the record or file (op.source is only set by scan, which posts
      // its own errors) and echo the request id so the main thread can drop
      // the pending reply.
      post({
        type: "error",
        id: op.id,
        message: err && err.message ? err.message : String(err),
        source: (op.record && op.record.name) || (op.file && op.file.name) || op.source,
      });
    })
    .finally(() => {
      if (currentOp === op) currentOp = null;
    });
};
