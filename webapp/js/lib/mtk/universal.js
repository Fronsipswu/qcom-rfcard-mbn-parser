// Port of mtk-drdi-combo-parser/mtk_universal.py: ROM dictionary discovery, the
// grid / flat / split-CDF (Tensor) container loaders, the shared CandidateNode
// grammar, feature-table resolution and profile decoding. The NR15 loader lives
// in nr15.js and the Tensor secondary bank in tensor_secondary.js.
//
// The Python reference ran with numpy, so the vectorized scans are ported with
// numpy semantics (uint32 wraparound included); everything else keeps the
// pure-Python control flow, iteration order and tie-breaking. Supported-band
// discovery and report-only diagnostics are not ported: the webapp shows
// combinations, and those paths never change them.
import {
  Combo, NrCC, NrComponent, LteComponent, dedupExact, comboKey, classify,
} from "./export.js";
import { findBytes } from "./containers.js";

export const VA_LO = 0x60000000;
export const VA_HI = 0x80000000;

export const BW_FAMILIES = {
  modern20: [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 200, 400, 35, 45, 70, 90, 800, 1600, 2000],
  legacy14: [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 90, 100, 200, 400],
  nr15_13: [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 200, 400],
};
const LTE_WEIGHT_PREFIX = [1, 2, 2, 3, 4, 5];
const NR_WEIGHT_PREFIX = [1, 2, 2, 3, 4, 2, 3, 4, 5, 6, 7, 8];
const LTE_WEIGHTS_EXPECTED = [1, 2, 2, 3, 4, 5];
const BANDMAP_PREFIX = [...Array(49).keys(), 65, 66, 67, 68, 69, 70, 71];
const BANDMAP_LEN = 96;
const MAX_CLASS_WEIGHT = 32;
export const MAX_LTE_BAND = 90;
const FEATURE_SENTINEL = [0x03, 0x14, 0x01];
export const SCS = { 0: 15, 1: 30, 2: 60, 3: 120, 4: 240 };
export const DL_MIMO = { 0: 2, 1: 4, 2: 8 };
export const UL_MIMO = { 0: 1, 1: 2, 2: 4 };
export const LTE_UL_ABSENT = 6;
export const NR_UL_ABSENT_CANON = 0x1c;

export class UniversalError extends Error {
  constructor(message) {
    super(message);
    this.name = "UniversalError";
  }
}

export const u16 = (d, o) => d[o] | (d[o + 1] << 8);
export const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

export function packU32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

export function findAll(buf, pat, limit = null) {
  const out = [];
  let start = 0;
  for (;;) {
    const p = findBytes(buf, pat, start);
    if (p < 0) break;
    out.push(p);
    if (limit !== null && out.length >= limit) break;
    start = p + 1;
  }
  return out;
}

// bytes.count(pat, start, end): non-overlapping occurrences.
function countBytes(buf, pat, start, end) {
  const view = buf.subarray(start, end);
  let n = 0;
  let p = 0;
  for (;;) {
    p = findBytes(view, pat, p);
    if (p < 0) return n;
    n++;
    p += pat.length;
  }
}

// np.frombuffer(buf, "<u4", count=len//4): little-endian words from offset.
export function wordsOf(buf, offset = 0, count = Math.floor((buf.length - offset) / 4)) {
  if (count <= 0) return new Uint32Array(0);
  if ((buf.byteOffset + offset) % 4 === 0) return new Uint32Array(buf.buffer, buf.byteOffset + offset, count);
  const copy = new Uint8Array(count * 4);
  copy.set(buf.subarray(offset, offset + count * 4));
  return new Uint32Array(copy.buffer);
}

export class Reporter {
  constructor() {
    this.issues = [];
  }
  info(code, message, ctx = {}) {
    this.issues.push({ level: "info", code, message, ctx });
  }
  warn(code, message, ctx = {}) {
    this.issues.push({ level: "warning", code, message, ctx });
  }
  fail(code, message, ctx = {}) {
    this.issues.push({ level: "error", code, message, ctx });
  }
  check(name, passed, data = {}) {
    if (!passed) throw new UniversalError(`check failed: ${name}: ${JSON.stringify(data)}`);
  }
}

// --- ROM dictionaries -------------------------------------------------------------

export class RomTables {
  constructor(bw, nrWeights, lteWeights, lteBandMap, bwOff, nrWeightsOff, lteWeightsOff, bandMapOff, bwFamily = "modern20") {
    this.bw = bw;
    this.nr_weights = nrWeights;
    this.lte_weights = lteWeights;
    this.lte_band_map = lteBandMap;
    this.bw_off = bwOff;
    this.nr_weights_off = nrWeightsOff;
    this.lte_weights_off = lteWeightsOff;
    this.band_map_off = bandMapOff;
    this.bw_family = bwFamily;
    // UL-class values meaning "no uplink": no weight in the NR class table.
    const absent = new Set();
    for (let v = 0; v < 256; v++) if (v >= nrWeights.length || nrWeights[v] === 0) absent.add(v);
    this.nr_ul_absent = absent;
  }
}

function packU16s(values) {
  const out = [];
  for (const v of values) out.push(v & 0xff, (v >> 8) & 0xff);
  return out;
}

function nr15Pattern() {
  const tbl = BW_FAMILIES.nr15_13;
  const pat = [];
  tbl.forEach((bw, i) => pat.push(i, 0, bw & 0xff, bw >> 8));
  pat.push(tbl.length, 0, 0, 0);
  return pat;
}

function bwSites(rom) {
  const out = [];
  for (const [fam, tbl] of Object.entries(BW_FAMILIES)) {
    const pat = packU16s(tbl);
    for (const o of findAll(rom, pat)) {
      // A short family must be terminated, else we would clip a longer table.
      if (tbl.length < 20) {
        if (o + pat.length + 2 > rom.length || u16(rom, o + pat.length) !== 0) continue;
      }
      out.push([fam, o, tbl]);
    }
  }
  if (!out.length) {
    const tbl = BW_FAMILIES.nr15_13;
    for (const o of findAll(rom, nr15Pattern())) out.push(["nr15_13", o, tbl]);
  }
  return out;
}

function readNrWeights(rom, off, cap = 96) {
  const vals = [];
  for (let i = 0; i < cap; i++) {
    if (off + i >= rom.length) break;
    const b = rom[off + i];
    if (b === 0xff || b > MAX_CLASS_WEIGHT) break;
    vals.push(b);
  }
  while (vals.length > NR_WEIGHT_PREFIX.length && vals[vals.length - 1] === 0) vals.pop();
  return vals;
}

function lteWeightSites(rom) {
  return findAll(rom, LTE_WEIGHT_PREFIX).filter((o) => o + 8 <= rom.length && rom[o + 6] === 0 && (rom[o + 7] === 0 || rom[o + 7] === 0xff));
}

function bandMapSites(rom) {
  return findAll(rom, BANDMAP_PREFIX).filter((o) => o + BANDMAP_LEN <= rom.length && (rom[o + BANDMAP_LEN - 1] === 0 || rom[o + BANDMAP_LEN - 1] === 0xff));
}

const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// min(seq, key=f): first minimal element.
function minBy(seq, f) {
  let best;
  let bestK;
  for (const x of seq) {
    const k = f(x);
    if (best === undefined || k < bestK) {
      best = x;
      bestK = k;
    }
  }
  return best;
}

