// Port of mtk-drdi-combo-parser/mtk_export.py: the normalized combination model
// shared by every MTK loader, classify(), and the 0xB826 v21 / 0xB0CD v41
// encoders. Only the formats the webapp exports are ported (cap-prune and the
// MTK trace logs are not). Byte layout, dedup order and text framing follow the
// Python module exactly; the MTK goldens pin them.
import { sha256Hex } from "../hash.js";
import { hex } from "../bytes.js";

export const LTE_CLASS_CCS = [1, 2, 2, 3, 4, 5];
export const LTE_UL_ABSENT = 6;
export const NR_UL_ABSENT = 0x1c;
export const VERSION = 21;

export class NrCC {
  constructor(scs_khz, dl_mimo, dl_bw_mhz, ul_mimo = null, ul_bw_mhz = null) {
    this.scs_khz = scs_khz;
    this.dl_mimo = dl_mimo ?? null;
    this.dl_bw_mhz = dl_bw_mhz ?? null;
    this.ul_mimo = ul_mimo ?? null; // null = no UL on this CC
    this.ul_bw_mhz = ul_bw_mhz ?? null;
  }
}

export class NrComponent {
  constructor(band, dl_class, ul_class, ccs = []) {
    this.band = band;
    this.dl_class = dl_class; // raw enum: 0=A, 1=B ...
    this.ul_class = ul_class; // raw enum or NR_UL_ABSENT
    this.ccs = ccs;
  }
  get has_ul() {
    return this.ul_class !== NR_UL_ABSENT;
  }
}

export class LteComponent {
  constructor(band, dl_class, ul_class, dl_mimo = []) {
    this.band = band;
    this.dl_class = dl_class;
    this.ul_class = ul_class; // raw enum or LTE_UL_ABSENT
    this.dl_mimo = dl_mimo; // layers per physical CC
  }
  get has_ul() {
    return this.ul_class < LTE_UL_ABSENT;
  }
}

export class Combo {
  constructor(lte = [], nr = []) {
    this.lte = lte;
    this.nr = nr;
  }
  get kind() {
    if (this.lte.length && this.nr.length) return "ENDC";
    if (this.nr.length) return "NR";
    return "LTE";
  }
  get nr_physical_ccs() {
    let n = 0;
    for (const c of this.nr) n += c.ccs.length;
    return n;
  }
}

// Python combo_key / _identity tuple, as a string (dict/set key).
export function comboKey(cb) {
  let s = "L";
  for (const c of cb.lte) s += `|${c.band},${c.dl_class},${c.ul_class},${c.dl_mimo.join(".")}`;
  s += "#N";
  for (const c of cb.nr) {
    s += `|${c.band},${c.dl_class},${c.ul_class}`;
    for (const x of c.ccs) s += `;${x.scs_khz},${x.dl_mimo},${x.dl_bw_mhz},${x.ul_mimo},${x.ul_bw_mhz}`;
  }
  return s;
}

export function dedupExact(combos) {
  const seen = new Set();
  const out = [];
  for (const cb of combos) {
    const k = comboKey(cb);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(cb);
    }
  }
  return out;
}

export function classify(combos, nrcaMinCcs = 1) {
  const endc = combos.filter((c) => c.kind === "ENDC");
  const nrca = combos.filter((c) => c.kind === "NR" && c.nr_physical_ccs >= nrcaMinCcs);
  const lte = combos.filter((c) => c.kind === "LTE");
  return [endc, nrca, lte];
}

// --- B826 tables & encoder ----------------------------------------------------

