// Webapp equivalent of the MTK GUI backend (mtk-drdi-combo-parser main.py
// MtkBackend + select_loader + the viewer's build_tables + the B0CD/B826 part
// of export_selected_formats). One modem source (unwrapped parts) becomes a
// list of profile cards; each card's tables come from the summarize snapshot,
// and each card's DIAG export re-runs a fresh extraction exactly like the
// desktop GUI's extract_and_export.
import {
  Combo, NrCC, NrComponent, LteComponent, dedupExact, comboKey, classify,
  buildB826, combinedB826Text, b0cdText,
} from "./export.js";
import {
  Reporter, UniversalError, GridLoader, FlatLoader, TensorCdfLoader, tensorProbe,
  gridDescriptorHits, extractCapability, guiFamilyCounts, scanLteRowsBank,
} from "./universal.js";
import { Nr15Loader, nr15Probe } from "./nr15.js";
import { decodeTensorSecondary } from "./tensor_secondary.js";
import { findBytes } from "./containers.js";

const MOLY_NR15 = [..."MOLY.NR15."].map((c) => c.charCodeAt(0));

// select_loader(args.loader="auto"): returns the first loader that proves itself.
export async function selectLoader(parts, rep = new Reporter()) {
  const { rom, drdi, drdi_data: data } = parts;
  if (data) {
    if (!tensorProbe(drdi)) {
      throw new UniversalError("--drdi is not a recognized split-CDF header (expected 0x30000 bytes, 641 slot offsets, 11 bounds, 640 SHA-384 digests)");
    }
    return TensorCdfLoader.create(rom, drdi, data, rep);
  }
  const attempts = [];
  if (nr15Probe(rom, drdi) || findBytes(rom, MOLY_NR15) >= 0) {
    try {
      return new Nr15Loader(rom, drdi, rep);
    } catch (err) {
      if (!(err instanceof UniversalError)) throw err;
      attempts.push({ loader: "nr15", reason: err.message });
    }
  }
  try {
    const loader = new GridLoader(rom, drdi, rep, gridDescriptorHits(rom, drdi.length));
    loader.capability_bank();
    return loader;
  } catch (err) {
    if (!(err instanceof UniversalError)) throw err;
    attempts.push({ loader: "grid", reason: err.message });
  }
  try {
    return new FlatLoader(rom, drdi, rep);
  } catch (err) {
    if (!(err instanceof UniversalError)) throw err;
    attempts.push({ loader: "flat", reason: err.message });
  }
  throw new UniversalError(`no container loader accepted this image; attempts: ${JSON.stringify(attempts)}`);
}

// _secondary_combos: the secondary decoder's dictionaries as shared rows.
function secondaryCombos(profile) {
  const out = profile.combos.map((row) => new Combo(
    (row.lte || []).map((c) => new LteComponent(c.band, c.dl_class, c.ul_class, [...(c.dl_mimo || [])])),
    (row.nr || []).map((c) => new NrComponent(c.band, c.dl_class, c.ul_class,
      (c.ccs || []).map((cc) => new NrCC(cc.scs_khz, cc.dl_mimo, cc.dl_bw_mhz ?? null, cc.ul_mimo ?? null, cc.ul_bw_mhz ?? null)))),
  ));
  return dedupExact(out);
}

const cacheKey = (bank, profile) => `${bank}|${profile}`;