export function discoverRomTables(rom, rep) {
  const bws = bwSites(rom);
  if (!bws.length) {
    throw new UniversalError(`no known MTK bandwidth enum found in md1rom. Known families: ${Object.entries(BW_FAMILIES).map(([k, v]) => `${k}(${v.length} entries)`).join(", ")}. A new family must be added explicitly rather than inferred.`);
  }
  const fams = new Set(bws.map((b) => b[0]));
  if (fams.size > 1) throw new UniversalError(`md1rom matches more than one bandwidth enum family: ${JSON.stringify([...fams].sort())}`);
  const maps = bandMapSites(rom);
  if (!maps.length) throw new UniversalError("no validated 96-byte LTE internal-band map found in md1rom");
  const ltes = lteWeightSites(rom);
  const nrs = new Set(findAll(rom, NR_WEIGHT_PREFIX));
  if (!nrs.size) throw new UniversalError("NR class-weight prefix 1,2,2,3,4,2,3,4,5,6,7,8 not found in md1rom");
  const errors = [];
  for (const [fam, bwOff, tbl] of bws) {
    const bwEnd = bwOff + 2 * tbl.length;
    let nrOff = null;
    const adj = ltes.filter((l) => nrs.has(l + 8));
    if (nrs.has(bwEnd)) nrOff = bwEnd;
    else if (adj.length === 1) nrOff = adj[0] + 8;
    else if (nrs.size === 1) nrOff = nrs.values().next().value;
    else if (adj.length) nrOff = minBy(adj, (l) => Math.abs(l - bwOff)) + 8;
    if (nrOff === null) {
      errors.push(`${fam}@0x${bwOff.toString(16)}: could not disambiguate ${nrs.size} NR class-weight candidates`);
      continue;
    }
    let lteOff;
    if (ltes.includes(nrOff - 8)) lteOff = nrOff - 8;
    else if (ltes.length === 1) lteOff = ltes[0];
    else if (ltes.length) lteOff = minBy(ltes, (o) => Math.abs(o - bwOff));
    else {
      errors.push(`${fam}@0x${bwOff.toString(16)}: no validated LTE class-weight table`);
      continue;
    }
    const nrw = readNrWeights(rom, nrOff);
    const ltew = Array.from(rom.subarray(lteOff, lteOff + 6));
    if (nrw.length < NR_WEIGHT_PREFIX.length || !arrEq(nrw.slice(0, NR_WEIGHT_PREFIX.length), NR_WEIGHT_PREFIX)) {
      errors.push(`${fam}@0x${bwOff.toString(16)}: NR weights failed prefix validation`);
      continue;
    }
    if (!arrEq(ltew, LTE_WEIGHTS_EXPECTED)) {
      errors.push(`${fam}@0x${bwOff.toString(16)}: LTE class weights invalid`);
      continue;
    }
    // sorted(maps, key=abs distance): stable.
    const ordered = [...maps].sort((a, b) => Math.abs(a - bwOff) - Math.abs(b - bwOff));
    const mapOff = ordered[0];
    const bandmap = Array.from(rom.subarray(mapOff, mapOff + BANDMAP_LEN));
    rep.info("rom_tables", "discovered and validated ROM dictionaries", { bw_family: fam });
    return new RomTables([...tbl], nrw, ltew, bandmap, bwOff, nrOff, lteOff, mapOff, fam);
  }
  throw new UniversalError(`no bandwidth-enum site produced a complete dictionary: ${errors.join("; ")}`);
}

// --- images / banks ------------------------------------------------------------------

export class Image {
  constructor({ bank_va, profile, source_offset, length, relocation, drdi, label = "", alias = 0, candidate_hint = null }) {
    this.bank_va = bank_va;
    this.profile = profile;
    this.source_offset = source_offset;
    this.length = length;
    this.relocation = relocation;
    this.drdi = drdi;
    this.label = label;
    this.alias = alias;
    this.candidate_hint = candidate_hint;
  }
  get end_source() {
    return this.source_offset + this.length;
  }
  get end_va() {
    return this.bank_va + this.length;
  }
  resolve(va, size = 1) {
    const raw = this.alias && va >= this.alias ? va - this.alias : va;
    const off = raw - this.relocation;
    if (this.source_offset <= off && off + size <= this.end_source) return off;
    return null;
  }
  contains_va(va, size = 1) {
    return this.resolve(va, size) !== null;
  }
}

export class Bank {
  constructor(bank_va, images, table_index = -1) {
    this.bank_va = bank_va;
    this.images = images;
    this.table_index = table_index;
  }
}

export class BaseLoader {
  constructor(rom, drdi, rep) {
    this.rom = rom;
    this.drdi = drdi;
    this.rep = rep;
    this.tables = discoverRomTables(rom, rep);
    this.banks = [];
    this._candidate_arrays = new Map();
  }
  lte_tables(cap, rep) {
    return chooseLteBank(this, cap, rep);
  }
}

// --- grid loader ------------------------------------------------------------------------

export function gridDescriptorHits(rom, drdiLen) {
  const words = wordsOf(rom);
  const hits = [];
  for (let i = 0; i + 2 < words.length; i++) {
    const sf = words[i];
    if (sf >>> 28 !== 3) continue;
    const va = words[i + 1];
    const ln = words[i + 2];
    const src = sf & 0x0fffffff;
    if (ln >= 0x10 && ln <= 0x800000 && src + Math.min(ln, 0x800001) <= drdiLen && va >= VA_LO && va < VA_HI) {
      hits.push([i * 4, src, va, ln]);
    }
  }
  return hits;
}

export function denseScore(hits) {
  let last = -100;
  let run = 0;
  let best = 0;
  for (const [off] of hits) {
    run = off - last <= 0x40 ? run + 1 : 1;
    best = Math.max(best, run);
    last = off;
  }
  return best;
}

// GridLoader._discover, shared with the NR15 loader.
export function gridDiscover(loader, raw) {
  if (!raw.length) throw new UniversalError("no modern bank descriptors found");
  const clusters = [];
  let cur = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    if (b[0] - a[0] > 0 && b[0] - a[0] <= 0x40) cur.push(b);
    else {
      if (cur.length >= 4) clusters.push(cur);
      cur = [b];
    }
  }
  if (cur.length >= 4) clusters.push(cur);
  if (!clusters.length) throw new UniversalError("raw bank-descriptor hits did not form a coherent table");
  let table = clusters[0];
  for (const c of clusters) if (c.length > table.length) table = c;
  const byVa = new Map();
  for (const x of table) {
    if (!byVa.has(x[2])) byVa.set(x[2], []);
    byVa.get(x[2]).push(x);
  }
  // Counter(len).most_common(1): highest count, first inserted on ties.
  const counts = new Map();
  for (const v of byVa.values()) counts.set(v.length, (counts.get(v.length) || 0) + 1);
  let colCount;
  let freq = -1;
  for (const [len, n] of counts) if (n > freq) {
    colCount = len;
    freq = n;
  }
  const coherent = [...byVa.entries()].filter(([, xs]) => xs.length === colCount);
  if (coherent.length < 1) throw new UniversalError("descriptor table does not contain a coherent bank/profile matrix");
  loader.descriptor_table_off = table[0][0];
  loader.columns = colCount;
  loader.banks = [];
  const minOff = (xs) => Math.min(...xs.map((x) => x[0]));
  coherent.sort((a, b) => minOff(a[1]) - minOff(b[1]));
  coherent.forEach(([va, xsRaw], bi) => {
    const xs = [...xsRaw].sort((a, b) => a[0] - b[0]);
    const images = [];
    let seenStub = false;
    xs.forEach(([, src, , ln], pi) => {
      if (ln <= 0x40) {
        seenStub = true;
        return;
      }
      if (seenStub) throw new UniversalError(`bank 0x${va.toString(16)} has live profile ${pi} after a stub; descriptor geometry is likely wrong`);
      images.push(new Image({ bank_va: va, profile: pi, source_offset: src, length: ln, relocation: va - src, drdi: loader.drdi, label: `bank${bi}/profile${pi}` }));
    });
    loader.banks.push(new Bank(va, images, bi));
  });
}