const BW_NAMES = [
  "DEFAULT", "5", "10", "15", "20", "20_20", "20_20_20",
  "20_20_20_20", "20_20_20_20_20", "25", "30", "40", "50",
  "50_50", "50_50_50", "50_50_50_50", "50_50_50_50_50", "60",
  "70", "80", "90", "100", "100_60", "100_100", "100_100_100",
  "100_100_100_100", "100_100_100_100_100",
  "100_100_100_100_100_100", "100_100_100_100_100_100_100",
  "100_100_100_100_100_100_100_100", "40_40", "60_40",
  "100_40", "200", "200_200", "200_200_200", "200_200_200_200",
  "10_10", "25_25", "40_10", "40_20", "35", "30_20", "60_60",
  "30_30", "45", "50_5", "50_10", "50_15", "50_20", "40_15",
  "15_15", "30_25", "20_10", "20_15", "5_5", "80_80", "80_20",
  "40_30", "100_90", "30_10", "100_20", "80_40", "50_40",
  "100_50", "100_80",
  "35_35", "45_45",
];
const BW_TO_INDEX = new Map();
BW_NAMES.forEach((name, idx) => {
  if (name !== "DEFAULT") BW_TO_INDEX.set(name, idx); // key: "_"-joined MHz values
});
const SCS_TO_INDEX = { 15: 1, 30: 2, 60: 3, 120: 4, 240: 5 };

function antennaTables() {
  const names = ["INVALID", "1", "2", "4"];
  for (let count = 2; count <= 8; count++) {
    names.push(Array(count).fill("1").join("_"));
    for (let leading = 1; leading <= count; leading++) {
      names.push([...Array(leading).fill("2"), ...Array(count - leading).fill("1")].join("_"));
    }
    for (let leading = 1; leading <= count; leading++) {
      names.push([...Array(leading).fill("4"), ...Array(count - leading).fill("2")].join("_"));
    }
  }
  names.push("8", "8_4", "8_4_4", "8_8", "6", "4_8", "6_4", "4_6", "6_6");
  const fwd = new Map(); // "_"-joined layers -> idx ("" for INVALID); later names win like a dict
  names.forEach((name, idx) => fwd.set(name === "INVALID" ? "" : name, idx));
  return fwd;
}
const ANT_TO_INDEX = antennaTables();

const desc = (arr) => [...arr].sort((a, b) => b - a);

function mimoIndex(layers) {
  if (!layers || !layers.length) return 0;
  const key = layers.map(Number).join("_");
  if (ANT_TO_INDEX.has(key)) return ANT_TO_INDEX.get(key);
  const canonical = desc(layers.map(Number)).join("_");
  if (ANT_TO_INDEX.has(canonical)) return ANT_TO_INDEX.get(canonical);
  throw new Error(`B826 antenna enum cannot encode MIMO vector ${JSON.stringify(layers)}`);
}

// Returns [index, ok]; the collapsed/raw provenance tuple only feeds the
// unsupported counter, which the webapp does not report.
function bwIndex(values) {
  if (!values || !values.length) return [0, true];
  const key = values.map(Number);
  const k = key.join("_");
  if (BW_TO_INDEX.has(k)) return [BW_TO_INDEX.get(k), true];
  const canonical = desc(key).join("_");
  if (BW_TO_INDEX.has(canonical)) return [BW_TO_INDEX.get(canonical), true];
  const distinctSet = [...new Set(key)];
  if (distinctSet.length === 1 && BW_TO_INDEX.has(String(key[0]))) return [BW_TO_INDEX.get(String(key[0])), true];
  // BW_EXT_ENABLE is False in the Python module.
  const distinct = desc(distinctSet);
  if (distinct.length === 2 && BW_TO_INDEX.has(distinct.join("_"))) return [BW_TO_INDEX.get(distinct.join("_")), true];
  return [0, false];
}

