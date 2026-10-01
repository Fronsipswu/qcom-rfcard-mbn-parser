// Port of the analyzer orchestration: gui_version/qualcomm_rf_combo_analyzer.py.
// Covered here: ModuleRecord + identity (:63-107), _matches_candidate and the
// MODERN/LEGACY name regexes (:43-52), _parse_identity_token (:114-126),
// scan_source (:161-255), _sort_records (:334-344), _deduplicate_records
// (:347-383), _combo_counts (:1552-1619), parse_module dispatch (:1179-1184),
// generate_web_tables with _normalize_legacy_component/_has_real_bcs and the
// _format_* helpers (:1224-1501), _write_csv/_write_web_csvs (:1197-1221,
// :1504-1525) and export_module (:1622-1701). The Excel ="..." formula guard
// of the comparison CSV writer (:2543) is applied by csvField.
// Container extraction (image_extractor.scan_container) is Task 9: until then
// scanSource returns { records: [], warnings: [{ tool, message }] } for inputs
// that are neither a named MBN nor a FAT16 image.
// Python parity contract: identical values, dict key insertion order,
// iteration order and message strings; goldens compare key order.
import { sha256Hex } from "./hash.js";
import { Fat16Image } from "./fat16.js";
import { Elf32Image, ParseError } from "./elf.js";
import {
  rfcardNameFromSymbols,
  findDescriptors,
  legacyTableLabels,
  findLegacyLteArray,
  parseLegacyModule,
  ToolError,
} from "./legacy_parser.js";
import { parseModernModule, pyCasefold } from "./modern_parser.js";

export { ToolError };

// --- ModuleRecord -------------------------------------------------------------

// Mirrors ModuleRecord.identity: literal firmware spelling of the file stem
// (analyzer.py:79-86).
export function recordIdentity(name) {
  let stem = pyStem(name);
  if (stem.slice(0, 10).toLowerCase() === "rf_config_") stem = stem.slice(10);
  return stem;
}

// Path(name).stem: strip the last suffix only ("a.b.c" -> "a.b").
function pyStem(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// Python int() over regex-captured tokens: decimal IDs while accepting
// hexadecimal alphabetic tokens (analyzer.py:114-121). Python \d matches
// Unicode Nd and int() evaluates Nd digits, so matching uses \p{Nd} and value
// evaluation uses the Nd block table (same approach as modern_parser.js).
const ND_RUN_STARTS = [
  48, 1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430,
  3558, 3664, 3792, 3872, 4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800,
  6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472, 43504, 43600, 44016,
  65296, 66720, 68912, 68928, 69734, 69872, 69942, 70096, 70384, 70736,
  70864, 71248, 71360, 71376, 71386, 71472, 71904, 72016, 72688, 72784,
  73040, 73120, 73552, 90416, 92768, 92864, 93008, 93552, 118000, 120782,
  120792, 120802, 120812, 120822, 123200, 123632, 124144, 124401, 125264,
  130032,
];

function pyNdInt(text) {
  let value = 0n;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const start = ND_RUN_STARTS.find((s) => cp >= s && cp <= s + 9);
    if (start === undefined) throw new RangeError(`not a Unicode decimal digit: U+${cp.toString(16)}`);
    value = value * 10n + BigInt(cp - start);
  }
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function parseIdentityToken(token) {
  const base = /[a-z]/i.test(token) ? 16 : 10;
  return base === 16 ? parseInt(token, 16) : pyNdInt(token);
}

function identityValue(match, field) {
  const token = match.groups[field];
  return token !== undefined ? parseIdentityToken(token) : 0;
}

// --- Python int()-style conversions used by the web-table formatting ----------

// Raises on null/undefined/non-integer strings exactly like int() does where
// the Python callers rely on the exception (their try/except or crash paths).
function pyInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new TypeError(`int() argument must be an integer, not ${value}`);
    return value;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^[+-]?\d+$/.test(s)) throw new TypeError(`invalid literal for int(): ${value}`);
    return parseInt(s, 10);
  }
  throw new TypeError("int() argument must be a number or numeric string");
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// dict.get(key, default) semantics: default applies only when the key is absent.
const dictGet = (obj, key, fallback) => (hasOwn(obj, key) ? obj[key] : fallback);

// --- name classification (analyzer.py:43-52, :129-136) ------------------------