export class GridLoader extends BaseLoader {
  constructor(rom, drdi, rep, descriptorHits = null) {
    super(rom, drdi, rep);
    this.name = "grid";
    gridDiscover(this, descriptorHits ?? gridDescriptorHits(rom, drdi.length));
  }

  capability_bank() {
    if (this._capability_bank) return this._capability_bank;
    const candidates = [];
    for (const b of this.banks) {
      if (!b.images.length) continue;
      let sent = 0;
      for (const im of b.images) sent += countBytes(this.drdi, FEATURE_SENTINEL, im.source_offset, im.end_source);
      const avg = b.images.reduce((n, i) => n + i.length, 0) / b.images.length;
      candidates.push([avg, sent, b]);
    }
    const parser = new GrammarParser(this, this.rep);
    // sorted(key=(bool(sent), avg, sent), reverse=True), stable.
    const keyCmp = (x, y) => (Number(Boolean(y[1])) - Number(Boolean(x[1]))) || (y[0] - x[0]) || (y[1] - x[1]);
    for (const [, , b] of [...candidates].sort(keyCmp)) {
      for (const im of b.images) {
        try {
          parser.find_candidate_array(im);
        } catch (err) {
          if (err instanceof UniversalError) continue;
          throw err;
        }
        this._capability_bank = b;
        return b;
      }
    }
    throw new UniversalError("no live grid bank contains a structurally valid CandidateNode array");
  }
}

// --- Tensor split-CDF loader ---------------------------------------------------------

function tensorSections(header) {
  const sections = [];
  for (let i = 0; i < 20; i++) sections.push([u32(header, 4 + i * 8), u32(header, 8 + i * 8)]);
  return sections;
}

export function tensorProbe(header) {
  if (header.length !== 0x30000) return false;
  const s = tensorSections(header);
  return s[0][1] === 641 * 4 && s[1][1] === 11 * 4 && s[2][1] === 640 * 48
    && s.slice(0, 3).every(([off, size]) => off >= 164 && off <= header.length && size <= header.length - off);
}

async function sha384(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-384", bytes));
}

export class TensorCdfLoader extends BaseLoader {
  static ALIAS = 0x60000000;

  // Async factory: SHA-384 slot validation runs through WebCrypto.
  static async create(rom, header, data, rep) {
    if (!tensorProbe(header)) {
      throw new UniversalError("split-CDF header failed section geometry (expected 0x30000, 641 offsets, 11 bounds, 640 SHA-384 digests)");
    }
    const loader = new TensorCdfLoader(rom, header, data, rep);
    await loader._validate_slots();
    loader._build_banks();
    return loader;
  }

  constructor(rom, header, data, rep) {
    super(rom, data, rep);
    this.name = "tensor";
    this.ALIAS = TensorCdfLoader.ALIAS;
    this.header = header;
    this.sections = tensorSections(header);
    const [oo] = this.sections[0];
    this.slot_offsets = Array.from({ length: 641 }, (_, i) => u32(header, oo + 4 * i));
    const [bo] = this.sections[1];
    this.bank_bounds = Array.from({ length: 11 }, (_, i) => u32(header, bo + 4 * i));
  }

  async _validate_slots() {
    for (let i = 1; i < this.bank_bounds.length; i++) {
      if (this.bank_bounds[i - 1] >= this.bank_bounds[i]) throw new UniversalError("CDF bank bounds are not strictly increasing");
    }
    for (let i = 1; i < this.slot_offsets.length; i++) {
      if (this.slot_offsets[i - 1] > this.slot_offsets[i]) throw new UniversalError("CDF slot offsets are not monotone");
    }
    const last = this.slot_offsets[640];
    if (last > this.drdi.length) throw new UniversalError(`CDF final slot offset 0x${last.toString(16)} exceeds data size 0x${this.drdi.length.toString(16)}`);
    const [digestOff] = this.sections[2];
    let bad = 0;
    const jobs = [];
    for (let slot = 0; slot < 640; slot++) {
      jobs.push(sha384(this.drdi.subarray(this.slot_offsets[slot], this.slot_offsets[slot + 1])).then((d) => {
        const exp = this.header.subarray(digestOff + slot * 48, digestOff + (slot + 1) * 48);
        if (!arrEq(d, exp)) bad++;
      }));
    }
    await Promise.all(jobs);
    if (bad) throw new UniversalError(`CDF SHA-384 validation failed for ${bad}/640 slots`);
  }

  _build_banks() {
    const banks = [];
    for (let bi = 0; bi < 10; bi++) {
      const va = this.bank_bounds[bi];
      const images = [];
      let seenStub = false;
      for (let pi = 0; pi < 64; pi++) {
        const slot = bi * 64 + pi;
        const src = this.slot_offsets[slot];
        const ln = this.slot_offsets[slot + 1] - src;
        if (ln <= 0x40) {
          seenStub = true;
          continue;
        }
        if (seenStub) throw new UniversalError(`CDF bank ${bi} has live image after stub at profile ${pi}`);
        images.push(new Image({ bank_va: va, profile: pi, source_offset: src, length: ln, relocation: va - src, drdi: this.drdi, label: `cdf-bank${bi}/profile${pi}`, alias: this.ALIAS }));
      }
      banks.push(new Bank(va, images, bi));
    }
    this.banks = banks;
  }

  capability_bank() {
    if (this._capability_bank) return this._capability_bank;
    const parser = new GrammarParser(this, this.rep);
    const candidates = [];
    for (const b of this.banks) {
      const sentinelImages = b.images.filter((im) => findBytes(this.drdi.subarray(im.source_offset, im.end_source), FEATURE_SENTINEL) >= 0);
      if (!sentinelImages.length) continue;
      let bestCount = 0;
      for (const im of sentinelImages) {
        try {
          const [, , info] = parser.find_candidate_array(im);
          if (info.count > bestCount) bestCount = info.count;
        } catch (err) {
          if (!(err instanceof UniversalError)) throw err;
        }
      }
      if (bestCount) {
        const avg = b.images.reduce((n, i) => n + i.length, 0) / b.images.length;
        candidates.push([bestCount, avg, b]);
      }
    }
    if (!candidates.length) throw new UniversalError("no CDF bank containing feature sentinels also contains a 100%-valid CandidateNode array");
    // max(key=(count, avg)): first maximal.
    let best = candidates[0];
    for (const c of candidates) if (c[0] > best[0] || (c[0] === best[0] && c[1] > best[1])) best = c;
    this._capability_bank = best[2];
    return best[2];
  }
}

