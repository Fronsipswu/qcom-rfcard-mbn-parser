// Container orchestration: port of gui_version/image_extractor.py's
// unwrap recursion (:663-729) and EXTRACTORS dispatch (:641-660) onto a
// virtual file tree. Python stages materialize sibling scratch dirs under one
// workdir root (tempfile.mkdtemp(prefix=f"{tag}_", dir=ctx.workdir) at
// :107-108); the mirror creates sibling virtual dirs named `<tag>_<n>` under a
// single root, and MBN paths are recorded relative to that root. The
// analyzer's record_json SCRATCH_DIR_RE then normalizes `sparse_<n>/...` to
// the golden `sparse/...` first component exactly as the Python goldens do.
//
// In-house replacements for external tools (approved plan deviations):
//   extract_sparse 7z path -> SparseReader + Fat16Image/Ext4Image tree walk
//     (radio.img's sparse payload is an ext4 filesystem - verified against
//     7-Zip and the goldens; tree lands in the sparse workdir, :301-312)
//   extract_ext4 debugfs   -> ext4.js tree walk (same workdir shape :322-332)
//   extract_fat/fat_or_mbr 7z -> Fat16Image walk (:646-647)
//   extract_lz4 CLI/lz4.frame -> lz4.js (:414-432)
//   extract_gzip gzip module  -> DecompressionStream (:366-374)
// Everything without an in-house reader surfaces an UNSUPPORTED_TAGS warning.
import { detect, UNSUPPORTED_TAGS, SUPPORTED_TAGS } from "./formats.js";
import { SparseReader, scanForSparse } from "./sparse.js";
import { decompressLz4Frame } from "./lz4.js";
import { Fat16Image } from "./fat16.js";
import { Ext4Image } from "./ext4.js";
import { SlicedSource } from "./source.js";
import { extractBbcfgTree, extractEfsPathnames } from "./iphone.js";
import { inflateSync } from "../../lib/vendor/fflate.js";

const MAGIC_MAX = 4096;
const MAX_RECURSION_DEPTH = 8;
const MIN_CONTAINER_SIZE = 512;

// RFCARD_PATTERN / SIDECAR_PATTERNS (image_extractor.py:37-53): the candidate
// filter discover_candidates applies; the analyzer's stricter
// _matches_candidate runs again per MBN.
export const RFCARD_RE = /^(?:rf_config_[0-9A-Fa-f]{3,6}_[0-9A-Fa-f]{1,4}_[0-9A-Fa-f]{1,4}(?:_(?:\d+))?|[0-9A-Fa-f]+_[0-9A-Fa-f]+(?:_[0-9A-Fa-f]+)?)\.mbn$/i;
export const SIDECAR_RES = [/^rf_config_.*_combos\.xml$/, /^rf_config_.*_combos_.*\.txt$/, /^mbn_ota\.md5sum$/, /^rfcard_info_all\.(?:csv|json)$/];

export class ExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtractionError";
  }
}

// --- virtual file tree -------------------------------------------------------------

// A regular file inside the virtual tree. Backed either by in-memory bytes or
// by a region of a RandomAccessSource (zero-copy slices; large containers are
// never materialized unless an extractor must own the bytes).
export class VFile {
  // load: () => Promise<Uint8Array>; region: { source, offset, size } | null
  constructor(name, load, size, region = null) {
    this.name = name;
    this.#load = load;
    this.size = size;
    this.region = region;
  }

  #load;
  #memData = undefined;
  #released = false;

