// Port of mtk-drdi-combo-parser/mtk_tensor_secondary.py: structural decoder for
// the Tensor split-CDF secondary (FR2 / NR-DC) capability bank. Returns plain
// row dictionaries like the Python module; universal-style Combo objects are
// built by the caller (backend.js secondaryCombos).
import { wordsOf, u32 } from "./universal.js";

const SCS_KHZ = { 0: 15, 1: 30, 2: 60, 3: 120, 4: 240 };
const DL_MIMO = { 0: 2, 1: 4, 2: 8 };
const UL_MIMO = { 0: 1, 1: 2, 2: 4 };
const LTE_WEIGHT = [1, 2, 2, 3, 4, 5];
const NR_OMIT_UL = new Set([0x1c, 0xff]);
const FR2_WEIGHT = { 0: 1, 6: 2, 7: 3, 8: 4, 9: 5, 10: 6, 11: 7, 12: 8 };

const runtimePtr = (value, alias) => (alias && value >= alias ? value - alias : value);

function readPtrArray(im, ptr, alias, maxCount) {
  const off = runtimePtr(ptr, alias) - im.relocation;
  if (off < im.source_offset || off + 4 > im.end_source) return null;
  const out = [];
  for (let i = 0; i < maxCount; i++) {
    const pos = off + i * 4;
    if (pos + 4 > im.end_source) return null;
    const value = u32(im.drdi, pos);
    if (value === 0) return out;
    out.push(value);
  }
  return null;
}

function weightOf(band, cls, generic) {
  if (band >= 257) return FR2_WEIGHT[cls] ?? 0;
  return cls >= 0 && cls < generic.length ? generic[cls] : 0;
}

class Decoder {
  constructor(loader, bank) {
    this.loader = loader;
    this.bank = bank;
    this.alias = loader.ALIAS ?? 0x60000000;
    this.images = new Map(bank.images.map((im) => [im.profile, im]));
    this.generic = loader.tables.nr_weights;
    this.lteBandMap = loader.tables.lte_band_map;
    this.bw = loader.tables.bw;
    this.descCache = new Map();
  }

  candidateValues() {
    const lo = this.bank.bank_va;
    const hi = lo + Math.max(...[...this.images.values()].map((im) => im.length));
    const alo = lo + this.alias;
    const ahi = hi + this.alias;
    const words = wordsOf(this.loader.rom);
    const aliased = new Set();
    const raw = new Set();
    for (const w of words) {
      if (w >= alo && w < ahi) aliased.add(w);
      else if (w >= lo && w < hi) raw.add(w);
    }
    // numpy path: aliased if any, else raw (w in both windows only lands in aliased).
    if (aliased.size) return [...aliased].sort((a, b) => a - b);
    const rawAll = new Set();
    for (const w of words) if (w >= lo && w < hi) rawAll.add(w);
    return [...rawAll].sort((a, b) => a - b);
  }

  decodeDesc(im, ptr, nr) {
    const key = `${im.profile}|${ptr}|${nr}`;
    if (this.descCache.has(key)) return this.descCache.get(key);
    const d = im.drdi;
    const off = im.resolve(ptr, 16);
    if (off === null) return null;
    const count = u32(d, off), recordsPtr = u32(d, off + 4), fscCount = u32(d, off + 8), fscPtr = u32(d, off + 12);
    if (!(count >= 1 && count <= 16 && fscCount > 0)) return null;
    const recSize = nr ? 4 : 3;
    const recordsOff = im.resolve(recordsPtr, count * recSize);
    if (recordsOff === null) return null;
    const records = [];
    let units = 0;
    for (let i = 0; i < count; i++) {
      let band, ul, dl, w;
      if (nr) {
        const o = recordsOff + i * 4;
        band = d[o] | (d[o + 1] << 8);
        ul = d[o + 2];
        dl = d[o + 3];
        w = weightOf(band, dl, this.generic);
        if (!(band >= 1 && band <= 1024 && w > 0)) return null;
        if (!NR_OMIT_UL.has(ul) && weightOf(band, ul, this.generic) <= 0) return null;
      } else {
        const o = recordsOff + i * 3;
        const idx = d[o];
        ul = d[o + 1];
        dl = d[o + 2];
        if (!(idx < this.lteBandMap.length)) return null;
        band = this.lteBandMap[idx];
        if (!(band >= 1 && band <= 90 && dl < LTE_WEIGHT.length)) return null;
        if (ul !== 6 && !(ul < LTE_WEIGHT.length)) return null;
        w = LTE_WEIGHT[dl];
      }
      records.push([band, ul, dl]);
      units += w;
    }
    const fscSize = nr ? 3 : 2;
    const fscOff = fscPtr ? im.resolve(fscPtr, fscCount * fscSize) : null;
    if (units <= 0 || fscOff === null || fscCount % units) return null;
    const result = { count, records, fsc_count: fscCount, fsc_off: fscOff, units, variants: Math.floor(fscCount / units), nr };
    this.descCache.set(key, result);
    return result;
  }