// --- flat (MD800) loader ------------------------------------------------------------------

function runsFromWords(words, minrun) {
  const out = [];
  let start = -1;
  let prev = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w >= VA_LO && w < VA_HI) {
      if (start < 0) start = i;
      else if (i !== prev + 1) {
        if (prev - start + 1 >= minrun) out.push([start * 4, prev - start + 1]);
        start = i;
      }
      prev = i;
    }
  }
  if (start >= 0 && prev - start + 1 >= minrun) out.push([start * 4, prev - start + 1]);
  return out;
}

export class FlatLoader extends BaseLoader {
  static MIN_ARRAY = 64;
  static SAMPLE = 48;
  static SAMPLE_RATE = 0.9;

  static probe(drdi) {
    return runsFromWords(wordsOf(drdi), FlatLoader.MIN_ARRAY).length;
  }

  constructor(rom, drdi, rep) {
    super(rom, drdi, rep);
    this.name = "flat";
    this._words = wordsOf(drdi);
    this.runs = runsFromWords(this._words, FlatLoader.MIN_ARRAY);
    this._discover();
  }

  _probe_image(reloc) {
    return new Image({ bank_va: reloc, profile: -1, source_offset: 0, length: this.drdi.length, relocation: reloc, drdi: this.drdi, label: "flat-probe" });
  }

  *_hypotheses(off, n) {
    const v0 = this._words[off / 4];
    for (const bias of [4, 0]) {
      const r = v0 - (off + 4 * n + bias);
      if (r > 0 && r < VA_HI && r + this.drdi.length < 2 ** 32) yield [r, bias];
    }
  }

  _discover() {
    const parser = new GrammarParser(this, this.rep);
    const found = [];
    for (const [off, n] of this.runs) {
      for (const [reloc, bias] of this._hypotheses(off, n)) {
        const im = this._probe_image(reloc);
        const k = Math.min(n, FlatLoader.SAMPLE);
        let ok = 0;
        for (let i = 0; i < k; i++) if (parser.parse_candidate_va(im, this._words[off / 4 + i]) !== null) ok++;
        if (ok >= k * FlatLoader.SAMPLE_RATE) {
          found.push({ array_off: off, count: n, relocation: reloc, bias, array_va: off + reloc });
          break;
        }
      }
    }
    if (!found.length) {
      throw new UniversalError(`flat loader found no pointer run whose adjacency-derived relocation yields structurally valid CandidateNodes (scanned ${this.runs.length} runs of >=${FlatLoader.MIN_ARRAY} words)`);
    }
    const [order, tableOff] = this._rom_profile_order(found.map((f) => f.array_va));
    if (order) {
      const rank = (f) => (order.has(f.array_va) ? order.get(f.array_va) : 10000);
      found.sort((a, b) => rank(a) - rank(b));
      for (const f of found) f.profile = order.has(f.array_va) ? order.get(f.array_va) : null;
    }
    const used = new Set();
    let nxt = Math.max(...found.map((f) => f.profile || 0)) + 1;
    for (const f of found) {
      let v = f.profile ?? null;
      if (v === null || used.has(v)) v = nxt++;
      used.add(v);
      f.profile = v;
    }
    const images = found.map((f) => new Image({
      bank_va: f.relocation, profile: f.profile, source_offset: 0, length: this.drdi.length,
      relocation: f.relocation, drdi: this.drdi, label: `flat/profile${f.profile}`, candidate_hint: [f.array_off, f.count],
    }));
    this.banks = [new Bank(Math.min(...found.map((f) => f.array_va)), images, 0)];
    this.discovery = found;
    this.rom_profile_table_off = tableOff;
  }

  _rom_profile_order(arrayVas) {
    // numpy: np.fromiter(sorted(want), "<u8").astype("<u4") wraps to 32 bits.
    const want = new Set(arrayVas.map((v) => v >>> 0));
    if (!want.size) return [null, null];
    const rw = wordsOf(this.rom);
    const idx = [];
    for (let i = 0; i < rw.length; i++) if (want.has(rw[i])) idx.push(i);
    if (!idx.length) return [null, null];
    let best = [0, 0, 0];
    let start = idx[0];
    let prev = idx[0];
    const seq = [...idx.slice(1), null];
    for (const z of seq) {
      if (z !== prev + 1) {
        const ln = prev - start + 1;
        if (ln > best[0]) best = [ln, start, prev];
        if (z === null) break;
        start = z;
      }
      prev = z;
    }
    const [ln, w0] = best;
    if (ln < 2) return [null, null];
    const order = new Map();
    for (let i = 0; i < ln; i++) {
      const va = rw[w0 + i];
      if (!order.has(va)) order.set(va, i);
    }
    return [order, w0 * 4];
  }

  capability_bank() {
    return this.banks[0];
  }

  lte_tables(cap, rep) {
    const chosen = [];
    for (const [off, n] of this.runs) {
      for (const [reloc] of this._hypotheses(off, n)) {
        const im = this._probe_image(reloc);
        for (const rowBias of [4, 0]) {
          let combos = [];
          let okall = true;
          const probe = Math.min(n, 32);
          for (let i = 0; i < probe; i++) {
            const base = im.resolve(this._words[off / 4 + i], 4);
            if (base === null || parseLteFields(im, base + rowBias, this.tables) === null) {
              okall = false;
              break;
            }
          }
          if (!okall) continue;
          for (let i = 0; i < n; i++) {
            const base = im.resolve(this._words[off / 4 + i], 4);
            const cb = base === null ? null : parseLteFields(im, base + rowBias, this.tables);
            if (cb === null) {
              combos = [];
              break;
            }
            combos.push(cb);
          }
          if (combos.length) {
            chosen.push({ array_off: off, rows: combos });
            break;
          }
        }
        if (chosen.length && chosen[chosen.length - 1].array_off === off) break;
      }
    }
    if (!chosen.length) {
      rep.warn("lte_table_missing", "flat loader found no fully valid LTE CA pointer array");
      return [null, new Map()];
    }
    chosen.sort((a, b) => b.rows.length - a.rows.length);
    const results = new Map();
    chosen.forEach((c, i) => results.set(i, c.rows));
    return [this.banks[0], results];
  }
}

// --- shared CandidateNode grammar ---------------------------------------------------------

export class RawDescriptor {
  constructor(count, records_ptr, variant_count, variant_ptr, records, units, fsc, is_nr) {
    this.count = count;
    this.records_ptr = records_ptr;
    this.variant_count = variant_count;
    this.variant_ptr = variant_ptr;
    this.records = records;
    this.units = units;
    this.fsc = fsc;
    this.is_nr = is_nr;
  }
  get variants() {
    return this.units ? Math.floor(this.variant_count / this.units) : 0;
  }
}

export class RawCandidate {
  constructor(va, meta0, meta1, lte, nr) {
    this.va = va;
    this.meta0 = meta0;
    this.meta1 = meta1;
    this.lte = lte;
    this.nr = nr;
  }
}

export class GrammarParser {
  constructor(loader, rep) {
    this.loader = loader;
    this.tables = loader.tables;
    this.rep = rep;
    this._descriptor_image = null;
    this._descriptors = new Map();
  }