function encodeComponent(component) {
  const band = component.band;
  if (!(band > 0 && band < 512)) throw new Error(`B826 v21 band out of 9-bit range: ${band}`);
  const isNr = component.rat === "NR";
  const dlClass = component.dl_class;
  const ulClass = component.ul_class;
  const dlMimo = mimoIndex(component.dl_mimo);
  const ulMimo = ulClass ? mimoIndex(component.ul_mimo) : 0;
  if (dlMimo > 0x7f) throw new Error(`DL MIMO index ${dlMimo} exceeds B826 field`);
  if (ulMimo > 0x1f) throw new Error(`UL MIMO index ${ulMimo} exceeds B826 field`);
  const head = band | ((isNr ? 1 : 0) << 9) | ((dlClass & 0x1f) << 10) | ((dlMimo & 1) << 15);
  const byte1 = ((dlMimo >> 1) & 0x3f) | ((ulClass & 0x03) << 6);
  const byte2 = ((ulClass >> 2) & 0x07) | ((ulMimo & 0x1f) << 3);
  let byte3 = 0, byte4 = 0, byte5 = 0;
  if (isNr) {
    const scsIdx = SCS_TO_INDEX[component.scs];
    if (scsIdx === undefined) throw new Error(`B826: unsupported SCS ${component.scs}`);
    const [dlIdx] = bwIndex(component.dl_bw);
    const [ulIdx] = bwIndex(component.ul_bw);
    byte3 |= (scsIdx & 0x01) << 7;
    byte4 |= (scsIdx >> 1) & 0x03;
    byte4 |= (dlIdx & 0x3f) << 2;
    byte5 |= (dlIdx >> 6) & 0x01;
    byte5 |= (ulIdx & 0x7f) << 1;
  }
  // struct "<HBBBBB" + two zero bytes
  return [head & 0xff, (head >> 8) & 0xff, byte1 & 0xff, byte2 & 0xff, byte3 & 0xff, byte4 & 0xff, byte5 & 0xff, 0, 0];
}

function encodeCombo(components) {
  const count = components.length;
  if (!(count >= 1 && count <= 15)) throw new Error(`B826 v21 supports 1..15 components, got ${count}`);
  const features = (count & 0x0f) << 3;
  const out = [0, 0, 0, features & 0xff, (features >> 8) & 0xff];
  for (let i = 0; i < 24; i++) out.push(0);
  for (const c of components) out.push(...encodeComponent(c));
  return out;
}

function buildLog(componentRows, source) {
  const encoded = [];
  const seen = new Set();
  for (const components of componentRows) {
    const raw = encodeCombo(components);
    const key = raw.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      encoded.push(raw);
    }
  }
  const total = encoded.length;
  if (total > 0xffff) throw new Error("B826 log item exceeds uint16 combo count");
  const header = [VERSION & 0xff, VERSION >> 8, 0, 0, total & 0xff, total >> 8, 0, 0, total & 0xff, total >> 8, source & 0xff];
  let length = header.length;
  for (const e of encoded) length += e.length;
  const blob = new Uint8Array(length);
  blob.set(header, 0);
  let pos = header.length;
  for (const e of encoded) {
    blob.set(e, pos);
    pos += e.length;
  }
  return { blob, records: total, inputRows: componentRows.length };
}

function b826Components(cb) {
  const comps = [];
  for (const c of cb.lte) {
    const n = Math.max(1, c.dl_mimo.length);
    const ulCcs = c.ul_class < LTE_CLASS_CCS.length ? LTE_CLASS_CCS[c.ul_class] : 1;
    comps.push({
      rat: "LTE", band: c.band,
      dl_class: c.dl_class + 1,
      ul_class: c.has_ul ? c.ul_class + 1 : 0,
      dl_mimo: c.dl_mimo.length ? c.dl_mimo : Array(n).fill(2),
      ul_mimo: c.has_ul ? Array(ulCcs).fill(1) : [],
    });
  }
  for (const c of cb.nr) {
    if (!c.ccs.length) return [];
    const ul = c.ccs.filter((cc) => cc.ul_mimo);
    const withUl = c.has_ul && ul.length > 0;
    comps.push({
      rat: "NR", band: c.band,
      dl_class: c.dl_class + 1,
      ul_class: c.has_ul ? c.ul_class + 1 : 0,
      dl_mimo: c.ccs.map((cc) => cc.dl_mimo || 2),
      dl_bw: c.ccs.map((cc) => cc.dl_bw_mhz || 20),
      ul_mimo: withUl ? ul.map((cc) => cc.ul_mimo) : [],
      ul_bw: withUl ? ul.map((cc) => cc.ul_bw_mhz) : [],
      scs: c.ccs[0].scs_khz,
    });
  }
  return comps;
}

const TAGS = { 3: "RF_ENDC", 4: "RF_NRCA", 5: "RF_NRDC" };

