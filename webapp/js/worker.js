// Parse worker (Task 11 Step 1). Message protocol, exactly per the plan:
//
// main -> worker
//   { type: "scan",      id, files: [File, ...] }   File handles pass through
//                                                   structured clone, zero-copy
//   { type: "parseCard", id, file, fileIndex?, record }   file is THE File the
//                                                   card came from; fileIndex
//                                                   is bookkeeping only
//   { type: "export",    id, file, fileIndex?, record, format }  csv|json|webcsv
//   { type: "cancel",    id }
// worker -> main
//   { type: "progress",  phase, source, done, total, currentFile }
//   { type: "records",   fileIndex, records, warnings? }  plain JSON-able
//                                                         ModuleRecord list
//   { type: "tables",    id, fileIndex, recordName, tables }
//   { type: "exportBlob", id, filename, base64 }
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
} from "./lib/analyzer.js";
import { extractContainer, discoverCandidates } from "./lib/extractor.js";

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

function post(message) {
  self.postMessage(message);
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

function bytesToBase64(u8) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Blob for a record: direct MBN (whole file) / FAT16 cluster chain / container
// re-extraction, in that order. `file` supplies the display label for
// container extraction; bytes always come from `source`.
async function readRecordBlob(source, file, record) {
  if (record.external && record.inner_path === record.name && matchesCandidate(record.name)) {
    return source.read(0, source.size);
  }
  const fat = new Fat16Image(source);
  try {
    await fat.init();
    const entry = await fat.findFile(record.inner_path);
    if (entry) return (await fat.readClusters(entry.firstCluster)).slice(0, entry.size);
  } catch {
    // not FAT16: fall through to container extraction
  }
  const { outputs } = await extractContainer(source, file && file.name ? file.name : record.name);
  const { mbns } = discoverCandidates(outputs);
  const wanted = normalizeInnerPath(record.inner_path);
  for (const { vfile, path } of mbns) {
    if (vfile.name === record.name && normalizeInnerPath(path) === wanted) return vfile.read();
  }
  throw new Error(`record not found in source: ${record.name} (${record.inner_path})`);
}

async function ensureParsed(file, fileIndex, record) {
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
    const parsed = parseModule(record, blob);
    entry = { blob, parsed };
    memo.set(key, entry);
  }
  return entry;
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
  const { parsed } = await ensureParsed(msg.file, msg.fileIndex, msg.record);
  const tables = generateWebTables(parsed.combinations, parsed.components);
  post({ type: "tables", id: msg.id, fileIndex: msg.fileIndex, recordName: msg.record.name, tables });
}

async function handleExport(msg) {
  const { parsed } = await ensureParsed(msg.file, msg.fileIndex, msg.record);
  const files = exportModule(msg.record, parsed, msg.format);
  const encoder = new TextEncoder();
  for (const file of files) {
    post({ type: "exportBlob", id: msg.id, filename: file.filename, base64: bytesToBase64(encoder.encode(file.text)) });
  }
}

function handle(msg) {
  if (msg.type === "scan") return handleScan(msg);
  if (msg.type === "parseCard") return handleParseCard(msg);
  if (msg.type === "export") return handleExport(msg);
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