  _parse_desc(im, ptr, nr, strictFsc = true) {
    if (this._descriptor_image !== im) {
      this._descriptors.clear();
      this._descriptor_image = im;
    }
    const key = `${ptr}|${nr}|${strictFsc}`;
    if (!this._descriptors.has(key)) this._descriptors.set(key, this._decode_desc(im, ptr, nr, strictFsc));
    return this._descriptors.get(key);
  }

  _decode_desc(im, ptr, nr, strictFsc = true) {
    const d = im.drdi;
    const t = this.tables;
    const doff = im.resolve(ptr, 16);
    if (doff === null) return null;
    const cnt = u32(d, doff), rp = u32(d, doff + 4), vc = u32(d, doff + 8), vp = u32(d, doff + 12);
    if (!(cnt >= 1 && cnt <= 16)) return null;
    const recsz = nr ? 4 : 3;
    const ro = im.resolve(rp, cnt * recsz);
    if (ro === null) return null;
    const records = [];
    let units = 0;
    let fs;
    if (nr) {
      for (let k = 0; k < cnt; k++) {
        const band = u16(d, ro + 4 * k), ul = d[ro + 4 * k + 2], dl = d[ro + 4 * k + 3];
        if (!(band >= 1 && band <= 1024)) return null;
        if (!(dl < t.nr_weights.length) || t.nr_weights[dl] <= 0) return null;
        if (!t.nr_ul_absent.has(ul)) {
          if (!(ul < t.nr_weights.length) || t.nr_weights[ul] <= 0) return null;
        }
        records.push([band, ul, dl]);
        units += t.nr_weights[dl];
      }
      fs = 3;
    } else {
      for (let k = 0; k < cnt; k++) {
        const idx = d[ro + 3 * k], ul = d[ro + 3 * k + 1], dl = d[ro + 3 * k + 2];
        if (!(idx < t.lte_band_map.length)) return null;
        const band = t.lte_band_map[idx];
        if (band === 0 || band > MAX_LTE_BAND) return null;
        if (!(dl < t.lte_weights.length) || t.lte_weights[dl] <= 0) return null;
        if (ul !== LTE_UL_ABSENT && !(ul < t.lte_weights.length)) return null;
        records.push([band, ul, dl]);
        units += t.lte_weights[dl];
      }
      fs = 2;
    }
    if (units <= 0 || vc <= 0 || vc % units !== 0) return null;
    const vo = im.resolve(vp, vc * fs);
    if (vo === null) return null;
    const fsc = [];
    if (nr) {
      for (let k = 0; k < vc; k++) {
        const scs = d[vo + 3 * k];
        if (strictFsc && !has(SCS, scs)) return null;
        fsc.push([scs, d[vo + 3 * k + 1], d[vo + 3 * k + 2]]);
      }
    } else {
      for (let k = 0; k < vc; k++) {
        const b1 = d[vo + 2 * k + 1];
        if (strictFsc && !(b1 <= 3)) return null;
        fsc.push([d[vo + 2 * k], b1]);
      }
    }
    return new RawDescriptor(cnt, rp, vc, vp, records, units, fsc, nr);
  }

  parse_candidate_va(im, va) {
    const o = im.resolve(va, 16);
    if (o === null) return null;
    const d = im.drdi;
    const meta0 = u32(d, o), meta1 = u32(d, o + 4), lp = u32(d, o + 8), nptr = u32(d, o + 12);
    const lte = lp ? this._parse_desc(im, lp, false) : null;
    const nr = nptr ? this._parse_desc(im, nptr, true) : null;
    if (lte === null && nr === null) return null;
    if (lp && im.contains_va(lp, 16) && lte === null) return null;
    if (nptr && im.contains_va(nptr, 16) && nr === null) return null;
    return new RawCandidate(va, meta0, meta1, lte, nr);
  }

  _pointer_runs(im, minrun = 4) {
    const n = Math.floor(im.length / 4);
    const arr = wordsOf(im.drdi, im.source_offset, n);
    const lo = im.bank_va + im.alias;
    const hi = im.bank_va + im.length + im.alias;
    const runs = [];
    let s = -1;
    let prev = -1;
    for (let i = 0; i < arr.length; i++) {
      const w = arr[i];
      if (w >= lo && w < hi) {
        if (s < 0) s = i;
        else if (i !== prev + 1) {
          if (prev - s + 1 >= minrun) runs.push([im.source_offset + s * 4, prev - s + 1]);
          s = i;
        }
        prev = i;
      }
    }
    if (s >= 0 && prev - s + 1 >= minrun) runs.push([im.source_offset + s * 4, prev - s + 1]);
    return runs;
  }

  _validate_run(im, off, n) {
    const validity = [];
    const parsed = [];
    for (let k = 0; k < n; k++) {
      const c = this.parse_candidate_va(im, u32(im.drdi, off + 4 * k));
      validity.push(c !== null);
      parsed.push(c);
    }
    validity.push(false);
    let best = null;
    let st = null;
    validity.forEach((ok, i) => {
      if (ok && st === null) st = i;
      else if (!ok && st !== null) {
        const ln = i - st;
        if (ln >= 4) {
          const cand = [ln, off + 4 * st, parsed.slice(st, i), n];
          if (best === null || cand[0] > best[0] || (cand[0] === best[0] && -cand[1] > -best[1])) best = cand;
        }
        st = null;
      }
    });
    return best;
  }

  find_candidate_array(im) {
    const cache = this.loader._candidate_arrays;
    if (!cache.has(im)) cache.set(im, this._find_candidate_array(im));
    return cache.get(im);
  }

  _find_candidate_array(im) {
    if (im.candidate_hint) {
      const [hoff, hn] = im.candidate_hint;
      const best = this._validate_run(im, hoff, hn);
      if (best === null) {
        throw new UniversalError(`${im.label}: loader-supplied candidate array at 0x${hoff.toString(16)} (${hn} entries) contains no structurally valid CandidateNode subrun`);
      }
      const [ln, off, rows] = best;
      return [off, rows, { count: ln, source: "loader_hint" }];
    }
    let best = null;
    const allValid = [];
    for (const [off, n] of this._pointer_runs(im, 4)) {
      const cand = this._validate_run(im, off, n);
      if (cand === null) continue;
      allValid.push(cand);
      if (best === null || cand[0] > best[0] || (cand[0] === best[0] && -cand[1] > -best[1])) best = cand;
    }
    if (best === null) throw new UniversalError(`no structurally valid CandidateNode pointer array found in ${im.label}`);
    if (allValid.length > 1) {
      this.rep.warn("candidate_subrun_discarded", "more than one structurally valid CandidateNode subrun in this image; only the longest is decoded, so the result may be incomplete", { image: im.label });
    }
    const [ln, off, rows] = best;
    return [off, rows, { count: ln, source: "scan" }];
  }
}

// --- feature tables -----------------------------------------------------------------------

export class FeatureTable {
  constructor(root_off, root_va, objects) {
    this.root_off = root_off;
    this.root_va = root_va;
    this.objects = objects; // [mimo_status, bw_code, channel_bw_90]
  }
  get length() {
    return this.objects.length;
  }
}

export class FeatureResolver {
  constructor(parser) {
    this.p = parser;
    this.last_pair_stats = {};
  }

