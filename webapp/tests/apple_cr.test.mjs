// Apple CR bank parser tests (plan Task 3). The core gate: generateAppleTables
// must deep-equal (deepEqualOrdered) the python-generated golden tables for ALL
// 58 banks, and the b0cd/b826 DIAG texts must be byte-equal to the goldens.
// Audit-parity corruption fixtures derive their byte offsets from the layout
// constants and a clean parse at test runtime (no blind hardcoded offsets).
import test from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { CORPUS_DIR, deepEqualOrdered } from "./helpers.mjs";
import {
  parseAppleBank,
  requireValidBank,
  generateAppleTables,
  exportAppleDiag,
  detectLayout,
  decodeBandwidth,
  componentClass,
  b826V22Component,
  packetiseB0cd,
  inspectAppleBank,
  HEAD_TABLES,
} from "../js/lib/apple_cr.js";

const REF = join(CORPUS_DIR, "apple-c-modem-parser");
const corpusAvailableForApple = () =>
  existsSync(join(REF, "c1", "ftab.bin")) && existsSync(join(REF, "c2", "ftab_cr_banks"));
// tables.json/diag.json are oversized reference dumps (317/142 MB) excluded
// from git; regenerate locally from the corpus — tests skip without them.
const appleGoldenDumpsAvailable = () =>
  existsSync(new URL("../goldens/apple/tables.json", import.meta.url)) &&
  existsSync(new URL("../goldens/apple/diag.json", import.meta.url));
const appleDifferentialAvailable = () => corpusAvailableForApple() && appleGoldenDumpsAvailable();

const loadManifest = () => readFile(new URL("../goldens/apple/manifest.json", import.meta.url)).then(JSON.parse);
const loadGolden = (name) => readFile(new URL(`../goldens/apple/${name}.json`, import.meta.url)).then(JSON.parse);
const bankPath = (key) => {
  const [layout, stem] = key.split("/");
  return join(REF, layout, "ftab_cr_banks", `${stem}.bin`);
};

test("apple_cr: tables differential — all 58 banks equal the python goldens", { skip: !appleDifferentialAvailable() }, async () => {
  const [golden, manifest] = await Promise.all([loadGolden("tables"), loadManifest()]);
  const keys = Object.keys(manifest);
  assert.equal(keys.length, 58);
  for (const key of keys) {
    const bank = await readFile(bankPath(key));
    const stem = key.split("/")[1];
    const parsed = parseAppleBank(bank, stem);
    requireValidBank(parsed); // Python audit was clean — must stay clean
    const tables = generateAppleTables(parsed);
    deepEqualOrdered(tables, golden[key]);
  }
});

test("apple_cr: DIAG differential — b0cd/b826 byte-equal for all 58 banks", { skip: !appleDifferentialAvailable() }, async () => {
  const [golden, manifest] = await Promise.all([loadGolden("diag"), loadManifest()]);
  for (const key of Object.keys(manifest)) {
    const bank = await readFile(bankPath(key));
    const stem = key.split("/")[1];
    const parsed = parseAppleBank(bank, stem);
    const [b0cd] = exportAppleDiag(parsed, "b0cd");
    const [b826] = exportAppleDiag(parsed, "b826");
    assert.equal(b0cd.filename, `${stem}_0xB0CD_v41.txt`, key);
    assert.equal(b826.filename, `${stem}_0xB826_v22.txt`, key);
    assert.equal(b0cd.text, golden[key].b0cd, `${key}: b0cd text`);
    assert.equal(b826.text, golden[key].b826, `${key}: b826 text`);
  }
});

test("inspectAppleBank matches python inspect_bank for all 58 banks", { skip: !corpusAvailableForApple() }, async () => {
  const manifest = await loadManifest();
  let n = 0;
  for (const key of Object.keys(manifest)) {
    const bank = await readFile(bankPath(key)); // pre-decompressed ftab fixture bank
    const info = inspectAppleBank(bank);
    const exp = manifest[key].inspect;
    assert.deepEqual(
      {
        layout: info.layout,
        lte: info.lteCount,
        endc: info.endcCount,
        nrca: info.nrcaCount,
        nrdc: info.nrdcCount,
        base: info.baseCounts,
        companions: info.companionCount,
      },
      {
        layout: manifest[key].layout,
        lte: exp.lte_count,
        endc: exp.endc_count,
        nrca: exp.nrca_count,
        nrdc: exp.nrdc_count,
        base: exp.base_candidates,
        companions: exp.companion_count,
      },
      key
    );
    n++;
  }
  assert.equal(n, 58);
});

// --- audit parity (corruption fixtures) -----------------------------------------
// Each fixture copies the clean CR04 (c2) bank bytes, patches specific fields at
// offsets derived from the C4020 layout constants / a clean parse, and requires
// requireValidBank to reject it naming the matching audit counter.