  candidateShape(im, ptr) {
    const off = im.resolve(ptr, 16);
    if (off === null) return null;
    const d = im.drdi;
    const ltePtr = u32(d, off + 8), nrPtr = u32(d, off + 12);
    if (nrPtr === 0) return null;
    const nr = this.decodeDesc(im, nrPtr, true);
    if (nr === null) return null;
    const lte = ltePtr ? this.decodeDesc(im, ltePtr, false) : null;
    if (ltePtr && lte === null) return null;
    return { ptr, lte, nr };
  }

  candidateRoots(values) {
    const found = new Map();
    for (const [profile, im] of this.images) {
      let best = null;
      for (const root of values) {
        const pointers = readPtrArray(im, root, this.alias, 100000);
        if (!pointers || pointers.length < 32) continue;
        const sample = pointers.slice(0, Math.min(128, pointers.length));
        if (sample.some((p) => this.candidateShape(im, p) === null)) continue;
        let decoded = [];
        for (const p of pointers) {
          const shape = this.candidateShape(im, p);
          if (shape === null) {
            decoded = [];
            break;
          }
          decoded.push(shape);
        }
        if (decoded.length && (best === null || decoded.length > best[1].length)) best = [root, decoded];
      }
      if (best !== null) found.set(profile, best);
    }
    return found;
  }

  featureRoots(values) {
    const found = new Map();
    for (const [profile, im] of this.images) {
      const choices = [];
      for (const root of values) {
        const pointers = readPtrArray(im, root, this.alias, 128);
        if (!pointers || !(pointers.length >= 8 && pointers.length <= 64)) continue;
        let rows = [];
        for (const p of pointers) {
          const off = im.resolve(p, 3);
          if (off === null) {
            rows = [];
            break;
          }
          const status = im.drdi[off], bw = im.drdi[off + 1], bw90 = im.drdi[off + 2];
          if (!(status <= 3) || (status !== 3 && bw >= this.bw.length)) {
            rows = [];
            break;
          }
          rows.push([status, bw, bw90 ? 1 : 0]);
        }
        if (rows.length) choices.push([root, rows]);
      }
      if (choices.length) found.set(profile, choices);
    }
    return found;
  }

