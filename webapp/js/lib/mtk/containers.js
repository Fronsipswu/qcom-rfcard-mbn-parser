// Port of mtk-drdi-combo-parser/mtk_containers.py: read-only, bounded MTK
// modem-container unwrapping into {rom, drdi, drdi_data}. Recognizes MTK
// partition headers, HBLR, extent-based ext4, Android sparse, single-stream
// gzip, and sets of extracted parts. Works on in-memory Uint8Arrays like the
// Python unwrap_bytes; validation rules and error texts follow the original.
//
// Browser deviations (documented, not silent):
// - xz layers raise an UnwrapError: browsers ship no xz decoder and none of the
//   sample firmware uses xz.
// - A "directory" is a set of files from one import, grouped by folder path
//   (webkitRelativePath) - the closest browser equivalent of unwrap_path(dir).
import { gunzipSync } from "../../../lib/vendor/fflate.js";
import { sha256HexAsync } from "../hash.js";

export const MTK_MAGIC = [0x88, 0x16, 0x88, 0x58];
const SPARSE_MAGIC = [0x3a, 0xff, 0x26, 0xed];
const ROLE_RE = /(?:^|[_\-.])(md1drdi_hdr|md1drdi_data|md1drdi|md1rom)(?=$|[.\-_])/i;

export class UnwrapError extends Error {
  constructor(message, report = {}) {
    super(message);
    this.name = "UnwrapError";
    this.report = report;
  }
}

export const DEFAULT_LIMITS = Object.freeze({
  max_layer_bytes: 1024 * 1024 * 1024,
  max_total_bytes: 3 * 1024 * 1024 * 1024,
  max_depth: 12,
  max_entries: 4096,
});

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const startsWith = (d, sig) => d.length >= sig.length && sig.every((b, i) => d[i] === b);

export function roleOf(name) {
  const m = ROLE_RE.exec(name.split("/").pop());
  return m ? m[1].toLowerCase() : null;
}