async function cleanCr04() {
  const bank = await readFile(bankPath("c2/CR04"));
  const parsed = parseAppleBank(bank, "CR04");
  requireValidBank(parsed);
  return { bank, parsed };
}

test("apple_cr: audit fixture (a) companion row index >= physical count -> nr_physical_row_oob", async () => {
  const { bank, parsed } = await cleanCr04();
  const layout = detectLayout(bank);
  const physicalCount = new DataView(bank.buffer, bank.byteOffset, bank.byteLength).getUint32(layout.physical.count_offset, true);
  const variant = parsed.nr_candidates[0].variants[0];
  const indexBits = layout.physical_index_bits;
  const fwOff = HEAD_TABLES.companions.base + variant.companion_index * HEAD_TABLES.companions.stride + 8;
  const dv = new DataView(bank.buffer, bank.byteOffset, bank.byteLength);
  const fw = dv.getBigUint64(fwOff, true);
  const badRow = Math.min(physicalCount, (1 << indexBits) - 1); // >= count -> out of range
  dv.setBigUint64(fwOff, (fw & ~((1n << BigInt(indexBits)) - 1n)) | BigInt(badRow), true);
  const corrupted = parseAppleBank(bank, "CR04");
  assert.throws(() => requireValidBank(corrupted), /nr_physical_row_oob/);
});

test("apple_cr: audit fixture (b) matrix start beyond table -> nr_feature_matrix_oob", async () => {
  const { bank, parsed } = await cleanCr04();
  const dv = new DataView(bank.buffer, bank.byteOffset, bank.byteLength);
  const layout = detectLayout(bank);
  // Pick a variant whose feature expansion actually ran (matrix_count >= 1).
  let variant = null;
  for (const c of parsed.nr_candidates) {
    for (const v of c.variants) {
      if (v.matrix_count >= 1) {
        variant = v;
        break;
      }
    }
    if (variant) break;
  }
  assert.ok(variant, "no expandable companion found");
  const nrCount = dv.getUint32(layout.matrix_nr.count_offset, true);
  const endcCount = dv.getUint32(layout.matrix_endc.count_offset, true);
  const badStart = Math.max(nrCount, endcCount); // >= whichever table is used
  const h0Off = HEAD_TABLES.companions.base + variant.companion_index * HEAD_TABLES.companions.stride;
  const h0 = dv.getBigUint64(h0Off, true);
  let patched = (h0 & ~(0xfffffn << 12n)) | (BigInt(badStart) << 12n);
  if ((h0 >> 52n) & 0xffn) {
    patched = (patched & ~(0xffn << 52n)) | ((h0 >> 52n) & 0xffn) << 52n; // keep matrix_count
  } else {
    patched |= 1n << 52n; // ensure at least one feature row is expanded
  }
  dv.setBigUint64(h0Off, patched, true);
  const corrupted = parseAppleBank(bank, "CR04");
  assert.throws(() => requireValidBank(corrupted), /nr_feature_matrix_oob/);
});

test("apple_cr: audit fixture (c) dl group ref_count > 9 -> nr_feature_group_oob", async () => {
  const { bank, parsed } = await cleanCr04();
  const layout = detectLayout(bank);
  // Derive a referenced DL feature-group index from the clean parse.
  let groupIndex = null;
  for (const c of parsed.nr_candidates) {
    for (const v of c.variants) {
      for (const fv of v.feature_variants) {
        for (const comp of fv.components) {
          const g = comp.dl_feature_group;
          if (g && !g.out_of_range) {
            groupIndex = g.index;
            break;
          }
        }
        if (groupIndex !== null) break;
      }
      if (groupIndex !== null) break;
    }
    if (groupIndex !== null) break;
  }
  assert.ok(groupIndex !== null, "no referenced dl feature group found");
  const dv = new DataView(bank.buffer, bank.byteOffset, bank.byteLength);
  const rcOff = layout.dl_groups.base + groupIndex * 20 + 8; // u16; ref_count = value >> 12
  dv.setUint16(rcOff, 0xf000, true); // ref_count = 15 > 9
  const corrupted = parseAppleBank(bank, "CR04");
  assert.throws(() => requireValidBank(corrupted), /nr_feature_group_oob/);
});

test("apple_cr: audit fixture (d) lte reference beyond candidates -> lte_reference_oob", async () => {
  const { bank } = await cleanCr04();
  const dv = new DataView(bank.buffer, bank.byteOffset, bank.byteLength);
  const lteCount = new DataView(bank.buffer, bank.byteOffset, bank.byteLength).getUint32(HEAD_TABLES.lte_candidates.count_offset, true);
  dv.setUint16(HEAD_TABLES.lte_references.base, 0xffff, true); // >= lteCount
  assert.ok(0xffff >= lteCount);
  const corrupted = parseAppleBank(bank, "CR04");
  assert.throws(() => requireValidBank(corrupted), /lte_reference_oob/);
});