  decodeProfile(im, candidates, dlFeatures, ulFeatures) {
    const combos = [];
    let singleFr2 = 0;
    const d = im.drdi;
    for (const candidate of candidates) {
      const { nr, lte } = candidate;
      const lteVariants = lte ? lte.variants : 1;
      const nrVariants = nr.variants;
      if (lte && lteVariants !== 1 && lteVariants !== nrVariants && nrVariants !== 1) return null;
      const variants = Math.max(lteVariants, nrVariants);
      const bands = nr.records.map((x) => x[0]);
      const hasFr1 = bands.some((x) => x < 257);
      const hasFr2 = bands.some((x) => x >= 257);
      if (!lte && !(hasFr1 && hasFr2)) {
        singleFr2 += variants;
        continue;
      }
      for (let variant = 0; variant < variants; variant++) {
        const outLte = [];
        if (lte) {
          const lv = lteVariants === 1 ? 0 : variant;
          let cursor = lv * lte.units;
          for (const [band, ul, dl] of lte.records) {
            const mimo = [];
            for (let k = 0; k < LTE_WEIGHT[dl]; k++) {
              const status = d[lte.fsc_off + cursor * 2 + 1];
              if (!(status <= 2)) return null;
              mimo.push({ 0: 2, 1: 4, 2: 8 }[status]);
              cursor++;
            }
            outLte.push({ band, dl_class: dl, ul_class: ul, dl_mimo: mimo });
          }
          if (cursor !== (lv + 1) * lte.units) return null;
        }
        const outNr = [];
        const nv = nrVariants === 1 ? 0 : variant;
        let cursor = nv * nr.units;
        for (const [band, ul, dl] of nr.records) {
          const ccCount = weightOf(band, dl, this.generic);
          const expected = NR_OMIT_UL.has(ul) ? 0 : weightOf(band, ul, this.generic);
          const ccs = [];
          let active = 0;
          for (let k = 0; k < ccCount; k++) {
            const o = nr.fsc_off + cursor * 3;
            const scs = d[o], ui = d[o + 1], di = d[o + 2];
            cursor++;
            if (!(scs in SCS_KHZ) || di >= dlFeatures.length || ui >= ulFeatures.length) return null;
            const [dstatus, dbw] = dlFeatures[di];
            const [ustatus, ubw] = ulFeatures[ui];
            if (!(dstatus in DL_MIMO) || dbw >= this.bw.length) return null;
            if (!(ustatus <= 3)) return null;
            if (ustatus !== 3) active++;
            ccs.push({
              scs_khz: SCS_KHZ[scs],
              dl_mimo: DL_MIMO[dstatus],
              dl_bw_mhz: this.bw[dbw],
              ul_mimo: ustatus !== 3 ? (UL_MIMO[ustatus] ?? null) : null,
              ul_bw_mhz: ustatus !== 3 && ubw < this.bw.length ? this.bw[ubw] : null,
            });
          }
          if (active !== expected) return null;
          outNr.push({ band, dl_class: dl, ul_class: NR_OMIT_UL.has(ul) ? 0x1c : ul, ccs });
        }
        if (cursor !== (nv + 1) * nr.units) return null;
        combos.push({ lte: outLte, nr: outNr });
      }
    }
    return [combos, singleFr2];
  }

  decode() {
    const values = this.candidateValues();
    const roots = this.candidateRoots(values);
    const featureRoots = this.featureRoots(values);
    const results = [];
    for (const [profile, im] of this.images) {
      if (!roots.has(profile) || !featureRoots.has(profile)) continue;
      const candidates = roots.get(profile)[1];
      const choices = featureRoots.get(profile);
      let best = null;
      for (const [dlRoot, dl] of choices) {
        for (const [ulRoot, ul] of choices) {
          if (dlRoot === ulRoot) continue;
          const decoded = this.decodeProfile(im, candidates, dl, ul);
          if (decoded !== null) {
            const [combos, excluded] = decoded;
            if (best === null || combos.length > best[0].length) best = [combos, excluded];
          }
        }
      }
      if (best === null) continue;
      results.push({ bank_index: this.bank.table_index, bank_va: this.bank.bank_va, profile, combos: best[0], candidate_count: candidates.length });
    }
    return results;
  }
}

// Validated secondary-bank profiles, or [] (secondary banks are optional).
export function decodeTensorSecondary(loader, bankIndex = 8, rep = null) {
  const bank = loader.banks.find((b) => b.table_index === bankIndex && b.images.length);
  if (!bank) return [];
  let results;
  try {
    results = new Decoder(loader, bank).decode();
  } catch (err) {
    if (rep) rep.warn("tensor_secondary_unresolved", "secondary Tensor bank did not pass structural proof", { reason: err.message });
    return [];
  }
  if (!results.length && rep) rep.warn("tensor_secondary_unresolved", "secondary Tensor bank roots or FSC tables were not proved");
  return results;
}