// MtkBackend.summarize(retain_combos=True) + profile_records. Returns
// { loader, cards: [{bank, profile, counts, bankOnly}], snapshot: Map }.
export async function summarizeMtk(parts) {
  const rep = new Reporter();
  const active = await selectLoader(parts, rep);
  const { cap, states, perProfile, unresolved, lteBank, lteProfiles } = extractCapability(active, "all", rep);
  const physical = active instanceof TensorCdfLoader;
  const secondary = physical ? decodeTensorSecondary(active, 8, rep) : [];

  const snapshot = new Map();
  for (const [p, combos] of perProfile) {
    const lteRows = physical
      ? (active.lte_rows_by_bank?.get(cap.table_index)?.get(p) ?? [])
      : (lteProfiles.get(p) ?? []);
    snapshot.set(cacheKey(cap.table_index, p), { nr: combos, lte: dedupExact(lteRows), unresolved: unresolved.includes(p) });
  }
  for (const item of secondary) snapshot.set(cacheKey(item.bank_index, item.profile), { nr: secondaryCombos(item), lte: [] });
  if (physical) {
    for (const [bank, profiles] of active.lte_rows_by_bank || new Map()) {
      for (const [p, rows] of profiles) {
        const key = cacheKey(bank, p);
        if (!snapshot.has(key)) snapshot.set(key, { nr: [], lte: [] });
        snapshot.get(key).lte = dedupExact(rows);
      }
    }
  }

  // profile_records
  const lteCount = (p) => (lteProfiles.has(p) ? lteProfiles.get(p).length : 0);
  let cards = states.map((s) => {
    const g = guiFamilyCounts(perProfile.get(s.image.profile));
    return { bank: cap.table_index, profile: s.image.profile, bankOnly: false,
      counts: { lte: lteCount(s.image.profile), endc: g.endc, nr_sa: g.nr_sa, nrca: g.nrca, nrdc: g.nrdc } };
  });
  for (const item of secondary) {
    const g = guiFamilyCounts(secondaryCombos(item));
    cards.push({ bank: item.bank_index, profile: item.profile, bankOnly: false, secondary: true,
      counts: { lte: 0, endc: g.endc, nr_sa: g.nr_sa, nrca: g.nrca, nrdc: g.nrdc } });
  }
  if (physical) {
    const phys = active.lte_rows_by_bank || new Map();
    const physCount = (bank, p) => (phys.get(bank)?.get(p) ? dedupExact(phys.get(bank).get(p)).length : 0);
    for (const c of cards) {
      c.counts.lte = physCount(c.bank, c.profile);
      c.bankOnly = true;
    }
    const indexed = new Set(cards.map((c) => cacheKey(c.bank, c.profile)));
    for (const [bank, profiles] of phys) {
      for (const [p, rows] of profiles) {
        if (indexed.has(cacheKey(bank, p))) continue;
        cards.push({ bank, profile: p, bankOnly: true, counts: { lte: dedupExact(rows).length, endc: 0, nrca: 0, nrdc: 0 } });
      }
    }
    cards.sort((a, b) => a.bank - b.bank || a.profile - b.profile);
  }
  if (!cards.length) throw new UniversalError("no validated capability profiles were discovered");
  // `active` is kept so exports can reuse the proven loader (its caches are
  // deterministic; parity with fresh per-export loaders is pinned by
  // tools/mtk-parity.mjs) instead of re-unwrapping and re-validating.
  return { loader: active.name, active, lteBankIndex: lteBank ? lteBank.table_index : null, cards, snapshot };
}

// --- viewer tables (mtk_viewer.build_tables) ------------------------------------------

export const FAMILY_KEYS = { LTE: "lte_ca", "NR SA (1CC)": "nr_sa", "NR-CA": "nr_ca", "EN-DC": "endc", NRDC: "nrdc" };

const classLabel = (v) => (v >= 0 && v < 26 ? String.fromCharCode(65 + v) : `[${v}]`);

function familyFor(combo) {
  if (combo.lte.length) return combo.nr.length ? "EN-DC" : "LTE";
  if (!combo.nr.length) return null;
  if (combo.nr.some((c) => c.band < 257) && combo.nr.some((c) => c.band >= 257)) return "NRDC";
  return combo.nr_physical_ccs === 1 ? "NR SA (1CC)" : "NR-CA";
}

// Qualcomm presentation: descending band/class order (stable sort).
function ordered(components, ul = false) {
  return components
    .filter((c) => !ul || c.has_ul)
    .sort((a, b) => b.band - a.band || (ul ? b.ul_class - a.ul_class : b.dl_class - a.dl_class));
}