function kindOf(data) {
  if (startsWith(data, SPARSE_MAGIC)) return "android-sparse";
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  if (startsWith(data, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz";
  if (startsWith(data, [0x48, 0x42, 0x4c, 0x52])) return "hblr";
  if (data.length >= 1082 && data[1080] === 0x53 && data[1081] === 0xef) return "ext4";
  if (startsWith(data, MTK_MAGIC)) return "mtk";
  return null;
}

// bytes.find for a short needle, using the native single-byte indexOf.
export function findBytes(hay, needle, from = 0) {
  const first = needle[0];
  const n = needle.length;
  let i = hay.indexOf(first, from);
  while (i !== -1 && i <= hay.length - n) {
    let k = 1;
    while (k < n && hay[i + k] === needle[k]) k++;
    if (k === n) return i;
    i = hay.indexOf(first, i + 1);
  }
  return -1;
}

const asciiZ = (bytes) => {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  let s = "";
  for (let i = 0; i < end; i++) {
    if (bytes[i] > 0x7f) throw new UnwrapError("non-ASCII member name");
    s += String.fromCharCode(bytes[i]);
  }
  return s;
};

const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

let CRC_TABLE = null;
function crc32(data, crc = 0) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class Ext4 {
  // Extent/inode traversal only; deliberately not a filesystem repair tool.
  constructor(data, owner) {
    this.data = data;
    this.owner = owner;
    if (data.length < 2048) throw new UnwrapError("truncated ext4 superblock");
    const incompat = u32(data, 1120);
    const allowed = 0x2 | 0x40 | 0x80 | 0x200 | 0x2000; // filetype, extents, 64bit, flex_bg, csum_seed
    if (incompat & ~allowed) throw new UnwrapError(`unsupported ext4 incompat features 0x${(incompat & ~allowed).toString(16)}`);
    const exponent = u32(data, 1048);
    if (exponent > 5) throw new UnwrapError("unsupported ext4 block size (maximum 32 KiB)");
    this.block = 1024 * 2 ** exponent;
    const blocks = u32(data, 1028) + (incompat & 0x80 ? u32(data, 1360) * 2 ** 32 : 0);
    if (blocks * this.block > data.length || !blocks) throw new UnwrapError("ext4 declared filesystem extends beyond input");
    this.end = blocks * this.block;
    this.inodes = u32(data, 1024);
    this.ipg = u32(data, 1064);
    this.isize = u16(data, 1112);
    this.dsize = incompat & 0x80 ? u16(data, 1278) : 32;
    if (!this.ipg || !this.inodes || !(this.isize >= 128 && this.isize <= this.block) || this.isize % 4
        || !(this.dsize >= 32 && this.dsize <= this.block) || this.dsize % 8) {
      throw new UnwrapError("invalid ext4 inode/group descriptor geometry");
    }
    if (incompat & 0x80 && this.dsize < 64) throw new UnwrapError("64-bit ext4 needs 64-byte group descriptors");
    this.gdt = (u32(data, 1044) + 1) * this.block;
    this.filetype = Boolean(incompat & 2);
  }

  inode(number) {
    if (!(number >= 1 && number <= this.inodes)) throw new UnwrapError(`ext4 inode ${number} is outside the inode table`);
    const group = Math.floor((number - 1) / this.ipg);
    const index = (number - 1) % this.ipg;
    const gd = this.gdt + group * this.dsize;
    if (gd + this.dsize > this.end) throw new UnwrapError("ext4 group descriptor outside filesystem");
    let block = u32(this.data, gd + 8);
    if (this.dsize >= 64) block += u32(this.data, gd + 40) * 2 ** 32;
    const off = block * this.block + index * this.isize;
    if (!block || off + this.isize > this.end) throw new UnwrapError("ext4 inode outside filesystem");
    return this.data.subarray(off, off + this.isize);
  }

  contents(inode) {
    const size = u32(inode, 4) + u32(inode, 108) * 2 ** 32;
    this.owner.charge(size);
    if (!(u32(inode, 32) & 0x80000)) {
      if (size === 0) return new Uint8Array(0);
      throw new UnwrapError("ext4 inode needs extents; inline/indirect blocks are unsupported");
    }
    const extents = [];
    const seen = new Set();
    const visit = (node, expected) => {
      this.owner.entry();
      if (node.length < 12 || u16(node, 0) !== 0xf30a) throw new UnwrapError("invalid ext4 extent header");
      const n = u16(node, 2), capacity = u16(node, 4), depth = u16(node, 6);
      if (n > capacity || 12 + capacity * 12 > node.length || depth > 5 || (expected !== undefined && depth !== expected)) {
        throw new UnwrapError("invalid ext4 extent count/depth");
      }
      let lastKey = -1;
      for (let i = 0; i < n; i++) {
        const off = 12 + i * 12;
        const logical = u32(node, off);
        if (logical <= lastKey) throw new UnwrapError("unordered ext4 extent keys");
        lastKey = logical;
        if (depth) {
          const physical = u32(node, off + 4) + u16(node, off + 8) * 2 ** 32;
          if (seen.has(physical)) throw new UnwrapError("cyclic/shared ext4 extent node");
          seen.add(physical);
          const disk = physical * this.block;
          if (!physical || disk + this.block > this.end) throw new UnwrapError("ext4 extent node outside filesystem");
          visit(this.data.subarray(disk, disk + this.block), depth - 1);
        } else {
          const raw = u16(node, off + 4);
          const count = raw > 32768 ? raw - 32768 : raw;
          const physical = u32(node, off + 8) + u16(node, off + 6) * 2 ** 32;
          if (!count || !physical || (physical + count) * this.block > this.end) throw new UnwrapError("invalid/out-of-range ext4 extent");
          extents.push([logical, physical, count, raw > 32768]);
        }
      }
    };
    visit(inode.subarray(40, 100));
    let end = 0;
    for (const [logical, , count] of extents) {
      if (logical < end) throw new UnwrapError("overlapping/unordered ext4 extents");
      end = logical + count;
    }
    const out = new Uint8Array(size);
    for (const [logical, physical, count, unwritten] of extents) {
      const dst = logical * this.block;
      const n = Math.min(count * this.block, Math.max(0, size - dst));
      if (n && !unwritten) {
        const src = physical * this.block;
        out.set(this.data.subarray(src, src + n), dst);
      }
    }
    return out;
  }

  // Yields [path, entriesFn] where entriesFn() lists [name, bytes] lazily (in
  // order), then recurses into child directories, mirroring the generator.
  *directories(number = 2, path = "", depth = 0, seen = new Set()) {
    this.owner.depth(depth);
    if (seen.has(number)) throw new UnwrapError("cyclic/shared ext4 directory");
    seen.add(number);
    const inode = this.inode(number);
    if ((u16(inode, 0) & 0xf000) !== 0x4000) throw new UnwrapError("ext4 directory entry does not reference a directory");
    const directory = this.contents(inode);
    const entries = [];
    const children = [];
    const names = new Set();
    let pos = 0;
    while (pos < directory.length) {
      this.owner.entry();
      if (pos + 8 > directory.length) throw new UnwrapError("truncated ext4 directory entry");
      const ino = u32(directory, pos);
      const rec = u16(directory, pos + 4);
      const n = this.filetype ? directory[pos + 6] : u16(directory, pos + 6);
      if (rec < 8 || rec % 4 || rec > this.block - (pos % this.block) || pos + rec > directory.length || n > rec - 8) {
        throw new UnwrapError("invalid ext4 directory entry length");
      }
      const raw = directory.subarray(pos + 8, pos + 8 + n);
      pos += rec;
      const isDot = (raw.length === 1 && raw[0] === 0x2e) || (raw.length === 2 && raw[0] === 0x2e && raw[1] === 0x2e);
      if (!ino || isDot) continue;
      const key = Array.from(raw).join(",");
      if (!raw.length || raw.includes(0x2f) || raw.includes(0) || names.has(key)) throw new UnwrapError("invalid/duplicate ext4 filename");
      names.add(key);
      const name = new TextDecoder("utf-8").decode(raw);
      const child = this.inode(ino);
      const mode = u16(child, 0) & 0xf000;
      if (mode === 0x4000) children.push([ino, `${path}${name}/`]);
      else if (mode === 0x8000) entries.push([name, child]);
      // Symlinks and special files are never followed.
    }
    const self = this;
    yield [path, function* entriesGen() {
      for (const [name, child] of entries) yield [name, self.contents(child)];
    }];
    for (const [ino, childpath] of children) yield* this.directories(ino, childpath, depth + 1, seen);
  }
}

class Unwrapper {
  constructor(limits) {
    this.limits = limits;
    this.total = 0;
    this.entries = 0;
    this.report = { layers: [], partial_sets: [], ignored: [] };
    this.bundles = [];
  }

  charge(size) {
    if (size < 0 || size > this.limits.max_layer_bytes || this.total + size > this.limits.max_total_bytes) {
      throw new UnwrapError(`unwrapping byte limit exceeded (requested ${size} bytes)`);
    }
    this.total += size;
  }

  entry() {
    this.entries += 1;
    if (this.entries > this.limits.max_entries) throw new UnwrapError("unwrapping entry limit exceeded");
  }

  depth(depth) {
    if (depth > this.limits.max_depth) throw new UnwrapError("unwrapping depth limit exceeded");
  }

  // A sibling collection is one namespace; never join parts across sets.
  collect(entries, source, depth) {
    this.depth(depth);
    const parts = new Map();
    const origins = new Map();
    for (const [name, raw] of entries) {
      let data = raw;
      this.entry();
      const role = roleOf(name);
      let path = `${source}!/${name}`;
      // Named raw parts are terminal unless they have an outer signature.
      let kind = kindOf(data);
      let layerDepth = depth + 1;
      while (kind === "gzip" || kind === "xz" || kind === "android-sparse") {
        this.depth(layerDepth);
        this.report.layers.push({ format: kind, source: path, bytes: data.length });
        data = this.expand(data, kind);
        path += `!/${kind}`;
        kind = kindOf(data);
        layerDepth += 1;
        this.depth(layerDepth);
      }
      if (role && kind === null) {
        if (parts.has(role) && !bytesEqual(parts.get(role), data)) throw new UnwrapError(`conflicting ${role} parts in ${source}`);
        parts.set(role, data);
        if (!origins.has(role)) origins.set(role, []);
        origins.get(role).push(path);
      } else {
        this.walk(data, path, layerDepth);
      }
    }
    if (!parts.size) return;
    const split = parts.has("md1drdi_hdr") && parts.has("md1drdi_data");
    if (parts.has("md1rom") && (parts.has("md1drdi") || split)) {
      if (parts.has("md1drdi") && (parts.has("md1drdi_hdr") || parts.has("md1drdi_data"))) {
        throw new UnwrapError(`both flat and split DRDI parts present in ${source}`);
      }
      const keys = split ? ["md1rom", "md1drdi_hdr", "md1drdi_data"] : ["md1rom", "md1drdi"];
      const selected = new Map(keys.map((k) => [k, parts.get(k)]));
      this.bundles.push([selected, origins, source]);
    } else {
      this.report.partial_sets.push({ source, parts: [...parts.keys()].sort() });
    }
  }

  expand(data, kind) {
    if (kind === "android-sparse") return this.sparse(data);
    if (kind === "xz") throw new UnwrapError("xz-compressed layers are not supported in the browser");
    const maximum = Math.min(this.limits.max_layer_bytes, this.limits.max_total_bytes - this.total);
    let out;
    try {
      out = gunzipSync(data);
    } catch (err) {
      throw new UnwrapError(`truncated or oversized gzip stream (${err.message})`);
    }
    if (out.length > maximum) throw new UnwrapError("truncated or oversized gzip stream");
    this.charge(out.length);
    return out;
  }

  sparse(data) {
    if (data.length < 28) throw new UnwrapError("truncated Android sparse header");
    const major = u16(data, 4), fh = u16(data, 8), ch = u16(data, 10);
    const block = u32(data, 12), blocks = u32(data, 16), chunks = u32(data, 20), checksum = u32(data, 24);
    if (major !== 1 || fh < 28 || ch < 12 || fh > data.length || !block || block % 4) {
      throw new UnwrapError("unsupported/invalid Android sparse geometry");
    }
    this.charge(blocks * block);
    const out = new Uint8Array(blocks * block);
    let pos = fh, cursor = 0, crc = 0;
    for (let c = 0; c < chunks; c++) {
      this.entry();
      if (pos + ch > data.length) throw new UnwrapError("truncated sparse chunk header");
      const kind = u16(data, pos), nblocks = u32(data, pos + 4), size = u32(data, pos + 8);
      if (size < ch || pos + size > data.length) throw new UnwrapError("invalid sparse chunk extent");
      const length = nblocks * block;
      if (cursor + length > out.length) throw new UnwrapError("sparse chunk exceeds declared output");
      const payload = data.subarray(pos + ch, pos + size);
      if (kind === 0xcac1 && payload.length === length) {
        out.set(payload, cursor);
      } else if (kind === 0xcac2 && payload.length === 4) {
        for (let k = 0; k < length; k += 4) out.set(payload, cursor + k);
      } else if (kind === 0xcac3 && payload.length === 0) {
        // Android specifies zero bytes for don't-care CRC calculation.
      } else if (kind === 0xcac4 && payload.length === 4 && nblocks === 0) {
        if (u32(payload, 0) !== crc) throw new UnwrapError("Android sparse chunk CRC32 mismatch");
      } else {
        throw new UnwrapError(`unsupported/malformed sparse chunk 0x${kind.toString(16)}`);
      }
      if (length) crc = crc32(out.subarray(cursor, cursor + length), crc);
      cursor += length;
      pos += size;
    }
    if (cursor !== out.length || pos !== data.length) throw new UnwrapError("sparse extent/input exhaustion failed");
    if (checksum && checksum !== crc) throw new UnwrapError("Android sparse image CRC32 mismatch");
    return out;
  }

  *hblr(data) {
    const layer = this.report.layers[this.report.layers.length - 1];
    layer.members = [];
    if (data.length < 64 || u32(data, 4) !== data.length) throw new UnwrapError("HBLR declared size mismatch");
    const count = u32(data, 48);
    const start = 64 + count * 48;
    if (!(count >= 1 && count <= 128) || start > data.length) throw new UnwrapError("invalid HBLR segment count");
    const names = new Set();
    const spans = [];
    const records = [];
    for (let i = 0; i < count; i++) {
      this.entry();
      const off = 64 + i * 48;
      if (!(data[off] === 0x53 && data[off + 1] === 0x45 && data[off + 2] === 0x47 && data[off + 3] === 0x4d)) {
        throw new UnwrapError("missing HBLR SEGM signature");
      }
      const name = asciiZ(data.subarray(off + 4, off + 36));
      const src = u32(data, off + 36), logical = u32(data, off + 40), stored = u32(data, off + 44);
      if (!name || names.has(name)) throw new UnwrapError("invalid/duplicate HBLR segment name");
      // HBLR may round stored extents up to 16 bytes; the extra bytes are padding.
      if (logical !== stored && stored !== Math.ceil(logical / 16) * 16) {
        throw new UnwrapError(`unsupported HBLR segment size relationship: ${name}`);
      }
      if (src < start || src + stored > data.length) throw new UnwrapError("HBLR segment outside container");
      names.add(name);
      spans.push([src, src + stored]);
      records.push([name, src, logical]);
      layer.members.push({ name, offset: src, bytes: logical, stored_bytes: stored, padding_bytes: stored - logical });
    }
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) throw new UnwrapError("overlapping HBLR segments");
    for (const [name, off, size] of records) {
      this.charge(size);
      yield [name, data.subarray(off, off + size)];
    }
  }

  *mtk(data) {
    const layer = this.report.layers[this.report.layers.length - 1];
    layer.members = [];
    let pos = 0;
    for (;;) {
      pos = findBytes(data, MTK_MAGIC, pos);
      if (pos < 0) break;
      this.entry();
      if (pos + 80 > data.length) break; // MTK_HEADER "<II32s10I" is 80 bytes
      // fields: [0]=magic [1]=size_lo [2]=name32 [3..12]=10 u32 at +40..+76
      if (u32(data, pos + 48) !== 0x58891689) { // fields[5]
        pos += 4;
        continue;
      }
      const name = asciiZ(data.subarray(pos + 8, pos + 40));
      const size = u32(data, pos + 4) + u32(data, pos + 72) * 2 ** 32; // fields[1] | fields[11] << 32
      const off = u32(data, pos + 52); // fields[6]
      if (!name || off < 512 || pos + off + size > data.length) {
        throw new UnwrapError(`invalid/truncated MTK partition at 0x${pos.toString(16)}`);
      }
      this.charge(size);
      layer.members.push({ name, header_offset: pos, offset: pos + off, bytes: size });
      yield [name, data.subarray(pos + off, pos + off + size)];
      pos += off + size; // inner containers are visited recursively, not carved twice
    }
  }

  walk(data, source, depth) {
    this.depth(depth);
    let kind = kindOf(data);
    if (kind === null && findBytes(data, MTK_MAGIC) >= 0) kind = "mtk";
    if (kind === null) {
      this.report.ignored.push({ source, bytes: data.length });
      return;
    }
    this.report.layers.push({ format: kind, source, bytes: data.length });
    if (kind === "gzip" || kind === "xz" || kind === "android-sparse") {
      this.walk(this.expand(data, kind), `${source}!/${kind}`, depth + 1);
    } else if (kind === "hblr") {
      this.collect(this.hblr(data), source, depth);
    } else if (kind === "mtk") {
      this.collect(this.mtk(data), source, depth);
    } else {
      const fs = new Ext4(data, this);
      this.report.layers[this.report.layers.length - 1].metadata_checksums_verified = false;
      for (const [path, entries] of fs.directories(2, "", depth)) {
        const containerPath = source + (path ? `!/${path.replace(/\/+$/, "")}` : "");
        this.collect(entries(), containerPath, depth + (path.split("/").length - 1) + 1);
      }
    }
  }

  // Directory equivalent: a list of {name, data} files sharing one folder,
  // sorted by name like sorted(path.iterdir()).
  directory(label, files, depth = 0) {
    this.depth(depth);
    this.report.layers.push({ format: "directory", source: label });
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const self = this;
    this.collect((function* entries() {
      for (const f of sorted) {
        self.entry();
        self.charge(f.data.length);
        yield [f.name, f.data];
      }
    })(), label, depth);
  }

  async finish() {
    const unique = new Map();
    for (const [parts, origins, source] of this.bundles) {
      const digests = [];
      for (const name of [...parts.keys()].sort()) digests.push([name, await sha256HexAsync(parts.get(name))]);
      const key = JSON.stringify(digests);
      if (!unique.has(key)) unique.set(key, { digests, copies: [] });
      unique.get(key).copies.push([parts, origins, source]);
    }
    this.report.candidate_sets = [...unique.values()].map(({ digests, copies }) => ({
      sources: copies.map((c) => c[2]), sha256: Object.fromEntries(digests),
    }));
    this.report.processed_bytes = this.total;
    if (!unique.size) {
      throw new UnwrapError("no complete modem set found (need md1rom and md1drdi, or md1rom and both split-CDF parts)");
    }
    if (unique.size !== 1) {
      throw new UnwrapError(`${unique.size} different modem sets found; pass the intended image or parts directory explicitly`);
    }
    const { digests, copies } = unique.values().next().value;
    const [parts, origins] = copies[0];
    const split = parts.has("md1drdi_hdr");
    const sha = Object.fromEntries(digests);
    const selected = {};
    for (const [name, data] of parts) selected[name] = { bytes: data.length, sha256: sha[name], sources: origins.get(name) };
    Object.assign(this.report, {
      packaging: split ? "tensor-split" : "single-drdi",
      selected,
      identical_sets: copies.length,
    });
    return {
      rom: parts.get("md1rom"),
      drdi: parts.get(split ? "md1drdi_hdr" : "md1drdi"),
      drdi_data: parts.get("md1drdi_data") ?? null,
      report: this.report,
    };
  }
}

async function run(action, limits) {
  const worker = new Unwrapper(limits);
  try {
    action(worker);
    return await worker.finish();
  } catch (err) {
    worker.report.error = err.message;
    if (err instanceof UnwrapError) {
      err.report = worker.report;
      throw err;
    }
    throw new UnwrapError(err.message, worker.report);
  }
}

// Unwrap one in-memory container. The name is provenance, not format selection.
export async function unwrapBytes(data, name = "image", { limits = DEFAULT_LIMITS } = {}) {
  return run((worker) => {
    worker.charge(data.length);
    worker.report.input = { source: String(name), bytes: data.length };
    worker.walk(data, String(name), 0);
  }, limits);
}

// Unwrap a set of extracted parts: [{name, data, dir?}] grouped by folder.
// Each folder is its own namespace (parts are never joined across folders),
// like unwrap_path(dir) with its recursive per-directory collect.
export async function unwrapFiles(files, label = "files", { limits = DEFAULT_LIMITS } = {}) {
  return run((worker) => {
    const byDir = new Map();
    for (const f of files) {
      const dir = f.dir ?? "";
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    const dirs = [...byDir.keys()].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
    for (const dir of dirs) {
      const depth = dir ? dir.split("/").length : 0;
      worker.directory(dir ? `${label}/${dir}` : label, byDir.get(dir), depth);
    }
  }, limits);
}