  static mem(name, data) {
    // Holder indirection instead of a captured constant so release() can drop
    // the buffer later (see release()).
    const file = new VFile(name, () => file.#memData, data.length, null);
    file.#memData = data;
    return file;
  }

  static text(name, text) {
    const data = new TextEncoder().encode(text);
    return new VFile(name, () => data, data.length, null);
  }

  static slice(name, source, offset, size) {
    return new VFile(name, () => source.read(offset, size), size, { source, offset, size });
  }

  // Source over this file's bytes (region views stay zero-copy).
  asSource() {
    if (this.region) return new SlicedSource(this.region.source, this.region.offset, this.region.size);
    return new MemorySourceSync(this);
  }

  read() {
    if (this.#released) throw new Error(`${this.name}: bytes released after container extraction`);
    return this.#load();
  }

  // Drops the materialized buffer of a mem-backed file so it can be collected
  // once the container's extracted output exists - extract_tar materializes
  // every member eagerly, and the Samsung .tar.md5 must not keep its ~97MB
  // modem.bin.lz4 pinned underneath the ~190MB lz4 output. Region-backed
  // files keep their source window (release is a no-op for them); reading a
  // released file throws so a stale consumer fails loudly instead of
  // silently seeing empty bytes.
  release() {
    if (this.#memData !== undefined) {
      this.#memData = undefined;
      this.#released = true;
    }
  }
}

// Lazy MemorySource: materializes on first read (only reached when an
// extractor must own bytes of a region-backed file, e.g. lz4 over a tar
// member).
class MemorySourceSync {
  constructor(vfile) {
    this.vfile = vfile;
    this.size = vfile.size;
  }

  async read(offset, length) {
    if (!this.data) this.data = await this.vfile.read();
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(`short read at ${offset}+${length}/${this.size}`);
    }
    return this.data.subarray(offset, offset + length);
  }

  async close() {}
}

export class VDir {
  constructor(name) {
    this.name = name;
    this.entries = new Map(); // name -> VDir | VFile
  }

  dir(name) {
    let d = this.entries.get(name);
    if (!d) {
      d = new VDir(name);
      this.entries.set(name, d);
    }
    return d;
  }

  // addFile(dir, "a/b.txt", bytesLike) helper used by iphone.js callbacks
  addFile(path, vfile) {
    const parts = path.split("/").filter(Boolean);
    let dir = this;
    for (const part of parts.slice(0, -1)) dir = dir.dir(part);
    dir.entries.set(parts[parts.length - 1], vfile);
  }

  // Pre-order DFS over files; paths are relative to this dir, "/"-separated.
  files(prefix = "") {
    const out = [];
    for (const entry of this.entries.values()) {
      if (entry instanceof VFile) {
        out.push({ vfile: entry, path: prefix + entry.name });
      } else {
        out.push(...entry.files(`${prefix}${entry.name}/`));
      }
    }
    return out;
  }
}

// mkdtemp(prefix=f"{tag}_", dir=ctx.workdir): sibling workdirs under one root.
class ExtractContext {
  constructor() {
    this.root = new VDir("");
    this.outputs = [];
    this.warnings = [];
    this.counter = 0;
  }

  newWorkdir(tag) {
    const dir = new VDir(`${tag}_${this.counter++}`);
    this.root.entries.set(dir.name, dir);
    return dir;
  }

  addFile(dir, path, data, size, kind) {
    dir.addFile(path, kind === "text" ? VFile.text(path.split("/").pop(), data) : VFile.mem(path.split("/").pop(), data));
  }
}

// --- unwrap recursion (:663-729) ------------------------------------------------------

export async function unwrap(vfile, ctx, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) {
    ctx.warnings.push({ tool: "container", message: `Max recursion depth reached at ${vfile.name}` });
    return;
  }
  if (vfile.size < MIN_CONTAINER_SIZE) return;

  const head = await headOf(vfile);
  const tag = detect(head, vfile.name);

  if (tag === "empty" || tag === "unknown" || tag === "bootimg") {
    // For unrecognized top-level images, scan for known containers hidden
    // behind OEM wrappers (:679-685).
    if (tag === "unknown" && depth === 0) await unwrapEmbeddedContainers(vfile, ctx, depth);
    return;
  }

  const produced = await extractTagged(vfile, tag, ctx);
  if (produced === null) return;

  if (produced instanceof VDir) {
    ctx.outputs.push(produced);
    for (const { vfile: child } of produced.files()) {
      await maybeUnwrapChild(child, ctx, depth + 1);
    }
  } else {
    await unwrap(produced, ctx, depth + 1);
  }
}

async function maybeUnwrapChild(vfile, ctx, depth) {
  // Only recurse into children whose magic clearly identifies a container.
  const tag = detect(await headOf(vfile), vfile.name);
  if (SUPPORTED_TAGS.has(tag) || UNSUPPORTED_TAGS[tag]) {
    await unwrap(vfile, ctx, depth);
  }
}