  _valid_obj(st, bw, b90) {
    if (!(st <= 3) || !(b90 === 0 || b90 === 1)) return false;
    if (st === 3) return true;
    return bw < this.p.tables.bw.length;
  }

  _absent_objects(im) {
    const lo = im.source_offset, hi = im.end_source;
    const maxBw = this.p.tables.bw.length + 8;
    const d = im.drdi;
    const out = [];
    let o = d.indexOf(3, lo);
    while (o !== -1 && o < hi - 2) {
      if (d[o + 1] <= maxBw && d[o + 2] <= 1) out.push(o);
      o = d.indexOf(3, o + 1);
    }
    return out;
  }

  find_tables(im, minLen = 4) {
    const data = im.drdi;
    const anchors = this._absent_objects(im);
    if (!anchors.length) return [];
    // np.array(want, "<u8").astype("<u4"): wraps to 32 bits.
    const want = new Set(anchors.map((o) => (o + im.relocation + im.alias) >>> 0));
    const nWords = Math.floor((im.end_source - im.source_offset) / 4);
    const words = wordsOf(data, im.source_offset, nWords);
    const roots = [];
    for (let h = 0; h < words.length; h++) if (want.has(words[h])) roots.push(im.source_offset + h * 4);
    const out = [];
    let covered = 0;
    for (const off of roots) {
      if (off < covered) continue;
      const objs = [];
      let k = 0;
      while (off + 4 * k + 4 <= im.end_source) {
        const qo = im.resolve(u32(data, off + 4 * k), 3);
        if (qo === null) break;
        const st = data[qo], bw = data[qo + 1], b90 = data[qo + 2];
        if (!this._valid_obj(st, bw, b90)) break;
        objs.push([st, bw, b90]);
        k++;
      }
      if (objs.length < minLen) continue;
      covered = off + 4 * objs.length;
      if (objs.every((o) => o[0] === 3)) continue;
      out.push(new FeatureTable(off, off + im.relocation + im.alias, objs));
    }
    return out;
  }

  collect_refs(rows) {
    const dl = [];
    const ul = [];
    const start = [];
    const expect = [];
    const w = this.p.tables.nr_weights;
    const absent = this.p.tables.nr_ul_absent;
    for (const c of rows) {
      if (!c.nr) continue;
      const d = c.nr;
      for (let v = 0; v < d.variants; v++) {
        let cur = v * d.units;
        for (const [, ulcls, dlcls] of d.records) {
          const n = w[dlcls];
          const sl = d.fsc.slice(cur, cur + n);
          cur += n;
          if (sl.length !== n) return null;
          start.push(ul.length);
          expect.push(absent.has(ulcls) ? 0 : w[ulcls]);
          for (const [, ui, di] of sl) {
            dl.push(di);
            ul.push(ui);
          }
        }
        if (cur !== (v + 1) * d.units) return null;
      }
    }
    if (!dl.length) return null;
    const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
    return { dl, ul, start, expect, uniq_dl: uniq(dl), uniq_ul: uniq(ul), cache: new Map() };
  }

  // Sums of "active" (status != 3) UL references per component (np.add.reduceat).
  _ul_sums(refs, status) {
    const sums = [];
    const starts = refs.start;
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : refs.ul.length;
      let s = 0;
      for (let j = starts[i]; j < end; j++) if (status[refs.ul[j]] !== 3) s++;
      sums.push(s);
    }
    return sums;
  }

  _evaluate_pair(refs, dl, ul) {
    if (refs === null) return [false, { reason: "grammar_walk_failed" }];
    const maxdi = refs.uniq_dl[refs.uniq_dl.length - 1];
    const maxui = refs.uniq_ul[refs.uniq_ul.length - 1];
    if (maxdi >= dl.length || maxui >= ul.length) return [false, { reason: "feature_id_oob" }];
    if (refs.uniq_dl.some((i) => dl.objects[i][0] === 3)) return [false, { reason: "dl_references_unsupported" }];
    const ulStatus = ul.objects.map((o) => o[0]);
    const sig = `detail|${refs.uniq_ul.map((i) => (ulStatus[i] !== 3 ? 1 : 0)).join("")}`;
    let cached = refs.cache.get(sig);
    if (cached === undefined) {
      const sums = this._ul_sums(refs, ulStatus);
      let bad = -1;
      for (let i = 0; i < sums.length; i++) if (sums[i] !== refs.expect[i]) {
        bad = i;
        break;
      }
      const nbad = sums.reduce((n, s, i) => n + (s !== refs.expect[i] ? 1 : 0), 0);
      cached = [sums.length, sums.length - nbad, bad < 0 ? null : [refs.expect[bad], sums[bad]]];
      refs.cache.set(sig, cached);
    }
    const [checks, ok, firstbad] = cached;
    if (firstbad !== null) return [false, { reason: "ul_class_feature_mismatch" }];
    const slack = (dl.length - (maxdi + 1)) + (ul.length - (maxui + 1));
    const exact = Number(dl.length === maxdi + 1) + Number(ul.length === maxui + 1);
    return [true, { refs: refs.dl.length, max_dl_id: maxdi, max_ul_id: maxui, ul_checks: checks, ul_checks_ok: ok, slack, exact_lengths: exact }];
  }

  _ul_closure(refs, ul) {
    const maxui = refs.uniq_ul[refs.uniq_ul.length - 1];
    if (ul.length <= maxui) return false;
    const status = ul.objects.map((o) => o[0]);
    const sig = `closure|${refs.uniq_ul.map((i) => (status[i] !== 3 ? 1 : 0)).join("")}`;
    let cached = refs.cache.get(sig);
    if (cached === undefined) {
      const sums = this._ul_sums(refs, status);
      cached = sums.every((s, i) => s === refs.expect[i]);
      refs.cache.set(sig, cached);
    }
    return cached;
  }

  _dl_admissible(refs, dl) {
    const maxdi = refs.uniq_dl[refs.uniq_dl.length - 1];
    if (dl.length <= maxdi) return false;
    return !refs.uniq_dl.some((i) => dl.objects[i][0] === 3);
  }

  pair_candidates(rows, tables, cap = 16) {
    const refs = this.collect_refs(rows);
    if (refs === null) {
      this.last_pair_stats = { reason: "grammar_walk_failed" };
      return [];
    }
    const maxdi = refs.uniq_dl[refs.uniq_dl.length - 1];
    const maxui = refs.uniq_ul[refs.uniq_ul.length - 1];
    const byKey = (a, b) => a[0] - b[0] || a[1].root_off - b[1].root_off;
    const dls = tables.filter((t) => this._dl_admissible(refs, t)).map((t) => [t.length - (maxdi + 1), t]).sort(byKey);
    const uls = tables.filter((t) => this._ul_closure(refs, t)).map((t) => [t.length - (maxui + 1), t]).sort(byKey);
    const good = [];
    for (const [, dl] of dls.slice(0, cap)) {
      for (const [, ul] of uls.slice(0, cap)) {
        if (dl === ul) continue;
        const [ok, detail] = this._evaluate_pair(refs, dl, ul);
        if (ok) good.push([[detail.slack, -detail.exact_lengths, Math.abs(dl.root_off - ul.root_off)], dl, ul, detail]);
      }
    }
    const cmp = (a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1] || a[0][2] - b[0][2];
    return good.sort(cmp);
  }
}