test("apple_cr: CR12 (c2) parses with tables.nrdc empty but present", { skip: !corpusAvailableForApple() }, async () => {
  const bank = await readFile(bankPath("c2/CR12"));
  const parsed = parseAppleBank(bank, "CR12");
  requireValidBank(parsed);
  const tables = generateAppleTables(parsed);
  assert.ok(Array.isArray(tables.nrdc));
  assert.equal(tables.nrdc.length, 0);
  assert.ok("nrdc" in tables);
});

// --- unit pins on pure helpers ----------------------------------------------------

test("apple_cr: bandwidth code maps (FR1 list, SPECIAL {12:35,13:45,14:70}, FR2 list)", () => {
  const fr1 = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
  fr1.forEach((mhz, i) => assert.equal(decodeBandwidth(i + 1, false), mhz));
  assert.equal(decodeBandwidth(12, false), 35);
  assert.equal(decodeBandwidth(13, false), 45);
  assert.equal(decodeBandwidth(14, false), 70);
  assert.equal(decodeBandwidth(15, false), null);
  assert.equal(decodeBandwidth(0, false), null);
  const fr2 = [50, 100, 200, 400];
  fr2.forEach((mhz, i) => assert.equal(decodeBandwidth(i + 1, true), mhz));
  assert.equal(decodeBandwidth(5, true), null);
  assert.equal(decodeBandwidth(12, true), null);
});

test("apple_cr: CLASS_MAP letter mapping (FR1 vs FR2 tables)", () => {
  assert.deepEqual(componentClass(1, "LTE", 1), ["A", 1]);
  assert.deepEqual(componentClass(2, "LTE", 3), ["B", 2]);
  assert.deepEqual(componentClass(3, "NR", 100), ["C", 2]);
  assert.deepEqual(componentClass(4, "NR", 100), ["D", 3]);
  assert.deepEqual(componentClass(6, "NR", 100), ["F", 5]);
  // CLASS_MAP only holds codes 1..6; others are unknown.
  assert.deepEqual(componentClass(8, "NR", 100), ["?", 0]);
  assert.deepEqual(componentClass(16, "NR", 100), ["?", 0]);
  // FR2 table applies for NR bands > 256.
  assert.deepEqual(componentClass(3, "NR", 257), ["C", 3]);
  assert.deepEqual(componentClass(4, "NR", 258), ["D", 2]);
  assert.deepEqual(componentClass(7, "NR", 260), ["G", 2]);
  assert.deepEqual(componentClass(15, "NR", 260), ["O", 2]);
  assert.deepEqual(componentClass(18, "NR", 260), ["R2", 2]);
});

test("apple_cr: b826 v22 10-byte wire pack round-trips on a synthetic record", () => {
  const bg = {
    band: 257,
    tech: 2,
    dl_bw_class: 5,
    dl_bw_per_cc: 6,
    ul_bw_class: 3,
    ul_bw_per_cc: 7,
    dl_max_antennas_index: 9,
    ul_max_antennas_index: 6,
    ul_qam_cap_index: 2,
  };
  const packed = b826V22Component(bg);
  assert.equal(packed.length, 10);
  assert.deepEqual([...packed.slice(7)], [0, 0, 0]);
  const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const head = dv.getUint16(0, true);
  const b1 = packed[2], b2 = packed[3], b3 = packed[4], b4 = packed[5], b5 = packed[6];
  const unpacked = {
    band: head & 0x1ff,
    tech: (head >> 9) & 1 ? 2 : 1,
    dl_bw_class: (head >> 10) & 0x1f,
    dl_max_antennas_index: (((head >> 15) & 1) | ((b1 & 0x3f) << 1)),
    ul_bw_class: (b1 >> 6) | ((b2 & 7) << 2),
    ul_max_antennas_index: (b2 >> 3) & 0x1f,
    ul_qam_cap_index: ((b3 >> 2) & 1) | (((b3 >> 1) & 1) << 1),
    dl_bw_per_cc: ((b3 >> 7) & 1) | ((b4 & 0x3f) << 1),
    ul_bw_per_cc: (b4 >> 6) | ((b5 & 0x1f) << 2),
  };
  assert.deepEqual(unpacked, bg);
});

test("apple_cr: b0cd packet boundary at 100 combos", () => {
  const blobs = [];
  for (let i = 0; i < 150; i++) blobs.push(new Uint8Array([1, 2, 3, 4]));
  const packets = packetiseB0cd(blobs, 100);
  assert.equal(packets.length, 2);
  assert.equal(packets[0][0], 41);
  assert.equal(packets[0][1], 100);
  assert.equal(packets[1][0], 41);
  assert.equal(packets[1][1], 50);
  assert.equal(packets[0].length, 2 + 100 * 4);
  assert.equal(packets[1].length, 2 + 50 * 4);
});