// _unwrap_embedded_containers (:712-729).
async function unwrapEmbeddedContainers(vfile, ctx, depth) {
  for (const offset of await scanForSparse(vfile.asSource(), vfile.size)) {
    const workdir = ctx.newWorkdir("sliced");
    const stem = pyStem(vfile.name) || "inner";
    const sliced = VFile.slice(`${stem}.sparse`, vfile.asSource(), offset, vfile.size - offset);
    workdir.addFile(sliced.name, sliced);
    await unwrap(sliced, ctx, depth + 1);
  }
}

async function headOf(vfile) {
  const n = Math.min(MAGIC_MAX, vfile.size);
  if (vfile.region) return vfile.region.source.read(vfile.region.offset, n);
  return (await vfile.read()).subarray(0, n);
}

function pyStem(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function warnUnsupported(ctx, node, tag) {
  const desc = UNSUPPORTED_TAGS[tag];
  ctx.warnings.push({
    tool: desc.tool ?? tag,
    message: `${node.name}: ${desc.message}`,
  });
}

// --- extractors (:292-660) -------------------------------------------------------------

async function extractTagged(vfile, tag, ctx) {
  switch (tag) {
    case "sparse":
      return extractSparse(vfile, ctx);
    case "fat":
    case "fat_or_mbr":
      return extractFat(vfile, tag, ctx);
    case "ext4":
      return extractExt4(vfile, ctx);
    case "gzip":
      return extractGzip(vfile, ctx);
    case "lz4":
      return extractLz4(vfile, ctx);
    case "tar":
      return extractTar(vfile, ctx);
    case "zip":
      return extractZip(vfile, ctx);
    case "bbcfg":
      return extractBbcfg(vfile, ctx);
    default:
      if (UNSUPPORTED_TAGS[tag]) {
        warnUnsupported(ctx, vfile, tag);
        return null;
      }
      return null;
  }
}

// Walks a filesystem image source and places every file into the workdir
// (the tree 7-Zip/debugfs would have produced in the same scratch dir).
async function placeTree(dir, image, label, ctx) {
  try {
    await image.init();
    for (const entry of await image.walk()) {
      dir.addFile(entry.path.replace(/^\//, ""), new VFile(entry.path.split("/").pop(), () => image.readFile(entry), entry.size));
    }
    return dir;
  } catch (err) {
    ctx.warnings.push({ tool: label, message: `${label} tree walk failed: ${err.message}` });
    return null;
  }
}

// extract_sparse (:292-319), 7z branch semantics: the filesystem tree lands
// directly in the sparse workdir (golden radio.img records are
// `sparse/image/...`). Non-filesystem sparse payloads keep their raw image in
// the workdir for recursive unwrap, like simg2img's <stem>.raw output.
async function extractSparse(vfile, ctx) {
  let reader;
  try {
    reader = await SparseReader.open(vfile.asSource(), 0);
  } catch (err) {
    ctx.warnings.push({ tool: "sparse", message: `sparse extraction failed for ${vfile.name}: ${err.message}` });
    return null;
  }
  const dir = ctx.newWorkdir("sparse");
  const inner = detect(await reader.read(0, Math.min(MAGIC_MAX, reader.size)), "");
  if (inner === "ext4") return placeTree(dir, new Ext4Image(reader), "ext4", ctx);
  if (inner === "fat" || inner === "fat_or_mbr") return placeTree(dir, new Fat16Image(reader), inner, ctx);
  const rawName = `${pyStem(vfile.name) || "inner"}.raw`;
  dir.addFile(rawName, new VFile(rawName, () => streamSource(reader), reader.size, { source: reader, offset: 0, size: reader.size }));
  return dir;
}

// Reads a whole source into memory (used for raw sparse fallbacks that are
// small enough to unwrap further).
async function streamSource(source) {
  const out = new Uint8Array(source.size);
  let done = 0;
  while (done < source.size) {
    const n = Math.min(1 << 22, source.size - done);
    out.set(await source.read(done, n), done);
    done += n;
  }
  return out;
}

// extract_fat/fat_or_mbr (:646-647 as in-house FAT walk instead of 7z).
async function extractFat(vfile, tag, ctx) {
  const dir = ctx.newWorkdir(tag);
  return placeTree(dir, new Fat16Image(vfile.asSource()), tag, ctx);
}

// extract_ext4 (:322-332 as in-house walk instead of debugfs).
async function extractExt4(vfile, ctx) {
  const dir = ctx.newWorkdir("ext4");
  return placeTree(dir, new Ext4Image(vfile.asSource()), "ext4", ctx);
}

// extract_gzip (:366-374): output file named <stem or inner.bin> inside the
// gzip workdir; the FILE is returned so unwrap recurses into it (the workdir
// itself is not an output, exactly like Python).
async function extractGzip(vfile, ctx) {
  try {
    const data = await gunzipStream(await vfile.read());
    const name = `${pyStem(vfile.name) || "inner.bin"}`;
    const dir = ctx.newWorkdir("gzip");
    const out = VFile.mem(name, data);
    dir.addFile(name, out);
    vfile.release();
    return out;
  } catch (err) {
    ctx.warnings.push({ tool: "gzip", message: `gzip decompress failed for ${vfile.name}: ${err.message}` });
    return null;
  }
}

// Multi-member tolerant gzip via DecompressionStream ("gzip" handles
// concatenated members like the gzip module does).
async function gunzipStream(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// extract_lz4 (:414-432) via the in-house frame decoder. Memory: the Samsung
// member is 101,488,514 bytes compressed and 199,233,005 bytes (~190MB) out,
// and extract_tar materializes the compressed member eagerly - so once the
// lz4 output exists the consumed member is released (VFile.release) and the
// steady state carries the decompressed output only. Measured on the real
// CP_F976...tar.md5 with /usr/bin/time -v over scanSource: peak RSS
// 610,924-672,840 KiB before the release, 498,956-560,152 KiB after (the
// released member is provably collected: external memory after the scan
// drops ~97MB); the remaining peak is the compressed+decompressed decode
// overlap plus the analyzer's record-parsing heap, not container retention.
// (The radio.img sparse is NOT materialized at all - SparseReader resolves
// it chunk-wise.)
async function extractLz4(vfile, ctx) {
  try {
    const data = decompressLz4Frame(await vfile.read());
    const name = `${pyStem(vfile.name) || "inner.bin"}`;
    const dir = ctx.newWorkdir("lz4");
    const out = VFile.mem(name, data);
    dir.addFile(name, out);
    vfile.release();
    return out;
  } catch (err) {
    ctx.warnings.push({ tool: "lz4", message: `lz4 decompress failed for ${vfile.name}: ${err.message}` });
    return null;
  }
}

// extract_tar (:435-446): ustar reader with GNU longname and POSIX PAX
// ('x'/'g') path-override support; extraction failure (bad paths, truncation)
// returns null like the caught TarError.
// Samsung .tar.md5: everything after the 1024-byte end marker (the md5 tail)
// is ignored, matching tarfile which stops at the end-of-archive marker.
async function extractTar(vfile, ctx) {
  const out = ctx.newWorkdir("tar");
  try {
    const source = vfile.asSource();
    let pos = 0;
    let pendingName = null;
    let pendingPax = null;
    const globalPax = new Map();
    for (;;) {
      const header = await source.read(pos, 512);
      if (isZeroBlock(header)) break;
      const name = readTarString(header, 0, 100);
      const prefix = readTarString(header, 345, 155);
      const size = readTarSize(header, 124);
      const type = String.fromCharCode(header[156]);
      pos += 512;
      if (type === "L") {
        // GNU long name: the data holds the next member's name.
        pendingName = latinish(await source.read(pos, size));
        pos += Math.ceil(size / 512) * 512;
        continue;
      }
      if (type === "x" || type === "g") {
        // POSIX extended headers: 'x' overrides the NEXT member, 'g' sets
        // defaults for every following one; tarfile merges global + per-member
        // records with the per-member value winning.
        const records = parsePaxRecords(await source.read(pos, size));
        if (type === "x") {
          if (pendingPax === null) pendingPax = new Map();
          for (const [key, value] of records) pendingPax.set(key, value);
        } else {
          for (const [key, value] of records) globalPax.set(key, value);
        }
        pos += Math.ceil(size / 512) * 512;
        continue;
      }
      const pax = new Map(globalPax);
      if (pendingPax !== null) for (const [key, value] of pendingPax) pax.set(key, value);
      pendingPax = null;
      // tarfile applies pax 'path' over the ustar name (GNU longnames fill the
      // name field first, so the override wins there too).
      const ustarName = pendingName ?? (prefix ? `${prefix}/${name}` : name);
      pendingName = null;
      const memberName = tarMemberPath(pax.get("path") ?? ustarName);
      if (type === "0" || type === "\0") {
        out.addFile(memberName, VFile.mem(memberName.split("/").pop(), await source.read(pos, size)));
      } else if (type === "5") {
        let dir = out;
        for (const part of memberName.split("/")) dir = dir.dir(part);
      }
      pos += Math.ceil(size / 512) * 512;
    }
    return out;
  } catch (err) {
    ctx.warnings.push({ tool: "tar", message: `tar extract failed for ${vfile.name}: ${err.message}` });
    return null;
  }
}

// tarfile's filter="data": absolute paths and ".." escape attempts raise,
// failing the whole extraction; "./" segments are normalized away.
function tarMemberPath(name) {
  if (name.startsWith("/")) throw new Error(`tar member path is absolute: ${name}`);
  const parts = [];
  for (const part of name.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`tar member path escapes the destination: ${name}`);
    parts.push(part);
  }
  return parts.join("/");
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function readTarString(header, off, len) {
  let end = off;
  const limit = off + len;
  while (end < limit && header[end] !== 0) end++;
  return String.fromCharCode(...header.subarray(off, end)).trimEnd();
}

// tarfile.nti tolerance: NUL/space-padded octal - leading padding is stripped
// before the digits (Python does nts() then int(s.strip() or "0", 8)), and
// any non-octal remainder raises like tarfile's InvalidHeaderError (GNU
// base-256 sizes, the documented gap, land there too instead of parsing as
// garbage octal).
function readTarSize(header, off) {
  let i = 0;
  while (i < 12 && (header[off + i] === 0 || header[off + i] === 0x20)) i++;
  let size = 0;
  for (; i < 12; i++) {
    const c = header[off + i];
    if (c === 0 || c === 0x20) break;
    if (c < 0x30 || c > 0x37) throw new Error(`tar size field at ${off} is not octal`);
    size = size * 8 + (c - 0x30);
  }
  return size;
}

// POSIX PAX record payload: "<len> key=value\n" repeated, len counting from
// the first digit through the trailing newline. Malformed records stop the
// scan (a raise here would fail the whole tar where tarfile raises
// ReadError; the corpus carries only well-formed headers).
function parsePaxRecords(u8) {
  const records = new Map();
  let pos = 0;
  while (pos < u8.length) {
    let space = pos;
    while (space < u8.length && u8[space] !== 0x20) space++;
    if (space === pos || space >= u8.length) break;
    const len = parseInt(latinish(u8.subarray(pos, space)), 10);
    if (!Number.isInteger(len) || len <= space - pos || pos + len > u8.length) break;
    const record = latinish(u8.subarray(space + 1, pos + len));
    const eq = record.indexOf("=");
    if (eq > 0) {
      const value = record.slice(eq + 1);
      records.set(record.slice(0, eq), value.endsWith("\n") ? value.slice(0, -1) : value);
    }
    pos += len;
  }
  return records;
}

function latinish(u8) {
  return String.fromCharCode(...u8.subarray(0, u8.length)).replace(/\0+$/, "");
}

// extract_zip (:603-634): central-directory read; when .bbfw members exist
// only those are extracted (IPSW shape), otherwise the full archive.
async function extractZip(vfile, ctx) {
  const out = ctx.newWorkdir("zip");
  try {
    const source = vfile.asSource();
    const entries = await zipEntries(source);
    const basebands = entries.filter((e) => e.name.toLowerCase().endsWith(".bbfw"));
    const selected = basebands.length ? basebands : entries;
    for (const entry of selected) {
      // Python zipfile refuses encrypted members (RuntimeError, password
      // required for extraction); never emit ciphertext as payload.
      if (entry.flags & 0x1) {
        ctx.warnings.push({ tool: "zip", message: `${entry.name}: encrypted zip member skipped, password required for extraction` });
        continue;
      }
      const data = await zipEntryData(source, entry);
      const path = zipMemberPath(entry.name);
      if (!path) continue; // directory entries
      out.addFile(path, VFile.mem(path.split("/").pop(), data));
    }
    return out;
  } catch (err) {
    ctx.warnings.push({ tool: "zip", message: `zip extraction failed for ${vfile.name}: ${err.message}` });
    return null;
  }
}

// zipfile.extract sanitizes by DROpping "", ".", ".." segments (unlike tar's
// data filter, which raises). Returns "" for pure-directory entries.
function zipMemberPath(name) {
  const parts = [];
  for (const part of name.split("/")) {
    if (!part || part === "." || part === "..") continue;
    parts.push(part);
  }
  return parts.join("/");
}

// EOCD + central directory (with zip64 fallbacks; per-entry inflate happens
// in zipEntryData so only requested members are ever decompressed).
// Exported for apple_ftab.js's bbfw member walk (same central-directory read
// as extract_zip — one implementation, no divergence).
export async function zipEntries(source) {
  const maxComment = 22 + 65535;
  const tailSize = Math.min(maxComment, source.size);
  const tail = await source.read(source.size - tailSize, tailSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("zip end-of-central-directory not found");
  let entryCount = tail[eocd + 10] | (tail[eocd + 11] << 8);
  let cdStart = u32leAt(tail, eocd + 16);
  // zip64 locator sits 20 bytes before the EOCD; its values win when present.
  if (eocd >= 20 && tail[eocd - 20] === 0x50 && tail[eocd - 19] === 0x4b && tail[eocd - 18] === 0x06 && tail[eocd - 17] === 0x07) {
    const z64 = u64leAt(tail, eocd - 20 + 8);
    const z64Block = await source.read(z64, 56);
    if (u32leAt(z64Block, 0) === 0x06064b50) {
      entryCount = u64leAt(z64Block, 32);
      cdStart = u64leAt(z64Block, 48);
    }
  }
  return zipDirectory(source, cdStart, entryCount);
}

async function zipDirectory(source, start, entryCount) {
  const entries = [];
  let pos = start;
  for (let i = 0; i < entryCount; i++) {
    const h = await source.read(pos, 46);
    if (u32leAt(h, 0) !== 0x02014b50) throw new Error(`corrupt central directory at ${pos}`);
    const flags = h[8] | (h[9] << 8);
    const method = h[10] | (h[11] << 8);
    let compressedSize = u32leAt(h, 20);
    let uncompressedSize = u32leAt(h, 24);
    let localOffset = u32leAt(h, 42);
    const nameLen = h[28] | (h[29] << 8);
    const extraLen = h[30] | (h[31] << 8);
    const name = latinish(await source.read(pos + 46, nameLen));
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      // zip64 extra field (header id 0x0001) overrides the u32 fields. APPNOTE
      // 4.5.3 fixes the slot order - original (uncompressed) size, compressed
      // size, local header offset, disk start - and a slot exists only when
      // its u32 field carries the 0xFFFFFFFF sentinel.
      const extra = await source.read(pos + 46 + nameLen, extraLen);
      let e = 0;
      while (e + 4 <= extra.length) {
        const id = extra[e] | (extra[e + 1] << 8);
        const sz = extra[e + 2] | (extra[e + 3] << 8);
        if (id === 0x0001) {
          let f = e + 4;
          const end = e + 4 + sz;
          if (uncompressedSize === 0xffffffff && f + 8 <= end) {
            uncompressedSize = u64leAt(extra, f);
            f += 8;
          }
          if (compressedSize === 0xffffffff && f + 8 <= end) {
            compressedSize = u64leAt(extra, f);
            f += 8;
          }
          if (localOffset === 0xffffffff && f + 8 <= end) localOffset = u64leAt(extra, f);
          break;
        }
        e += 4 + sz;
      }
    }
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    pos += 46 + nameLen + extraLen;
  }
  return entries;
}

// Node's handle.read/slice length is a native call: a >=2GiB length aborts the
// process uncatchably, so declared member sizes beyond this cap must throw a
// catchable ExtractionError before any data is read.
const MAX_ZIP_ENTRY_BYTES = 2 ** 31 - 1;

// Exported for apple_ftab.js's bbfw member walk (see zipEntries above).
export async function zipEntryData(source, entry) {
  if (entry.compressedSize > MAX_ZIP_ENTRY_BYTES || entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new ExtractionError(`${entry.name}: zip member size ${entry.compressedSize}/${entry.uncompressedSize} exceeds the 2GiB extraction cap`);
  }
  const h = await source.read(entry.localOffset, 30);
  if (u32leAt(h, 0) !== 0x04034b50) throw new Error(`corrupt local header for ${entry.name}`);
  const nameLen = h[26] | (h[27] << 8);
  const extraLen = h[28] | (h[29] << 8);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const compressed = await source.read(dataStart, entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateSync(compressed);
  throw new Error(`unsupported zip method ${entry.method} for ${entry.name}`);
}

// Unsigned little-endian reads; results are exact doubles up to 2^53, so
// composing u32 pairs into u64 (u64leAt) is safe for any zip64 offset.
function u32leAt(u8, off) {
  return u8[off] + u8[off + 1] * 0x100 + u8[off + 2] * 0x10000 + u8[off + 3] * 0x1000000;
}

function u64leAt(u8, off) {
  // lo is unsigned since u32leAt stopped using the int32 `|` coercion; the
  // sum stays exact in doubles (zip64 offsets are far below 2^53).
  const lo = u32leAt(u8, off);
  const hi = u32leAt(u8, off + 4);
  return hi * 0x100000000 + lo;
}

// extract_bbcfg (:523-600): iphone card recovery + the EFS pathname scan.
async function extractBbcfg(vfile, ctx) {
  const out = ctx.newWorkdir("bbcfg");
  const blob = await vfile.read();
  let cards = [];
  try {
    cards = await extractBbcfgTree(blob, out, (dir, path, data, size, kind) => ctx.addFile(dir, path, data, size, kind));
  } catch (err) {
    ctx.warnings.push({ tool: "bbcfg", message: `iPhone RF card recovery failed for ${vfile.name}: ${err.message}` });
  }
  let written = 0;
  try {
    written = extractEfsPathnames(blob, out, (dir, path, data) => ctx.addFile(dir, path, data));
  } catch (err) {
    ctx.warnings.push({ tool: "bbcfg", message: `bbcfg EFS scan failed for ${vfile.name}: ${err.message}` });
  }
  return cards.length || written ? out : null;
}

// --- public API -----------------------------------------------------------------------

// scan_container (:777-805): recursively unwrap and return the virtual tree.
// Hard failures (not a file-like source, below the size floor) throw like
// ExtractionError; per-container problems accumulate in warnings.
export async function extractContainer(source, name) {
  if (typeof source.size !== "number") throw new ExtractionError(`Not a readable source: ${name}`);
  if (source.size < MIN_CONTAINER_SIZE) {
    throw new ExtractionError(`File too small to be a container: ${name}`);
  }
  const ctx = new ExtractContext();
  await unwrap(VFile.slice(name, source, 0, source.size), ctx);
  return { root: ctx.root, outputs: ctx.outputs, warnings: ctx.warnings };
}

// discover_candidates (:752-770): over the registered output workdirs ONLY
// (Python iterates ctx.outputs; intermediate file staging dirs like gzip_xxx/
// are never discovered).
export function discoverCandidates(outputs) {
  const mbns = [];
  const sidecars = [];
  const files = outputs.flatMap((dir) => dir.files(`${dir.name}/`));
  for (const { vfile, path } of files) {
    if (RFCARD_RE.test(vfile.name)) mbns.push({ vfile, path });
    else if (SIDECAR_RES.some((re) => re.test(vfile.name))) sidecars.push({ name: vfile.name, path });
  }
  return { mbns, sidecars };
}

// sidecars_in_directory (:773-775): {name: virtual path} for sidecars sharing
// the MBN's directory (Python maps name -> absolute scratch path; the browser
// has no paths, so the virtual tree path stands in).
export function sidecarsInDirectory(mbnPath, sidecars) {
  const parent = mbnPath.slice(0, mbnPath.lastIndexOf("/"));
  const out = {};
  for (const sidecar of sidecars) {
    if (sidecar.path.slice(0, sidecar.path.lastIndexOf("/")) === parent) out[sidecar.name] = sidecar.path;
  }
  return out;
}