export class ProfileState {
  constructor(image, candidates, candidate_info, feature_tables, feature_pairs) {
    this.image = image;
    this.candidates = candidates;
    this.candidate_info = candidate_info;
    this.feature_tables = feature_tables;
    this.feature_pairs = feature_pairs;
    this.dl_table = null;
    this.ul_table = null;
  }
}

function establishFeaturePairs(states, rep) {
  const orientations = [];
  const orient = (dl, ul) => (dl.root_off < ul.root_off ? "DL_FIRST" : "UL_FIRST");
  for (const s of states) {
    if (s.feature_pairs.length === 1) {
      const [, dl, ul] = s.feature_pairs[0];
      orientations.push(orient(dl, ul));
    } else if (s.feature_pairs.length) {
      const best = s.feature_pairs[0][0];
      const tied = s.feature_pairs.filter((x) => x[0][0] === best[0] && x[0][1] === best[1]);
      if (tied.length === 1) orientations.push(orient(tied[0][1], tied[0][2]));
    }
  }
  // Counter.most_common(1)[0][0]: highest count, first inserted on ties.
  let hint = null;
  if (orientations.length) {
    const counts = new Map();
    for (const o of orientations) counts.set(o, (counts.get(o) || 0) + 1);
    let n = -1;
    for (const [o, c] of counts) if (c > n) {
      hint = o;
      n = c;
    }
  }
  const unresolved = [];
  for (const s of states) {
    if (!s.feature_pairs.length) {
      unresolved.push(s);
      rep.fail("feature_pair_unresolved", "no DL/UL feature-table assignment passes domain and UL-class closure; this profile is excluded from the union", { profile: s.image.profile });
      continue;
    }
    let candidates = s.feature_pairs;
    if (hint) {
      const matching = candidates.filter((x) => orient(x[1], x[2]) === hint);
      if (matching.length) candidates = matching;
    }
    const [, dl, ul] = candidates[0];
    s.dl_table = dl;
    s.ul_table = ul;
  }
  const resolved = states.filter((x) => !unresolved.includes(x));
  if (!resolved.length) {
    throw new UniversalError("no capability profile could be resolved: no DL/UL feature-table assignment passes domain and UL-class closure on any profile");
  }
  return [resolved, unresolved.map((x) => x.image.profile)];
}

export function decodeProfileCombos(p, s) {
  const t = p.tables;
  const out = [];
  for (const cand of s.candidates) {
    const nvar = cand.nr ? cand.nr.variants : 1;
    const lvar = cand.lte ? cand.lte.variants : 1;
    if (nvar !== lvar && nvar !== 1 && lvar !== 1) {
      throw new UniversalError(`${s.image.label}: LTE/NR variant cardinalities incompatible: LTE=${lvar} NR=${nvar}`);
    }
    const variants = Math.max(nvar, lvar);
    for (let v = 0; v < variants; v++) {
      const lteComps = [];
      const nrComps = [];
      if (cand.lte) {
        const d = cand.lte;
        const vr = lvar === 1 ? 0 : v;
        let cur = vr * d.units;
        for (const [band, ul, dl] of d.records) {
          const n = t.lte_weights[dl];
          const sl = d.fsc.slice(cur, cur + n);
          cur += n;
          if (sl.length !== n) throw new UniversalError("LTE cursor underflow");
          const mm = [];
          for (const [, b1] of sl) {
            if (!has(DL_MIMO, b1)) throw new UniversalError(`${s.image.label}: LTE DL MIMO status ${b1} is unsupported/rejected`);
            mm.push(DL_MIMO[b1]);
          }
          lteComps.push(new LteComponent(band, dl, ul, mm));
        }
        if (cur !== (vr + 1) * d.units) throw new UniversalError("LTE cursor exhaustion failed");
      }
      if (cand.nr) {
        const d = cand.nr;
        const vr = nvar === 1 ? 0 : v;
        let cur = vr * d.units;
        for (const [band, ul, dl] of d.records) {
          const n = t.nr_weights[dl];
          const sl = d.fsc.slice(cur, cur + n);
          cur += n;
          const ccs = [];
          let activeUl = 0;
          for (const [scs, ui, di] of sl) {
            if (!has(SCS, scs)) throw new UniversalError(`invalid NR SCS enum ${scs}`);
            if (di >= s.dl_table.length || ui >= s.ul_table.length) throw new UniversalError("feature id escaped table");
            const dob = s.dl_table.objects[di];
            const uob = s.ul_table.objects[ui];
            if (!has(DL_MIMO, dob[0])) throw new UniversalError("DL feature references unsupported object");
            const dlBw = t.bw[dob[1]];
            let um = null;
            let ub = null;
            if (has(UL_MIMO, uob[0])) {
              activeUl++;
              um = UL_MIMO[uob[0]];
              ub = t.bw[uob[1]];
            }
            ccs.push(new NrCC(SCS[scs], DL_MIMO[dob[0]], dlBw, um, ub));
          }
          const exp = t.nr_ul_absent.has(ul) ? 0 : t.nr_weights[ul];
          if (activeUl !== exp) {
            throw new UniversalError(`UL feature/class mismatch after pair resolution: band n${band}, active=${activeUl}, expected=${exp}`);
          }
          nrComps.push(new NrComponent(band, dl, t.nr_ul_absent.has(ul) ? NR_UL_ABSENT_CANON : ul, ccs));
        }
        if (cur !== (vr + 1) * d.units) throw new UniversalError("NR cursor exhaustion failed");
      }
      out.push(new Combo(lteComps, nrComps));
    }
  }
  return out;
}

// --- LTE row tables --------------------------------------------------------------------

const LTE_MMAP = { 2: 2, 3: 4, 4: 8 };

export function parseLteFields(im, c0Off, tables) {
  if (c0Off < im.source_offset || c0Off + 24 > im.end_source) return null;
  const d = im.drdi;
  const c0 = u32(d, c0Off), p0 = u32(d, c0Off + 4), c1 = u32(d, c0Off + 8), p1 = u32(d, c0Off + 12);
  if (!(c0 >= 1 && c0 <= 16)) return null;
  const ro = im.resolve(p0, c0 * 3);
  const mo = im.resolve(p1, c1);
  if (ro === null || mo === null) return null;
  const recs = [];
  let units = 0;
  for (let k = 0; k < c0; k++) {
    const idx = d[ro + 3 * k], ul = d[ro + 3 * k + 1], dl = d[ro + 3 * k + 2];
    if (idx >= tables.lte_band_map.length) return null;
    const band = tables.lte_band_map[idx];
    if (band === 0 || band > MAX_LTE_BAND || dl >= 6 || (ul !== LTE_UL_ABSENT && ul >= 6)) return null;
    units += tables.lte_weights[dl];
    recs.push([band, ul, dl]);
  }
  if (c1 !== units || c1 <= 0) return null;
  const mmraw = d.subarray(mo, mo + c1);
  for (const x of mmraw) if (!(x === 2 || x === 3 || x === 4)) return null;
  let cur = 0;
  const comps = [];
  for (const [band, ul, dl] of recs) {
    const n = tables.lte_weights[dl];
    const sl = Array.from(mmraw.subarray(cur, cur + n));
    cur += n;
    comps.push(new LteComponent(band, dl, ul, sl.map((x) => LTE_MMAP[x])));
  }
  if (cur !== c1) return null;
  return new Combo(comps, []);
}