export function buildB826(combos, source, tag = null) {
  tag = tag || TAGS[source] || `SOURCE${source}`;
  const rows = [];
  const seen = new Set();
  for (const cb of combos) {
    const comps = b826Components(cb);
    if (!comps.length) continue;
    const key = JSON.stringify(comps); // Python dedups on repr(comps)
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(comps);
  }
  const { blob, records, inputRows } = buildLog(rows, source);
  return { tag, source, blob, records, inputRows };
}

export function b826Block(result, device) {
  return `# 0xB826 v21 ${result.tag} (source=${result.source}) ${device}\n`
    + `# records=${result.records}\n`
    + `Payload: ${hex(result.blob).toUpperCase()}\n`;
}

export function combinedB826Text(results, device) {
  return results.map((r) => b826Block(r, device)).join("\n");
}

// --- B0CD v41 ------------------------------------------------------------------

export class B0cdError extends Error {}

function b0cdAntennaIndex(layers) {
  const key = desc([...layers].map(Number)).join("_");
  if (!ANT_TO_INDEX.has(key)) throw new B0cdError(`0xB0CD v41 has no antenna enum for LTE MIMO (${key.replaceAll("_", ", ")})`);
  return ANT_TO_INDEX.get(key);
}

function b0cdComponent(component) {
  const band = component.band;
  const dlClass = component.dl_class;
  const ulClass = component.ul_class;
  if (!(band >= 1 && band <= 0x1ff)) throw new B0cdError(`0xB0CD v41 LTE band is out of range: ${band}`);
  if (!(dlClass >= 0 && dlClass < 26)) throw new B0cdError(`0xB0CD v41 DL class is out of range: ${dlClass}`);
  if (ulClass !== LTE_UL_ABSENT && !(ulClass >= 0 && ulClass < 26)) throw new B0cdError(`0xB0CD v41 UL class is out of range: ${ulClass}`);
  const dlMimo = b0cdAntennaIndex(component.dl_mimo.length ? component.dl_mimo : [2]);
  let qcomUl = 0;
  let ulMimo = 0;
  if (ulClass !== LTE_UL_ABSENT) {
    qcomUl = ulClass + 1;
    ulMimo = b0cdAntennaIndex(Array(LTE_CLASS_CCS[ulClass]).fill(1));
  }
  return [band & 0xff, band >> 8, dlClass + 1, qcomUl, dlMimo, ulMimo, 0];
}

export function buildB0cdV41(lteCombos, packetCombos = 100) {
  const records = [];
  const seen = new Set();
  for (const combo of lteCombos) {
    if (combo.nr && combo.nr.length) continue;
    const components = combo.lte.map(b0cdComponent);
    if (!components.length) continue;
    if (components.length > 6) throw new B0cdError("0xB0CD v41 supports at most six LTE components per combination");
    const record = [components.length, ...components.flat()];
    const key = record.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      records.push(record);
    }
  }
  const packets = [];
  for (let start = 0; start < records.length; start += packetCombos) {
    const chunk = records.slice(start, start + packetCombos);
    packets.push(Uint8Array.from([41, chunk.length, ...chunk.flat()]));
  }
  let total = 0;
  for (const p of packets) total += p.length;
  const all = new Uint8Array(total);
  let pos = 0;
  for (const p of packets) {
    all.set(p, pos);
    pos += p.length;
  }
  return { packets, records: records.length, sha256: sha256Hex(all) };
}

// Text of write_b0cd_v41 (lines joined with "\n", no trailing newline).
export function b0cdText(lteCombos, device) {
  const result = buildB0cdV41(lteCombos);
  const lines = [
    "# Headerless 0xB0CD v41 LTE capability payloads.",
    `# Device: ${device}`,
    "# Derived from MediaTek DRDI, not captured Qualcomm DIAG data.",
    "# MTK supplies band/class/DL-MIMO; BCS is omitted. UL MIMO is one layer per UL CC and UL-QAM is 0 (unknown).",
    `# records=${result.records}; packets=${result.packets.length}; sha256=${result.sha256}`,
    "",
  ];
  result.packets.forEach((packet, i) => {
    lines.push(`# LTE CA packet ${i + 1}/${result.packets.length}`, `Payload: ${hex(packet).toUpperCase()}`, "");
  });
  return lines.join("\n");
}