const bands = (components, ul = false) => components.map((c) => `${c.band}${classLabel(ul ? c.ul_class : c.dl_class)}`).join(" + ");
const values = (vals) => vals.map((v) => (v === null || v === undefined ? "?" : String(v))).join(" + ");

function nrValues(components, field, ul = false) {
  const out = [];
  for (const c of components) for (const cc of c.ccs) if (!ul || cc.ul_mimo !== null) out.push(cc[field]);
  return values(out);
}

function nrColumns(dl, ul, prefix = "") {
  return {
    [`${prefix}MIMO DL`]: nrValues(dl, "dl_mimo"),
    [`${prefix}SCS DL (kHz)`]: nrValues(dl, "scs_khz"),
    [`${prefix}BW DL (MHz)`]: nrValues(dl, "dl_bw_mhz"),
    [`${prefix}MIMO UL`]: nrValues(ul, "ul_mimo", true),
    [`${prefix}SCS UL (kHz)`]: nrValues(ul, "scs_khz", true),
    [`${prefix}BW UL (MHz)`]: nrValues(ul, "ul_bw_mhz", true),
  };
}

// Columns are only what the MTK decoder supplies (no LTE BW/SCS/UL MIMO, QAM,
// BCS or UL TX switch). Returns tables keyed by webapp table key.
export function buildMtkTables(lteRows, nrRows) {
  const tables = { lte_ca: [], nr_sa: [], nr_ca: [], endc: [], nrdc: [] };
  const seen = new Set();
  for (const rows of [lteRows, nrRows]) {
    for (const combo of rows) {
      const family = familyFor(combo);
      const key = comboKey(combo);
      if (family === null || seen.has(key)) continue;
      seen.add(key);
      const lteDl = ordered(combo.lte), lteUl = ordered(combo.lte, true);
      const nrDl = ordered(combo.nr), nrUl = ordered(combo.nr, true);
      const lteMimo = values(lteDl.flatMap((c) => c.dl_mimo));
      let row;
      if (family === "LTE") {
        row = { "LTE DL": bands(lteDl), "MIMO DL": lteMimo, "LTE UL": bands(lteUl, true) };
      } else if (family === "EN-DC") {
        const f = nrColumns(nrDl, nrUl, "NR ");
        row = {
          "LTE DL": bands(lteDl), "LTE MIMO DL": lteMimo,
          "NR DL": bands(nrDl), "NR MIMO DL": f["NR MIMO DL"],
          "NR SCS DL (kHz)": f["NR SCS DL (kHz)"], "NR BW DL (MHz)": f["NR BW DL (MHz)"],
          "LTE UL": bands(lteUl, true), "NR UL": bands(nrUl, true),
          "NR MIMO UL": f["NR MIMO UL"], "NR SCS UL (kHz)": f["NR SCS UL (kHz)"], "NR BW UL (MHz)": f["NR BW UL (MHz)"],
        };
      } else if (family === "NRDC") {
        row = {};
        const groups = {};
        for (const fr of ["FR1", "FR2"]) {
          groups[fr] = [nrDl.filter((c) => (c.band < 257) === (fr === "FR1")), nrUl.filter((c) => (c.band < 257) === (fr === "FR1"))];
        }
        for (const direction of ["DL", "UL"]) {
          for (const fr of ["FR1", "FR2"]) {
            const [dl, ul] = groups[fr];
            const f = nrColumns(dl, ul, `${fr} `);
            row[`${fr} ${direction}`] = bands(direction === "UL" ? ul : dl, direction === "UL");
            for (const feature of ["MIMO", "SCS", "BW"]) {
              const name = `${fr} ${feature} ${direction}${feature === "SCS" ? " (kHz)" : feature === "BW" ? " (MHz)" : ""}`;
              row[name] = f[name];
            }
          }
        }
      } else {
        const f = nrColumns(nrDl, nrUl);
        row = { "NR DL": bands(nrDl) };
        for (const [name, value] of Object.entries(f)) if (name.includes(" DL")) row[name] = value;
        row["NR UL"] = bands(nrUl, true);
        for (const [name, value] of Object.entries(f)) if (name.includes(" UL")) row[name] = value;
      }
      tables[FAMILY_KEYS[family]].push(row);
    }
  }
  return tables;
}