function parseLteRow(im, off, tables) {
  if (off < im.source_offset || off + 32 > im.end_source) return null;
  const cb = parseLteFields(im, off + 8, tables);
  return cb === null ? null : { off, combo: cb, layout: "legacy32" };
}

function parseLteRow36(im, off, tables) {
  if (off < im.source_offset || off + 36 > im.end_source) return null;
  const d = im.drdi;
  const flags = u32(d, off + 4), c0 = u32(d, off + 12), p0 = u32(d, off + 16), c1 = u32(d, off + 20);
  const p1 = u32(d, off + 24), p2 = u32(d, off + 28), c2 = u32(d, off + 32);
  if (flags >>> 16 !== 0xffff || !(c0 >= 1 && c0 <= 16) || c2 !== c0) return null;
  const ro = im.resolve(p0, c0 * 3);
  const mo = im.resolve(p1, c1);
  const companion = im.resolve(p2, c1);
  if (ro === null || mo === null || companion === null || c1 <= 0) return null;
  const recs = [];
  let units = 0;
  for (let k = 0; k < c0; k++) {
    const idx = d[ro + 3 * k], ul = d[ro + 3 * k + 1], dl = d[ro + 3 * k + 2];
    if (idx >= tables.lte_band_map.length) return null;
    const band = tables.lte_band_map[idx];
    if (band === 0 || band > MAX_LTE_BAND || dl >= 6 || (ul !== LTE_UL_ABSENT && ul >= 6)) return null;
    units += tables.lte_weights[dl];
    recs.push([band, ul, dl]);
  }
  if (c1 !== units) return null;
  const mmraw = d.subarray(mo, mo + c1);
  const comp = d.subarray(companion, companion + c1);
  for (const x of mmraw) if (!(x === 2 || x === 3 || x === 4)) return null;
  for (const x of comp) if (!(x === 2 || x === 3 || x === 4)) return null;
  let cur = 0;
  const comps = [];
  for (const [band, ul, dl] of recs) {
    const n = tables.lte_weights[dl];
    const sl = Array.from(mmraw.subarray(cur, cur + n));
    cur += n;
    comps.push(new LteComponent(band, dl, ul, sl.map((x) => LTE_MMAP[x])));
  }
  if (cur !== c1) return null;
  return { off, combo: new Combo(comps, []), layout: "extended36" };
}

// mod with Python sign semantics (result has the divisor's sign).
const pyMod = (a, b) => ((a % b) + b) % b;

export function scanLteRowsBank(bank, tables) {
  const result = new Map();
  for (const im of bank.images) {
    let best = [];
    for (const [stride, countDelta, parser] of [[32, 8, parseLteRow], [36, 12, parseLteRow36]]) {
      for (let residue = 0; residue < stride; residue += 4) {
        const rows = [];
        let cur = [];
        const start = im.source_offset + pyMod(residue - im.source_offset, stride);
        let previous = null;
        const d = im.drdi;
        // numpy prefilter: only offsets whose count field is 1..16.
        for (let off = start; off <= im.end_source - stride; off += stride) {
          const cnt = u32(d, off + countDelta);
          if (!(cnt >= 1 && cnt <= 16)) continue;
          if (previous !== null && off !== previous + stride) {
            if (cur.length >= 4) rows.push(cur);
            cur = [];
          }
          previous = off;
          const r = parser(im, off, tables);
          if (r) cur.push(r);
          else {
            if (cur.length >= 4) rows.push(cur);
            cur = [];
          }
        }
        if (cur.length >= 4) rows.push(cur);
        if (rows.length) {
          let m = rows[0];
          for (const r of rows) if (r.length > m.length) m = r;
          if (m.length > best.length) best = m;
        }
      }
    }
    if (best.length) result.set(im.profile, best.map((r) => r.combo));
  }
  return result;
}

function chooseLteBank(loader, cap, rep) {
  const found = [];
  for (const b of loader.banks) {
    if (!b.images.length) continue;
    const rows = scanLteRowsBank(b, loader.tables);
    if (rows.size) {
      const lens = [...rows.values()].map((r) => r.length);
      found.push([[Math.max(...lens), lens.reduce((a, c) => a + c, 0), rows.size], b, rows]);
    }
  }
  loader.lte_rows_by_bank = new Map(found.map(([, b, rows]) => [b.table_index, rows]));
  if (!found.length) {
    rep.warn("lte_bank_missing", "no invariant-valid modern 32-byte LTE CA table found");
    return [null, new Map()];
  }
  const cmp = (x, y) => y[0][0] - x[0][0] || y[0][1] - x[0][1] || y[0][2] - x[0][2];
  found.sort(cmp);
  const primary = found[0][1];
  const merged = new Map();
  for (const [, , rows] of found) {
    for (const [prof, combos] of rows) {
      if (!merged.has(prof)) merged.set(prof, []);
      merged.get(prof).push(...combos);
    }
  }
  const out = new Map();
  for (const k of [...merged.keys()].sort((a, b) => a - b)) out.set(k, dedupExact(merged.get(k)));
  return [primary, out];
}

// --- extraction ---------------------------------------------------------------------------

// Returns {cap, states, perProfile: Map, union, lteBank, lteProfiles: Map, lteUnion, unresolved}.
export function extractCapability(loader, profileArg, rep) {
  if (loader.name === "nr15") return loader.decoder.extract_capability(profileArg);
  const cap = loader.capability_bank();
  const parser = new GrammarParser(loader, rep);
  const fr = new FeatureResolver(parser);
  let states = [];
  for (const im of cap.images) {
    if (profileArg !== "all" && im.profile !== Number(profileArg)) continue;
    const [, rows, info] = parser.find_candidate_array(im);
    const fts = fr.find_tables(im);
    const pairs = fr.pair_candidates(rows, fts);
    states.push(new ProfileState(im, rows, info, fts, pairs));
  }
  if (!states.length) throw new UniversalError(`requested profile ${profileArg} is not live in capability bank`);
  let unresolved;
  [states, unresolved] = establishFeaturePairs(states, rep);
  const perProfile = new Map();
  let union = [];
  for (const s of states) {
    const exact = dedupExact(decodeProfileCombos(parser, s));
    perProfile.set(s.image.profile, exact);
    union.push(...exact);
  }
  union = dedupExact(union);
  let [lteBank, lteProfiles] = loader.lte_tables(cap, rep);
  if (profileArg !== "all" && lteProfiles.size) {
    lteProfiles = new Map([...lteProfiles].filter(([k]) => k === Number(profileArg)));
  }
  const lteUnion = dedupExact([...lteProfiles.values()].flat());
  return { cap, states, perProfile, union, lteBank, lteProfiles, lteUnion, unresolved };
}

export function guiFamilyCounts(combos) {
  const [endc, nr, lte] = classify(combos, 1);
  let nrdc = 0;
  let nrSa = 0;
  for (const row of nr) {
    if (row.nr.some((c) => c.band < 257) && row.nr.some((c) => c.band >= 257)) nrdc++;
    if (row.nr_physical_ccs === 1) nrSa++;
  }
  return { endc: endc.length, nr_sa: nrSa, nrca: nr.length - nrdc - nrSa, nrdc, lte: lte.length };
}

export { comboKey, dedupExact };
