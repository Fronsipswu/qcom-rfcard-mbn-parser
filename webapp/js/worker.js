// Parse worker (Task 11 Step 1). Message protocol, exactly per the plan:
//
// main -> worker
//   { type: "scan",      id, files: [File, ...] }   File handles pass through
//                                                   structured clone, zero-copy
//   { type: "parseCard", id, file, fileIndex?, record }   file is THE File the
//                                                   card came from; fileIndex
//                                                   is bookkeeping only
//   { type: "export",    id, file, fileIndex?, record, format }  mbn|json|csv|
//                                                   webcsv|b0cd|b826
//   { type: "importCards", id, file, fileIndex?, record } -> both DIAG texts
//   { type: "cancel",    id }
// worker -> main
//   { type: "progress",  phase, source, done, total, currentFile }
//   { type: "records",   fileIndex, records, warnings? }  plain JSON-able
//                                                         ModuleRecord list
//   { type: "tables",    id, fileIndex, recordName, tables }
//   { type: "exportBlob", id, files: [{ filename, bytes } | { filename, text }, ...] }
//   { type: "error",     id?, message, source? }
//
// Additive protocol details (documented deviations, needed by the UI layer):
// - "records" carries an optional `warnings` array ({tool, message}) so the
//   detect-and-warn panel can list them next to the records they belong to.
// - parseCard/export MUST carry the card's own File handle: the worker resolves
//   bytes from that file, never from a session fileIndex. Session state resets
//   on every scan while cards accumulate across imports, so a fileIndex alone
//   can point at the wrong file (wrong tables rendered AND cached under the
//   card's sha256 key). Replies carry the request `id`; the main thread
//   correlates on it. `fileIndex` stays on the messages for bookkeeping only.
// - errors for an id-bearing op echo that `id` so pending replies can be
//   released; `source` names the record or file instead of being undefined.
//
// Per-card parseCard re-slices only the MBN buffer: re-read via a
// BrowserFileSource kept per File (WeakMap), direct MBNs read the whole file,
// FAT16 records use an exact-path Fat16Image.findFile lookup, container
// records re-extract and match by normalized inner_path (scratch-dir tags
// differ between runs). Blobs + parsed modules are memoized per File, then by
// (record name, sha256): a different import's File is a different WeakMap key,
// so a stale fileIndex or colliding card name can never hit another card's
// memo entry, and equal (name, sha256) pairs are content-identical by
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
import { zipEntryData, zipEntries } from "./lib/extractor.js";
import { lzfseDecode } from "./lib/lzfse.js";
import {
  parseAppleBank,
  requireValidBank,
  generateAppleTables,
  exportAppleDiag,
} from "./lib/apple_cr.js";

const cancelled = new Set();
let session = null; // { scanId }
let chain = Promise.resolve(); // serialize scan/parseCard/export handling
let currentOp = null;

// Parse memo + RandomAccessSource per File handle. Keyed by the File itself:
// cards from different imports never share memo entries even when their
// records collide on name and fileIndex; within one File the (name, sha256)
// pair content-addresses the entry. Entries die with their File.
const parseMemo = new WeakMap(); // File -> Map<`${name}\u0000${sha256}`, {blob, parsed}>
const sourceMemo = new WeakMap(); // File -> BrowserFileSource
const fatMemo = new WeakMap(); // File -> Fat16Image | null (null = init failed: not FAT16)
// File -> Promise<Map<`${name}\u0000${inner_path}`, Uint8Array>>: extraction may
// release VFiles it returns (VFile.release drops consumed members), so the memo
// harvests the extracted mbn bytes once and lets the virtual tree go.
const containerMemo = new WeakMap();
// Apple card-open memo (mirrors parseMemo): File -> Map<`${name}\u0000${sha256}`,
// {bank, parsed}> where bank is the DECOMPRESSED CR bank. Zip/bbfw inputs also
// memoize the inflated ftab member they were sliced from.
const appleBankMemo = new WeakMap(); // File -> Map<key, {bank, parsed}>
const appleMemberMemo = new WeakMap(); // File -> Map<memberName, Promise<Uint8Array>>

function post(message, transfer = []) {
  self.postMessage(message, transfer);
}

