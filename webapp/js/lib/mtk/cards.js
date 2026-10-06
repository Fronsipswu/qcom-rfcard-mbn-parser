// MediaTek sources as webapp cards: detection, scan into card records, and the
// per-card table / DIAG operations the worker calls. Everything here wraps the
// parity-checked port (containers.js, backend.js); this file only adapts it to
// the card/record model the UI shares with Qualcomm and Apple.
import { roleOf, unwrapBytes, unwrapFiles, UnwrapError, MTK_MAGIC } from "./containers.js";
import { summarizeMtk, snapshotTables, exportMtkCard } from "./backend.js";
import { sha256Hex } from "../hash.js";

export const MTK_GENERATION = "MediaTek DRDI";
// Largest single input read whole into memory for MTK unwrapping.
export const MTK_MAX_INPUT_BYTES = 1024 * 1024 * 1024;

export { roleOf as mtkPartRole, UnwrapError };

// Cheap pre-check on the first bytes: MTK partition header or HBLR bundle. Other
// MTK packagings (ext4 / sparse / gzip) are tried after the Qualcomm scan finds
// no RF cards.
export function looksLikeMtk(head) {
  const at0 = (sig) => sig.every((b, i) => head[i] === b);
  return at0(MTK_MAGIC) || at0([0x48, 0x42, 0x4c, 0x52]);
}

// Python main.safe_stem.
export function safeStem(text) {
  const value = String(text).trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
  return value.slice(0, 80) || "mtk";
}

const stemOf = (name) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

// One unwrapped modem -> {summary, parts, stem, records}. `label` names the
// source (file name or parts-set folder); `stem` is what exports are named by
// (the desktop GUI uses the source path stem).
async function cardsFor(parts, label, stem) {
  const summary = await summarizeMtk(parts);
  const selected = parts.report.selected;
  const identity = sha256Hex(new TextEncoder().encode(JSON.stringify(Object.keys(selected).sort().map((k) => [k, selected[k].sha256]))));
  const records = summary.cards.map((card) => {
    const c = card.counts;
    const nrTotal = c.endc + (c.nrca + (c.nr_sa ?? 0)) + c.nrdc;
    return {
      inner_path: `${label} · bank ${card.bank} / profile ${card.profile}`,
      name: `${stem} bank ${card.bank} profile ${card.profile}`,
      generation: MTK_GENERATION,
      size: null,
      hwid: 0,
      fsid: 0,
      bid: 0,
      external: true,
      source_path: label,
      sidecars: {},
      // Content identity of the modem parts + the card's bank/profile: the
      // table-cache and dedupe key, like a Qualcomm record's sha256.
      sha256: `${identity.slice(0, 40)}-b${card.bank}p${card.profile}`,
      lte_combos: c.lte,
      nr_combos: `${c.endc}+${c.nrca + (c.nr_sa ?? 0)}+${c.nrdc}=${nrTotal}`,
      mtk: { bank: card.bank, profile: card.profile, bankOnly: card.bankOnly, loader: summary.loader, packaging: parts.report.packaging, counts: c },
    };
  });
  return { summary, parts, stem, records };
}

// A single file: an MTK image (md1img, modem.img, tmodem.img ...). Returns null
// when the file is not an MTK modem (UnwrapError), so callers keep their
// Qualcomm result; other errors propagate.
export async function scanMtkFile(file) {
  if (file.size > MTK_MAX_INPUT_BYTES) return null;
  const data = new Uint8Array(await file.arrayBuffer());
  let parts;
  try {
    parts = await unwrapBytes(data, file.name);
  } catch (err) {
    if (err instanceof UnwrapError) return null;
    throw err;
  }
  return cardsFor(parts, file.name, stemOf(file.name));
}

// Extracted parts imported together (md1rom + md1drdi, or md1rom +
// md1drdi_hdr + md1drdi_data), grouped by folder like a parts directory.
export async function scanMtkParts(files) {
  const entries = [];
  for (const { file, dir } of files) {
    if (file.size > MTK_MAX_INPUT_BYTES) throw new UnwrapError(`${file.name} is larger than the ${MTK_MAX_INPUT_BYTES} byte MTK input limit`);
    entries.push({ name: file.name, dir, data: new Uint8Array(await file.arrayBuffer()) });
  }
  const dirs = [...new Set(entries.map((e) => e.dir).filter(Boolean))];
  const label = dirs.length === 1 ? dirs[0].split("/").pop() : "MediaTek parts";
  return cardsFor(await unwrapFiles(entries, label), label, label);
}

export function mtkTables(memo, record) {
  return snapshotTables(memo.summary, record.mtk.bank, record.mtk.profile);
}

const DIAG_NAMES = { b0cd: "0xB0CD_v41.txt", b826: "0xB826_v21_combined.txt" };

// [{filename, text}] for one card and one of b0cd / b826 (none when the card
// has no rows for that family, as in the desktop GUI).
export async function mtkDiagFiles(memo, record, format) {
  const card = { bank: record.mtk.bank, profile: record.mtk.profile, bankOnly: record.mtk.bankOnly };
  const texts = await exportMtkCard(memo.parts, card, memo.stem, new Set([format]), { loader: memo.summary.active });
  if (texts[format] === undefined) return [];
  const base = safeStem(`${memo.stem}_bank${card.bank}_profile${card.profile}`);
  return [{ filename: `${base}_${DIAG_NAMES[format]}`, text: texts[format] }];
}