export function snapshotTables(summary, bank, profile) {
  const entry = summary.snapshot.get(cacheKey(bank, profile));
  if (!entry) throw new UniversalError(`no combo snapshot for bank ${bank} / profile ${profile}`);
  return buildMtkTables(entry.lte, entry.nr);
}

// --- per-card DIAG export (extract_and_export with formats {b0cd, b826}) ------------

function exportTexts(combos, lteCombos, device, formats) {
  const out = {};
  if (formats.has("b826")) {
    const [endc, nrAll] = classify(combos, 1);
    const isNrdc = (row) => row.nr.some((c) => c.band < 257) && row.nr.some((c) => c.band >= 257);
    const nrdc = nrAll.filter(isNrdc);
    const nrca = nrAll.filter((row) => !nrdc.includes(row));
    const results = [buildB826(endc, 3), buildB826(nrca, 4)];
    if (nrdc.length) results.push(buildB826(nrdc, 5));
    out.b826 = combinedB826Text(results, device);
  }
  if (formats.has("b0cd")) out.b0cd = b0cdText(lteCombos, device);
  return out;
}

// Returns {b0cd?, b826?} texts for one card; formats a card has no rows for
// (bank-only cards) are skipped, as the desktop GUI does.
export async function exportMtkCard(parts, card, device, formats = new Set(["b0cd", "b826"]), { loader: reuse = null } = {}) {
  const rep = new Reporter();
  const loader = reuse ?? await selectLoader(parts, rep);
  const profileArg = String(card.profile);
  if (card.bankOnly) {
    if (loader.name === "nr15") throw new UniversalError("NR15 bank-only extraction is not implemented; select a capability profile");
    const cap = loader.capability_bank();
    const bank = loader.banks.find((b) => b.table_index === card.bank);
    if (!bank) throw new UniversalError(`bank ${card.bank} does not exist`);
    const selected = bank.images.map((im) => im.profile).filter((p) => p === card.profile);
    if (!selected.length) throw new UniversalError(`profile ${card.profile} is not live in bank ${card.bank}`);
    let combos = [];
    if (bank.table_index === cap.table_index) {
      const r = extractCapability(loader, profileArg, rep);
      if (r.unresolved.length) throw new UniversalError(`unresolved profiles: ${JSON.stringify(r.unresolved)}`);
      combos = r.union;
    } else if (loader instanceof TensorCdfLoader && bank.table_index === 8) {
      const decoded = decodeTensorSecondary(loader, 8, rep).filter((p) => selected.includes(p.profile));
      if (new Set(decoded.map((p) => p.profile)).size !== new Set(selected).size) {
        throw new UniversalError("selected secondary profiles did not pass structural validation");
      }
      combos = dedupExact(decoded.flatMap((p) => secondaryCombos(p)));
    }
    let lteProfiles;
    if (loader instanceof FlatLoader) [, lteProfiles] = loader.lte_tables(cap, rep);
    else lteProfiles = loader.lte_rows_by_bank?.get(bank.table_index) ?? scanLteRowsBank(bank, loader.tables);
    const lte = dedupExact([...lteProfiles].filter(([p]) => selected.includes(p)).flatMap(([, rows]) => rows));
    const effective = new Set([...formats].filter((f) => (f === "b826" && combos.length) || (f === "b0cd" && lte.length)));
    return effective.size ? exportTexts(combos, lte, device, effective) : {};
  }
  const r = extractCapability(loader, profileArg, rep);
  return exportTexts(r.union, r.lteUnion, device, formats);
}

export { cacheKey as mtkCacheKey };