function resetSession() {
  session = null;
}

function sourceFor(file) {
  let source = sourceMemo.get(file);
  if (!source) {
    source = new BrowserFileSource(file);
    sourceMemo.set(file, source);
  }
  return source;
}

async function fatFor(source, file) {
  if (fatMemo.has(file)) return fatMemo.get(file);
  const fat = new Fat16Image(source);
  try {
    await fat.init();
  } catch {
    fatMemo.set(file, null); // not FAT16; do not re-init per record
    return null;
  }
  fatMemo.set(file, fat);
  return fat;
}

function extractContainerMemoized(source, file, fallbackName) {
  let pending = containerMemo.get(file);
  if (!pending) {
    pending = (async () => {
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
    containerMemo.set(file, pending);
    pending.catch(() => containerMemo.delete(file)); // failed extraction is not memoized
  }
  return pending;
}

// Blob for a record: direct MBN (whole file) / FAT16 cluster chain / container
// re-extraction, in that order. `file` supplies the display label for
// container extraction; bytes always come from `source`.
async function readRecordBlob(source, file, record) {
  if (record.external && record.inner_path === record.name && matchesCandidate(record.name)) {
    return source.read(0, source.size);
  }
  const fat = await fatFor(source, file);
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
  const blobs = await extractContainerMemoized(source, file, file && file.name ? file.name : record.name);
  const blob = blobs.get(`${record.name}\u0000${normalizeInnerPath(record.inner_path)}`);
  if (blob !== undefined) return blob;
  throw new Error(`record not found in source: ${record.name} (${record.inner_path})`);
}

// Blob + memo entry for a record: extracts the raw blob once per File via the
// (name, sha256) memo key. No parsing happens here — a pure "mbn" export must
// be a byte-for-byte extraction that never invokes the parser
// (qualcomm_rf_combo_analyzer.py export_module: a pure MBN dump "must not
// invoke either the legacy or modern parser").
async function ensureBlob(file, fileIndex, record) {
  if (!file || typeof file.slice !== "function") {
    throw new Error(`no File handle for record ${record.name} (fileIndex ${fileIndex})`);
  }
  let memo = parseMemo.get(file);
  if (!memo) {
    memo = new Map();
    parseMemo.set(file, memo);
  }
  const key = `${record.name}\u0000${record.sha256 ?? ""}`;
  let entry = memo.get(key);
  if (!entry) {
    const blob = await readRecordBlob(sourceFor(file), file, record);
    entry = { blob, parsed: null };
    memo.set(key, entry);
  }
  return entry;
}

async function ensureParsed(file, fileIndex, record) {
  const entry = await ensureBlob(file, fileIndex, record);
  if (!entry.parsed) entry.parsed = parseModule(record, entry.blob);
  return entry;
}

// --- Apple C-series card open / export ------------------------------------------
//
// record.apple carries the envelope of the COMPRESSED stream: for a raw ftab
// input the stream is a file slice at offset+12; for a bbfw/zip input it is a
// slice of the INFLATED ftab member (record.apple.member names it), which is
// re-extracted and memoized per File. Decompression is deferred to card open
// and memoized per File by (record name, sha256 of the compressed stream) —
// the same content-addressing rule as parseMemo.

async function appleFtabMember(file, record) {
  let memo = appleMemberMemo.get(file);
  if (!memo) {
    memo = new Map();
    appleMemberMemo.set(file, memo);
  }
  const memberName = record.apple.member;
  let pending = memo.get(memberName);
  if (!pending) {
    pending = (async () => {
      const source = sourceFor(file);
      const entries = await zipEntries(source);
      // record.apple.member may be "outer!inner" for nested bbfw zip members.
      const names = memberName.split("!");
      let data = null;
      let scope = source;
      for (const name of names) {
        const entry = entries.find((e) => e.name === name);
        if (!entry) throw new Error(`apple ftab member not found in source: ${name}`);
        data = await zipEntryData(scope, entry);
        // if the extracted member is itself a zip, descend (nested bbfw)
        if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
          scope = {
            size: data.length,
            read: (o, l) => data.subarray(o, o + l),
          };
        } else {
          scope = null;
        }
      }
      return data;
    })();
    memo.set(memberName, pending);
    pending.catch(() => memo.delete(memberName));
  }
  return pending;
}

async function ensureAppleBank(file, fileIndex, record) {
  if (!file || typeof file.slice !== "function") {
    throw new Error(`no File handle for record ${record.name} (fileIndex ${fileIndex})`);
  }
  let memo = appleBankMemo.get(file);
  if (!memo) {
    memo = new Map();
    appleBankMemo.set(file, memo);
  }
  const key = `${record.name}\u0000${record.sha256 ?? ""}`;
  let entry = memo.get(key);
  if (!entry) {
    const source = sourceFor(file);
    const comp = record.apple.member
      ? (await appleFtabMember(file, record)).subarray(record.apple.offset + 12, record.apple.offset + 12 + record.apple.compSize)
      : await source.read(record.apple.offset + 12, record.apple.compSize);
    const bank = lzfseDecode(comp, record.apple.uncompSize);
    entry = { bank, parsed: null };
    memo.set(key, entry);
  }
  return entry;
}

async function ensureAppleParsed(file, fileIndex, record) {
  const entry = await ensureAppleBank(file, fileIndex, record);
  if (!entry.parsed) {
    entry.parsed = parseAppleBank(entry.bank, record.inner_path);
    requireValidBank(entry.parsed); // main.py flow: parse_bank + require_valid_bank before any use
  }
  return entry;
}

// Export dispatch for apple records. mbn = the raw decompressed bank (pure
// dump, no parse); json/csv/webcsv/b0cd/b826 go through the parsed bank.
async function exportAppleFiles(file, fileIndex, record, format) {
  const stem = record.inner_path;
  if (format === "mbn") {
    const { bank } = await ensureAppleBank(file, fileIndex, record);
    return [{ filename: `${stem}.bin`, bytes: bank }];
  }
  const { parsed } = await ensureAppleParsed(file, fileIndex, record);
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
    const file = files[fileIndex];
    post({ type: "progress", phase: "scan", source: file.name, done: fileIndex, total, currentFile: file.name });
    try {
      const source = new BrowserFileSource(file);
      const { records, warnings } = await scanSource(source, file.name, {
        shouldCancel: () => cancelled.has(id),
      });
      if (cancelled.has(id)) break;
      post({ type: "records", fileIndex, records, warnings: warnings ?? [] });
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
    const { parsed } = await ensureAppleParsed(msg.file, msg.fileIndex, msg.record);
    const tables = generateAppleTables(parsed);
    post({ type: "tables", id: msg.id, fileIndex: msg.fileIndex, recordName: msg.record.name, tables });
    return;
  }
  const { parsed } = await ensureParsed(msg.file, msg.fileIndex, msg.record);
  const tables = generateWebTables(parsed.combinations, parsed.components);
  post({ type: "tables", id: msg.id, fileIndex: msg.fileIndex, recordName: msg.record.name, tables });
}

async function handleExport(msg) {
  let files;
  if (msg.record.apple) {
    files = await exportAppleFiles(msg.file, msg.fileIndex, msg.record, msg.format);
  } else if (msg.format === "mbn") {
    // Raw .mbn dump (Python export_module "mbn"): the untouched blob under
    // record.name — byte-for-byte, no parse, no text encoding. Reuses the
    // ensureBlob path incl. the per-File memo, so a batch that also exports
    // text formats extracts the container exactly once.
    const { blob } = await ensureBlob(msg.file, msg.fileIndex, msg.record);
    files = [{ filename: msg.record.name, bytes: blob }];
  } else {
    const { parsed } = await ensureParsed(msg.file, msg.fileIndex, msg.record);
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
        const { parsed } = await ensureAppleParsed(msg.file, msg.fileIndex, msg.record);
        produced = exportAppleDiag(parsed, format);
      } else {
        const { parsed } = await ensureParsed(msg.file, msg.fileIndex, msg.record);
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

function handle(msg) {
  if (msg.type === "scan") return handleScan(msg);
  if (msg.type === "parseCard") return handleParseCard(msg);
  if (msg.type === "export") return handleExport(msg);
  if (msg.type === "importCards") return handleImportCards(msg);
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