// Python re.IGNORECASE simple-folds U+0130/U+0131/U+017F/U+212A (see
// modern_parser.js pyRegexFold); pre-normalize the input the same way.
const PY_RE_FOLD_RE = /[\u0130\u0131\u017f\u212a]/gu;

function pyRegexFold(text) {
  return text.replace(PY_RE_FOLD_RE, (ch) => (ch === "\u017f" ? "s" : ch === "\u212a" ? "k" : "i"));
}

const MODERN_NAME_RE = /^rf_config_(?<hwid>\p{Nd}+)_(?<fsid>\p{Nd}+)_(?<bid>\p{Nd}+)(?:_(?<rev>\p{Nd}+))?\.mbn$/iu;
const LEGACY_NAME_RE = /^(?<hwid>[0-9A-F]+)_(?<fsid>[0-9A-F]+)(?:_(?<bid>[0-9A-F]+))?\.mbn$/iu;

// _matches_candidate: modern first, then legacy; named groups carry the IDs.
export function matchesCandidate(name) {
  const folded = pyRegexFold(name);
  let match = MODERN_NAME_RE.exec(folded);
  if (match) return { generation: "DAT/protobuf", match };
  match = LEGACY_NAME_RE.exec(folded);
  if (match) return { generation: "Legacy ELF", match };
  return null;
}

// --- sort + dedup (analyzer.py:334-383) ----------------------------------------

export function sortRecords(records) {
  // sorted() with a tuple key; JS sort is stable, matching Python's guarantee.
  return [...records].sort((a, b) => {
    const ka = a.generation === "DAT/protobuf" ? 0 : 1;
    const kb = b.generation === "DAT/protobuf" ? 0 : 1;
    if (ka !== kb) return ka - kb;
    if (a.hwid !== b.hwid) return a.hwid - b.hwid;
    if (a.fsid !== b.fsid) return a.fsid - b.fsid;
    if (a.bid !== b.bid) return a.bid - b.bid;
    const fa = pyCasefold(a.inner_path);
    const fb = pyCasefold(b.inner_path);
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
}

export function deduplicateRecords(records) {
  // (name, sha256) keep-first. scanSource always hashes during the walk, so
  // the Python re-hash fallback for empty digests is unreachable here.
  const seen = new Set();
  const unique = [];
  for (const record of records) {
    const key = `${record.name}\u0000${record.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
  }
  return unique;
}

// --- combo counts (analyzer.py:1552-1619) --------------------------------------

function countTableRows(parsed) {
  const counts = {};
  for (const combo of parsed.combinations) {
    counts[combo.table] = (hasOwn(counts, combo.table) ? counts[combo.table] : 0) + 1;
  }
  return counts;
}

export function comboCounts(record, blob) {
  try {
    if (record.generation === "Legacy ELF" || record.generation === "legacy") {
      const image = new Elf32Image(blob);
      const cardName = rfcardNameFromSymbols(image);
      // LTE CA lives in the separate 50-byte array on generated legacy cards.
      const lteFound = findLegacyLteArray(blob, image);
      const lte = lteFound !== null ? lteFound[2] : 0;
      let descriptors;
      try {
        descriptors = findDescriptors(blob, image);
      } catch (err) {
        if (err instanceof ParseError) {
          if (cardName !== null) return [lte, "0+0+0=0"];
          throw err;
        }
        throw err;
      }
      const labeled = legacyTableLabels(blob, descriptors);
      let endc = 0;
      let nrCa = 0;
      let nrdc = 0;
      for (const [table, descriptor] of labeled) {
        if (table === "endc") endc += descriptor.comboCount;
        else if (table === "nr_ca") nrCa += descriptor.comboCount;
        else if (table === "nrdc") nrdc += descriptor.comboCount;
      }
      const total = endc + nrCa + nrdc;
      return [lte, `${endc}+${nrCa}+${nrdc}=${total}`];
    }
    const counts = countTableRows(parseModule(record, blob));
    const lte = hasOwn(counts, "lte_ca") ? counts.lte_ca : 0;
    const endc = hasOwn(counts, "endc") ? counts.endc : 0;
    const nrCa = hasOwn(counts, "nr_ca") ? counts.nr_ca : 0;
    const nrdc = hasOwn(counts, "nrdc") ? counts.nrdc : 0;
    const total = endc + nrCa + nrdc;
    return [lte, `${endc}+${nrCa}+${nrdc}=${total}`];
  } catch {
    return [-1, "—"];
  }
}

// --- parse_module dispatch (analyzer.py:1179-1184) ------------------------------

export function parseModule(record, blob) {
  if (record.generation === "DAT/protobuf" || record.generation === "XML DAT" || record.generation === "modern") {
    return parseModernModule(record, blob);
  }
  if (record.generation === "Legacy ELF" || record.generation === "legacy") {
    return parseLegacyModule(record, blob);
  }
  throw new ToolError(`Unknown RF-card format: ${record.generation}`);
}

// --- scan_source (analyzer.py:161-255) ------------------------------------------

function buildRecord(base, lte, nr) {
  // Field order mirrors the ModuleRecord dataclass declaration.
  return {
    inner_path: base.inner_path,
    name: base.name,
    generation: base.generation,
    size: base.size,
    hwid: base.hwid,
    fsid: base.fsid,
    bid: base.bid,
    external: base.external,
    source_path: base.source_path,
    sidecars: base.sidecars,
    sha256: base.sha256,
    lte_combos: lte,
    nr_combos: nr,
  };
}

export async function scanSource(source, name) {
  // Direct-MBN fast path: a file whose NAME already matches a candidate regex.
  // Python records inner_path/source_path as the absolute filesystem path; the
  // browser has no path, so the file name stands in for it.
  const direct = matchesCandidate(name);
  if (direct) {
    const { generation, match } = direct;
    const size = source.size;
    const blob = await source.read(0, size);
    const digest = sha256Hex(blob);
    const base = {
      inner_path: name,
      name,
      generation,
      size,
      hwid: identityValue(match, "hwid"),
      fsid: identityValue(match, "fsid"),
      bid: identityValue(match, "bid"),
      external: true,
      source_path: "",
      sidecars: {},
      sha256: digest,
    };
    const [lte, nr] = comboCounts(base, blob);
    return { records: deduplicateRecords([buildRecord(base, lte, nr)]), warnings: [] };
  }

  const fat = new Fat16Image(source);
  try {
    await fat.init();
  } catch (err) {
    // Not FAT16: Python falls through to image_extractor.scan_container here.
    // Container extraction lands in Task 9; fail softly until then.
    return {
      records: [],
      warnings: [
        {
          tool: "container",
          message: `Input is neither a named RF MBN nor a supported FAT16 modem image; container extraction is not available yet (${err.message})`,
        },
      ],
    };
  }

  const records = [];
  for (const entry of await fat.walk()) {
    // walk() entries carry the path only; the file name is the last segment
    // (path = parent + "/" + entry.name in Python _walk_fat).
    const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const matchInfo = matchesCandidate(fileName);
    if (!matchInfo) continue;
    const { generation, match } = matchInfo;
    // Numeric legacy modules are meaningful only under the modem's /so tree
    // (analyzer.py:222-225).
    if (generation === "Legacy ELF" && !pyCasefold(entry.path).includes("/so/")) continue;
    const raw = await fat.readFile(entry);
    const digest = sha256Hex(raw);
    const base = {
      inner_path: entry.path,
      name: fileName,
      generation,
      size: entry.size,
      hwid: identityValue(match, "hwid"),
      fsid: identityValue(match, "fsid"),
      bid: identityValue(match, "bid"),
      external: false,
      source_path: "",
      sidecars: {},
      sha256: digest,
    };
    const [lte, nr] = comboCounts(base, raw);
    records.push(buildRecord(base, lte, nr));
  }
  return { records: deduplicateRecords(sortRecords(records)), warnings: [] };
}

// --- record_json (tools/generate_goldens.py:27-47) ------------------------------

// Extracted-container scratch dirs (tempfile.mkdtemp tags) are normalized to
// the bare tag so goldens are deterministic; container records are Task 9 but
// the rule is ported now.
const SCRATCH_DIR_RE = /^(fat|sparse|zip|tar|gzip|zstd|xz|lz4|super|payload|squashfs|erofs|ext4|7z)_[A-Za-z0-9_]+$/;

export function normalizeInnerPath(innerPath) {
  const slash = innerPath.indexOf("/");
  if (slash !== -1) {
    const m = SCRATCH_DIR_RE.exec(innerPath.slice(0, slash));
    if (m) return `${m[1]}/${innerPath.slice(slash + 1)}`;
  }
  return innerPath;
}

export function recordJson(record) {
  return {
    name: record.name,
    inner_path: normalizeInnerPath(record.inner_path),
    generation: record.generation,
    identity: recordIdentity(record.name),
    size: record.size,
    sha256: record.sha256,
    external: record.external,
    lte_combos: record.lte_combos,
    nr_combos: record.nr_combos,
    sidecars: record.sidecars ? { ...record.sidecars } : {},
  };
}

// --- web-table formatting helpers (analyzer.py:1224-1322) -----------------------

export function formatScsVal(scsCode) {
  try {
    const c = pyInt(scsCode);
    if (c > 0) return String(2 ** (c - 1) * 15);
  } catch {
    // Python: int(None)/ValueError -> fall through
  }
  return "15";
}

export function formatQamVal(qamCode) {
  try {
    return pyInt(qamCode) === 2 ? "256" : "64";
  } catch {
    return "256";
  }
}

export function formatBcs(bcsNum) {
  // Python str(None) == "None".
  const s = String(bcsNum === null || bcsNum === undefined ? "None" : bcsNum).trim();
  return ["", "None", "-1"].includes(s) ? "All" : s;
}

export function formatUlTxSwitch(switchType) {
  try {
    const t = pyInt(switchType);
    if (t === 1) return "option 1";
    if (t === 2) return "option 2";
    if (t === 3) return "option 1,2";
  } catch {
    // Python: int(None)/ValueError -> "-"
  }
  return "-";
}

export function formatMimo(antStr) {
  if (!antStr || String(antStr).startsWith("INDEX_")) return "1";
  return String(antStr).replaceAll("_", " + ");
}

export function formatBw(bwStr) {
  if (!bwStr) return "";
  const out = String(bwStr).replaceAll("_", " + ");
  return out.endsWith(" MHz") ? out.slice(0, -4) : out;
}

export function formatScsForComp(comp, isUl = false) {
  const baseScs = formatScsVal(comp.max_scs);
  const bw = dictGet(comp, isUl ? "ul_bandwidth" : "dl_bandwidth", "");
  const bwClass = dictGet(comp, isUl ? "ul_bw_class" : "dl_bw_class", "A");
  let ccs;
  if (bw.includes("_")) ccs = bw.split("_").length;
  else if (bwClass === "B" || bwClass === "C") ccs = 2;
  else if (bwClass === "D") ccs = 3;
  else if (bwClass === "E") ccs = 4;
  else if (bwClass === "F") ccs = 5;
  else ccs = 1;
  return Array(ccs).fill(baseScs).join(" + ");
}

export function componentSortKey(comp, isUl = false) {
  let band;
  try {
    band = pyInt(dictGet(comp, "band", 0));
  } catch {
    band = 0;
  }
  const raw = dictGet(comp, isUl ? "ul_bw_class" : "dl_bw_class", "");
  const bwClass = raw || "";
  return [band, String(bwClass)];
}

// sorted(key=..., reverse=True) is stable in Python: equal keys keep their
// original order, so the comparator swaps argument order instead of reversing
// the sorted list.
function byComponentSortKeyDesc(isUl) {
  return (a, b) => {
    const [bandA, clsA] = componentSortKey(a, isUl);
    const [bandB, clsB] = componentSortKey(b, isUl);
    if (bandA !== bandB) return bandB - bandA;
    return clsA < clsB ? 1 : clsA > clsB ? -1 : 0;
  };
}

export function hasRealBcs(combos) {
  return combos.some((c) => {
    const val = dictGet(c, "bcs_num", null);
    return val !== null && val !== undefined && !["", "0", "None", "-1"].includes(String(val).trim());
  });
}

export function normalizeLegacyComponent(comp) {
  // Maps legacy parser sentinel values onto the modern component schema.
  const out = { ...comp };
  for (const key of ["dl_bw_class", "ul_bw_class"]) {
    if (out[key] === "NONE") out[key] = "-";
  }
  for (const key of ["dl_antenna", "ul_antenna"]) {
    const ant = out[key];
    if (typeof ant === "string") {
      if (ant === "NONE") out[key] = "INDEX_0";
      else if (ant.startsWith("ANTENNA_")) out[key] = ant.slice("ANTENNA_".length);
    }
  }
  return out;
}

// --- generate_web_tables (analyzer.py:1325-1501) ---------------------------------

const BAD_BW_CLASS = ["-", "0", "", "None"];

const hasBwClass = (x, key) => {
  const v = dictGet(x, key, null);
  return v !== null && v !== undefined && !BAD_BW_CLASS.includes(v);
};

const qamCell = (comps) => {
  if (comps.every((x) => formatQamVal(x.ul_qam_cap_index) === "256")) return "256";
  return comps.length ? comps.map((x) => formatQamVal(x.ul_qam_cap_index)).join(" + ") : "";
};

export function generateWebTables(combinations, components) {
  components = components.map(normalizeLegacyComponent);
  const compsByTblIdx = new Map(); // table -> Map(combo_index -> components)
  for (const comp of components) {
    const tbl = comp.table;
    const idx = pyInt(comp.combo_index);
    if (!compsByTblIdx.has(tbl)) compsByTblIdx.set(tbl, new Map());
    const byIdx = compsByTblIdx.get(tbl);
    if (!byIdx.has(idx)) byIdx.set(idx, []);
    byIdx.get(idx).push(comp);
  }
  const compsFor = (tbl, idx) => {
    const byIdx = compsByTblIdx.get(tbl);
    return byIdx && byIdx.has(idx) ? byIdx.get(idx) : [];
  };

  const hasEndcBcs = hasRealBcs(combinations.filter((c) => c.table === "endc"));
  const hasNrcaBcs = hasRealBcs(combinations.filter((c) => c.table === "nr_ca"));
  const hasLtecaBcs = hasRealBcs(combinations.filter((c) => c.table === "lte_ca"));
  const hasNrdcBcs = hasRealBcs(combinations.filter((c) => c.table === "nrdc"));

  const endcRows = [];
  const nrcaRows = [];
  const ltecaRows = [];
  const nrdcRows = [];

  for (const c of combinations) {
    const tbl = c.table;
    const idx = pyInt(c.combo_index);
    const compList = compsFor(tbl, idx);
    const bcs = formatBcs(dictGet(c, "bcs_num", "0"));

    if (tbl === "endc") {
      const lteComps = compList.filter((x) => x.technology === "LTE" && hasBwClass(x, "dl_bw_class")).sort(byComponentSortKeyDesc(false));
      const nrComps = compList.filter((x) => x.technology === "NR" && hasBwClass(x, "dl_bw_class")).sort(byComponentSortKeyDesc(false));
      const lteUl = compList.filter((x) => x.technology === "LTE" && hasBwClass(x, "ul_bw_class")).sort(byComponentSortKeyDesc(true));
      const nrUl = compList.filter((x) => x.technology === "NR" && hasBwClass(x, "ul_bw_class")).sort(byComponentSortKeyDesc(true));

      const row = {
        "LTE DL": lteComps.map((x) => `${x.band}${x.dl_bw_class}`).join(" + "),
        "LTE MIMO DL": lteComps.map((x) => formatMimo(x.dl_antenna)).join(" + "),
        "LTE DL (QAM)": "256",
        "NR DL": nrComps.map((x) => `${x.band}${x.dl_bw_class}`).join(" + "),
        "NR MIMO DL": nrComps.map((x) => formatMimo(x.dl_antenna)).join(" + "),
        "NR DL (QAM)": "256",
        "NR SCS DL (kHz)": nrComps.map((x) => formatScsForComp(x, false)).join(" + "),
        "NR BW DL (MHz)": nrComps.map((x) => formatBw(dictGet(x, "dl_bandwidth", ""))).join(" + "),
        "LTE UL": lteUl.map((x) => `${x.band}${x.ul_bw_class}`).join(" + "),
        "LTE MIMO UL": lteUl.map((x) => formatMimo(x.ul_antenna)).join(" + "),
        "LTE UL (QAM)": qamCell(lteUl),
        "NR UL": nrUl.map((x) => `${x.band}${x.ul_bw_class}`).join(" + "),
        "NR MIMO UL": nrUl.map((x) => formatMimo(x.ul_antenna)).join(" + "),
        "NR UL (QAM)": qamCell(nrUl),
        "NR SCS UL (kHz)": nrUl.map((x) => formatScsForComp(x, true)).join(" + "),
        "NR BW UL (MHz)": nrUl.map((x) => formatBw(dictGet(x, "ul_bandwidth", ""))).join(" + "),
      };
      if (hasEndcBcs) {
        row["BCS LTE"] = bcs;
        row["BCS NR"] = bcs;
        row["BCS INTRA ENDC"] = "";
      }
      endcRows.push(row);
    } else if (tbl === "nr_ca") {
      const nrDl = compList.filter((x) => hasBwClass(x, "dl_bw_class")).sort(byComponentSortKeyDesc(false));
      const nrUl = compList.filter((x) => hasBwClass(x, "ul_bw_class")).sort(byComponentSortKeyDesc(true));
      const row = {
        "NR DL": nrDl.map((x) => `${x.band}${x.dl_bw_class}`).join(" + "),
        "MIMO DL": nrDl.map((x) => formatMimo(x.dl_antenna)).join(" + "),
        "DL (QAM)": "256",
        "SCS DL (kHz)": nrDl.map((x) => formatScsForComp(x, false)).join(" + "),
        "BW DL (MHz)": nrDl.map((x) => formatBw(dictGet(x, "dl_bandwidth", ""))).join(" + "),
        "NR UL": nrUl.map((x) => `${x.band}${x.ul_bw_class}`).join(" + "),
        "MIMO UL": nrUl.map((x) => formatMimo(x.ul_antenna)).join(" + "),
        "UL (QAM)": qamCell(nrUl),
        "SCS UL (kHz)": nrUl.map((x) => formatScsForComp(x, true)).join(" + "),
        "BW UL (MHz)": nrUl.map((x) => formatBw(dictGet(x, "ul_bandwidth", ""))).join(" + "),
        "UL TX Switch": formatUlTxSwitch(dictGet(c, "ul_tx_switch_type", null)),
      };
      if (hasNrcaBcs) {
        row["BCS"] = bcs;
      }
      nrcaRows.push(row);
    } else if (tbl === "lte_ca") {
      const lteDl = compList.filter((x) => hasBwClass(x, "dl_bw_class")).sort(byComponentSortKeyDesc(false));
      const lteUl = compList.filter((x) => hasBwClass(x, "ul_bw_class")).sort(byComponentSortKeyDesc(true));
      const row = {
        "LTE DL": lteDl.map((x) => `${x.band}${x.dl_bw_class}`).join(" + "),
        "MIMO DL": lteDl.map((x) => formatMimo(x.dl_antenna)).join(" + "),
        "DL (QAM)": "256",
        "LTE UL": lteUl.map((x) => `${x.band}${x.ul_bw_class}`).join(" + "),
        "MIMO UL": lteUl.map((x) => formatMimo(x.ul_antenna)).join(" + "),
        "UL (QAM)": qamCell(lteUl),
      };
      if (hasLtecaBcs) {
        row["BCS"] = bcs;
      }
      ltecaRows.push(row);
    } else if (tbl === "nrdc") {
      const isFr1 = (x) => pyInt(dictGet(x, "band", 0)) < 257;
      const fr1Dl = compList.filter((x) => isFr1(x) && hasBwClass(x, "dl_bw_class")).sort(byComponentSortKeyDesc(false));
      const fr2Dl = compList.filter((x) => !isFr1(x) && hasBwClass(x, "dl_bw_class")).sort(byComponentSortKeyDesc(false));
      const fr1Ul = compList.filter((x) => isFr1(x) && hasBwClass(x, "ul_bw_class")).sort(byComponentSortKeyDesc(true));
      const fr2Ul = compList.filter((x) => !isFr1(x) && hasBwClass(x, "ul_bw_class")).sort(byComponentSortKeyDesc(true));
      const row = {
        "FR1 DL": fr1Dl.map((x) => `${x.band}${x.dl_bw_class}`).join(" + "),
        "FR1 MIMO DL": fr1Dl.map((x) => formatMimo(x.dl_antenna)).join(" + "),
        "FR1 DL (QAM)": fr1Dl.length ? "256" : "",
        "FR1 SCS DL (kHz)": fr1Dl.map((x) => formatScsForComp(x, false)).join(" + "),
        "FR1 BW DL (MHz)": fr1Dl.map((x) => formatBw(dictGet(x, "dl_bandwidth", ""))).join(" + "),
        "FR2 DL": fr2Dl.map((x) => `${x.band}${x.dl_bw_class}`).join(" + "),
        "FR2 MIMO DL": fr2Dl.map((x) => formatMimo(x.dl_antenna)).join(" + "),
        "FR2 DL (QAM)": fr2Dl.length ? "256" : "",
        "FR2 SCS DL (kHz)": fr2Dl.map((x) => formatScsForComp(x, false)).join(" + "),
        "FR2 BW DL (MHz)": fr2Dl.map((x) => formatBw(dictGet(x, "dl_bandwidth", ""))).join(" + "),
        "FR1 UL": fr1Ul.map((x) => `${x.band}${x.ul_bw_class}`).join(" + "),
        "FR1 MIMO UL": fr1Ul.map((x) => formatMimo(x.ul_antenna)).join(" + "),
        "FR1 UL (QAM)": qamCell(fr1Ul),
        "FR1 SCS UL (kHz)": fr1Ul.map((x) => formatScsForComp(x, true)).join(" + "),
        "FR1 BW UL (MHz)": fr1Ul.map((x) => formatBw(dictGet(x, "ul_bandwidth", ""))).join(" + "),
        "FR2 UL": fr2Ul.map((x) => `${x.band}${x.ul_bw_class}`).join(" + "),
        "FR2 MIMO UL": fr2Ul.map((x) => formatMimo(x.ul_antenna)).join(" + "),
        "FR2 UL (QAM)": qamCell(fr2Ul),
        "FR2 SCS UL (kHz)": fr2Ul.map((x) => formatScsForComp(x, true)).join(" + "),
        "FR2 BW UL (MHz)": fr2Ul.map((x) => formatBw(dictGet(x, "ul_bandwidth", ""))).join(" + "),
      };
      if (hasNrdcBcs) {
        row["BCS"] = bcs;
      }
      nrdcRows.push(row);
    }
  }

  return {
    lte_ca: ltecaRows,
    nr_ca: nrcaRows,
    endc: endcRows,
    nrdc: nrdcRows,
  };
}

// --- CSV/JSON exports (analyzer.py:1191-1221, :1504-1525, :1622-1701) -----------

// Excel formula guard from the comparison CSV writer (:2543): f'="{value}"'
// for formula-lookalike cells (the leading "=" is the marker; the payload is
// wrapped), then csv-quoted (QUOTE_MINIMAL). Plain values pass through.
export function csvField(value) {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (s.startsWith("=")) s = `="${s.slice(1)}"`;
  if (/[",\r\n]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

// _cell: container values are JSON-dumped compactly (:1191-1194).
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return value;
}

// _write_csv: header is the first-seen key union over all rows, utf-8-sig BOM,
// CRLF line endings, missing keys write empty fields.
export function toCsvText(rows) {
  if (!rows || rows.length === 0) return null;
  const fields = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        fields.push(key);
      }
    }
  }
  const lines = [fields.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(fields.map((f) => csvField(hasOwn(row, f) ? csvCell(row[f]) : "")).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// _json_safe drops the diag section (:1187-1188).
function jsonSafe(parsed) {
  const out = {};
  for (const key of Object.keys(parsed)) {
    if (key !== "diag") out[key] = parsed[key];
  }
  return out;
}

// export_module writes {stem}_all_combos.json (indent=2 + trailing newline),
// {stem}_combinations.csv + {stem}_components.csv, and the per-table web CSVs.
// Python returns written file paths; the browser needs the bytes, so every
// produced file comes back as { filename, text }. "mbn" (raw blob dump) and
// the DIAG exports are handled by the UI layer, which owns the blob.
export function exportModule(record, parsed, format) {
  const stem = pyStem(record.name);
  const files = [];

  if (format === "json") {
    const text = JSON.stringify(jsonSafe(parsed), (key, value) => (typeof value === "bigint" ? value.toString() : value), 2) + "\n";
    files.push({ filename: `${stem}_all_combos.json`, text });
    return files;
  }

  if (format === "csv") {
    for (const [suffix, rows] of [["combinations", parsed.combinations], ["components", parsed.components]]) {
      const text = toCsvText(rows);
      if (text !== null) files.push({ filename: `${stem}_${suffix}.csv`, text });
    }
    return files;
  }

  if (format === "webcsv") {
    const tables = generateWebTables(parsed.combinations, parsed.components);
    const names = { lte_ca: "lteca", nr_ca: "nrca", endc: "endc", nrdc: "nrdc" };
    for (const table of ["lte_ca", "nr_ca", "endc", "nrdc"]) {
      if (!tables[table] || tables[table].length === 0) continue;
      const text = toCsvText(tables[table]);
      if (text !== null) files.push({ filename: `${stem}_${names[table]}.csv`, text });
    }
    return files;
  }

  throw new ToolError(`Unsupported export format: ${format}`);
}
