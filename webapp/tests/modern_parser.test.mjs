// JS API shape (mirrors gui_version/new_rfcard_parser.py plus the modern
// parse path of qualcomm_rf_combo_analyzer.py):
//   readVarint(u8, pos) -> { value, pos }
//   protobufFields(data) -> Map<fieldNumber, [wire, value][]>
//   protoBytes/protoUint/protoRepeatedUint(fields, number)
//   makeRrcView(payload) -> rrc field object (SimpleNamespace shape)
//   extractRfcDats(blob) -> [{ name, offset, data }] with Python dict
//     semantics: deduped by name, last data wins, first-appearance order
//   datPayloadCandidates(dat) -> [[encoding, payload]]
//   parseResDat(dat) -> { encoding, payload, rrc }
//   decodeNrProperty(raw) / decodeBandGroup(raw) -> plain field objects
//   nrSectionRecords(rrc, prefix, suffix) -> [[groups, prop]]
//   decodeLteCombo(raw) / decodeNrBandGroup(group, bw, ant) -> strings
//   parseModernModule(record, blob) -> { metadata, combinations, components, diag }
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hex, hexToBytes } from "../js/lib/bytes.js";
import { zlibSync } from "../lib/vendor/fflate.js";
import { Fat16Image } from "../js/lib/fat16.js";
import { sourceFor } from "../js/lib/source.js";
import { CORPUS_DIR, corpusAvailable, deepEqualOrdered } from "./helpers.mjs";
import { truncateParse } from "./golden_transform.mjs";
import {
  readVarint,
  protobufFields,
  protoBytes,
  protoUint,
  protoRepeatedUint,
  makeRrcView,
  extractRfcDats,
  datPayloadCandidates,
  parseResDat,
  decodeNrProperty,
  decodeBandGroup,
  decodeLteCombo,
  decodeNrBandGroup,
  enumAssignments,
  reverseEnum,
  parseModernModule,
} from "../js/lib/modern_parser.js";

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);

function concatBytes(arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// Large-EFS item framing consumed by extract_rfc_dats: TLV type 0x0001 +
// uint16 path length (including NUL), the NUL-terminated path, then TLV type
// 0x0002 + uint32 length + payload.
function framedItem(path, data) {
  const p = bytes(path);
  const out = new Uint8Array(4 + p.length + 1 + 6 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 1, true);
  dv.setUint16(2, p.length + 1, true);
  out.set(p, 4);
  out[4 + p.length] = 0;
  dv.setUint16(4 + p.length + 1, 2, true);
  dv.setUint32(4 + p.length + 3, data.length, true);
  out.set(data, 4 + p.length + 1 + 6);
  return out;
}

function namesOf(blob) {
  return extractRfcDats(blob).map((d) => d.name);
}

// Packs 12 bytes using the pinned NRBandGroup bit layout (see the layout test
// below for the Python ctypes derivation).
function packBandGroup(v) {
  const out = new Uint8Array(12);
  const dv = new DataView(out.buffer);
  const u0 = (v.tech & 3) | (v.band & 0x1ff) << 2 | (v.dl_bw_class & 0x1f) << 11
    | (v.dl_bw_per_cc & 0x7f) << 16 | (v.ul_bw_class & 0x1f) << 23;
  const u1 = (v.ul_bw_per_cc & 0x7f) | (v.dl_max_antennas_index & 0x7f) << 7
    | (v.ul_max_antennas_index & 0x7f) << 14 | (v.max_scs & 7) << 21
    | (v.ul_qam_cap_index & 3) << 24 | (v.srs_tx_switch_type & 0xf) << 26
    | (v.tx_switch_impact_to_rx & 3) << 30;
  const u2 = (v.tx_switch_with_another_band & 3) | (v.srs_carrier_hop & 1) << 2
    | (v.srs_carrier_hop_src & 3) << 3 | (v.rx_limit & 1) << 5
    | (v.num_tx_meeting_combo_pc & 3) << 6 | (v.link_id & 3) << 8;
  dv.setUint32(0, u0 >>> 0, true);
  dv.setUint32(4, u1 >>> 0, true);
  dv.setUint32(8, u2 >>> 0, true);
  return out;
}

test("varint uses multiplication (no 32-bit shift overflow)", () => {
  assert.deepEqual(readVarint(hexToBytes("ffffffff0f"), 0), { value: 4294967295, pos: 5 });
  // 1 << 32 would wrap to 0 with a JS shift; must come out as 2**32.
  assert.deepEqual(readVarint(hexToBytes("8080808010"), 0), { value: 4294967296, pos: 5 });
});

test("varint round-trips Python-encoded values", () => {
  // Byte sequences produced by the Python reference encoder for
  // 2**28-1, 2**28, 2**32, 2**35, 2**56 and 2**62.
  const cases = [
    ["ffffff7f", 268435455],
    ["8080808001", 268435456],
    ["8080808010", 4294967296],
    ["808080808001", 34359738368],
    ["808080808080808001", 72057594037927936],
    ["808080808080808040", 4611686018427387904],
  ];
  for (const [h, expected] of cases) {
    assert.equal(readVarint(hexToBytes(h), 0).value, expected);
  }
  assert.deepEqual(readVarint(hexToBytes("01ac02"), 1), { value: 300, pos: 3 });
});

test("varint raises the Python truncation error", () => {
  assert.throws(() => readVarint(new Uint8Array([0x80]), 0), /Truncated protobuf varint/);
  // shift reaches 70 without a terminator: same ValueError in Python
  assert.throws(() => readVarint(new Uint8Array(10).fill(0x80), 0), /Truncated protobuf varint/);
});

test("NRBandGroup 12-byte layout is pinned (Python ctypes derivation)", () => {
  // Derived from the ctypes struct (Python: NRBandGroup(tech=1, band=66,
  // dl_bw_class=0x0a, dl_bw_per_cc=2, ul_bw_per_cc=1) -> 09510200 01000000
  // 00000000): unit0 = tech@0-1, band@2-10, dl_bw_class@11-15,
  // dl_bw_per_cc@16-22, ul_bw_class@23-27; ul_bw_per_cc overflows unit0 and
  // starts unit1 at bit 32 (the 33rd bit).
  //
  // Plan bug note: the Task 7 example encoded band<<6, dl_bw_class<<16 and
  // dl_bw_per_cc<<26, which does not match the real ctypes layout; these
  // values are re-derived from Python instead.
  const g = decodeBandGroup(hexToBytes("095102000100000000000000"));
  assert.equal(g.tech, 1);
  assert.equal(g.band, 66);
  assert.equal(g.dl_bw_class, 0x0a);
  assert.equal(g.dl_bw_per_cc, 2);
  assert.equal(g.ul_bw_class, 0);
  assert.equal(g.ul_bw_per_cc, 1);
  assert.equal(g.dl_max_antennas_index, 0);
  assert.equal(g.ul_max_antennas_index, 0);

  // Full decode pinned against Python-built fixtures.
  // NRBandGroup(tech=2, band=41, dl_bw_class=3, dl_bw_per_cc=21,
  //   ul_bw_class=2, ul_bw_per_cc=4, dl_max_antennas_index=3,
  //   ul_max_antennas_index=2, max_scs=5, ul_qam_cap_index=2,
  //   srs_tx_switch_type=9, tx_switch_impact_to_rx=3,
  //   tx_switch_with_another_band=2, srs_carrier_hop=1, srs_carrier_hop_src=3,
  //   rx_limit=1, num_tx_meeting_combo_pc=2, link_id=1)
  assert.deepEqual(decodeBandGroup(hexToBytes("a61815018481a0e6be010000")), {
    tech: 2, band: 41, dl_bw_class: 3, dl_bw_per_cc: 21, ul_bw_class: 2,
    ul_bw_per_cc: 4, dl_max_antennas_index: 3, ul_max_antennas_index: 2,
    max_scs: 5, ul_qam_cap_index: 2, srs_tx_switch_type: 9,
    tx_switch_impact_to_rx: 3, tx_switch_with_another_band: 2,
    srs_carrier_hop: 1, srs_carrier_hop_src: 3, rx_limit: 1,
    num_tx_meeting_combo_pc: 2, link_id: 1,
  });
  // Every field maxed: unit boundaries must not bleed (Python:
  // all fields (1<<w)-1 -> ffffff0f ffffffff ff030000).
  assert.deepEqual(decodeBandGroup(hexToBytes("ffffff0fffffffffff030000")), {
    tech: 3, band: 0x1ff, dl_bw_class: 0x1f, dl_bw_per_cc: 0x7f, ul_bw_class: 0x1f,
    ul_bw_per_cc: 0x7f, dl_max_antennas_index: 0x7f, ul_max_antennas_index: 0x7f,
    max_scs: 7, ul_qam_cap_index: 3, srs_tx_switch_type: 0xf,
    tx_switch_impact_to_rx: 3, tx_switch_with_another_band: 3,
    srs_carrier_hop: 1, srs_carrier_hop_src: 3, rx_limit: 1,
    num_tx_meeting_combo_pc: 3, link_id: 3,
  });
  assert.throws(() => decodeBandGroup(new Uint8Array(11)), /Short NRBandGroup/);
});

test("NRComboProperty bit-slice decode matches Python", () => {
  // Python decode_nr_property(bytes([0x69, 0xb2, 0x1f, 5, 0x34, 0x12, 0x78,
  // 0x56, 0xbc, 0x9a, 0xde, 0xf0]))
  assert.deepEqual(decodeNrProperty(hexToBytes("69b21f0534127856bc9adef0")), {
    power_class: 1, tdd_ant_swt_fdd_disruption: 1, simultaneousRxTxInterBandENDC: 0,
    simultaneousRxTxInterBandCA: 1, ul_tx_switch_type: 1, intra_contig_type: 2,
    srs_cs_type: 6, intra_ulca_dual_pa: 0, simultaneousRxTxInterBandSUL: 1,
    num_bands: 31, has_bcs5_counterpart: 0, higher_power_limit: 0, bcs_num: 5,
    env_mode_mask_idx: 4660, env_mode_subset_mask_idx: 22136,
    simul_rxtx_bmap_idx: 39612, simul_sul_rxtx_bmap_idx: 61662,
  });
  assert.throws(() => decodeNrProperty(new Uint8Array(11)), /Short NRComboProperty/);
});

test("/rfc/ byte scanner matches the Python regex battery", () => {
  // Ground truth for every case below was produced with the Python
  // extract_rfc_dats implementation.
  assert.deepEqual(
    namesOf(framedItem("/rfc/modem_rfscen_xoo_res.dat", bytes("DATA"))),
    ["/rfc/modem_rfscen_xoo_res.dat"],
  );
  // Two .dat paths sharing a prefix: greedy backtracking keeps both.
  assert.deepEqual(
    namesOf(concatBytes([framedItem("/rfc/x.dat", bytes("D1")), framedItem("/rfc/x.dat.dat", bytes("D2"))])),
    ["/rfc/x.dat", "/rfc/x.dat.dat"],
  );
  // Greedy match extends over an inner .dat: one full name, not two.
  assert.deepEqual(namesOf(framedItem("/rfc/a.dat.dat", bytes("D"))), ["/rfc/a.dat.dat"]);
  // The regex requires NUL termination: CR/LF ends the allowed run but can
  // never complete a match.
  assert.deepEqual(namesOf(framedItem("/rfc/a.dat\rjunk", bytes("D"))), []);
  assert.deepEqual(namesOf(framedItem("/rfc/a.dat\nmore.dat", bytes("D"))), []);
  // Allowed-run length limit: [^\x00\r\n]{1,240} + ".dat" = at most 244.
  assert.deepEqual(namesOf(framedItem("/rfc/" + "a".repeat(240) + ".dat", bytes("D"))),
    ["/rfc/" + "a".repeat(240) + ".dat"]);
  assert.deepEqual(namesOf(framedItem("/rfc/" + "a".repeat(241) + ".dat", bytes("D"))), []);
  // At least one char before ".dat" ({1,240} lower bound).
  assert.deepEqual(namesOf(framedItem("/rfc/.dat", bytes("D"))), []);
  // Missing NUL at EOF.
  const truncated = framedItem("/rfc/x.dat", bytes("D"));
  assert.deepEqual(namesOf(truncated.subarray(0, 10 + 1 + 6 + 1 - 1 + 0)), []);
  // IGNORECASE.
  assert.deepEqual(namesOf(framedItem("/RFC/MODEM_RES.DAT", bytes("D"))), ["/RFC/MODEM_RES.DAT"]);
  // Bytes outside \x00/\r/\n are allowed inside the run.
  assert.deepEqual(namesOf(framedItem("/rfc/a.dat\x01.dat", bytes("D"))), ["/rfc/a.dat\x01.dat"]);
});

test("/rfc/ scanner validates the Large-EFS TLV framing", () => {
  // match.start() < 4: no room for the TLV header.
  assert.deepEqual(namesOf(framedItem("/rfc/x.dat", bytes("D")).subarray(2)), []);
  // Wrong TLV type.
  const wrongType = framedItem("/rfc/x.dat", bytes("D"));
  new DataView(wrongType.buffer).setUint16(0, 0, true);
  assert.deepEqual(namesOf(wrongType), []);
  // Wrong path length.
  const wrongLen = framedItem("/rfc/x.dat", bytes("D"));
  new DataView(wrongLen.buffer).setUint16(2, 10, true);
  assert.deepEqual(namesOf(wrongLen), []);
  // Wrong data TLV type / overflowing data length.
  const wrongData = framedItem("/rfc/x.dat", bytes("D"));
  new DataView(wrongData.buffer).setUint16(4 + 9 + 1, 3, true);
  assert.deepEqual(namesOf(wrongData), []);
  const overLong = framedItem("/rfc/x.dat", bytes("D"));
  new DataView(overLong.buffer).setUint32(4 + 9 + 3, 99, true);
  assert.deepEqual(namesOf(overLong), []);
  // Python dict semantics: duplicate path -> last data wins, one entry.
  const dup = extractRfcDats(concatBytes([framedItem("/rfc/x.dat", bytes("AAA")), framedItem("/rfc/x.dat", bytes("BB"))]));
  assert.deepEqual(dup.map((d) => d.name), ["/rfc/x.dat"]);
  assert.equal(new TextDecoder().decode(dup[0].data), "BB");
});

test("zlib candidate loop finds streams at metadata offsets", () => {
  // Fixture generated with Python: 15 junk bytes, uint32 LE payload size,
  // zlib.compress(b"protobuf-ish bytes" * 10). The stream starts at offset 19,
  // so the accepting candidate is base 14 -> "14-byte-metadata+hash+size+zlib".
  const dat = hexToBytes(
    "111111111111111111111111111111b4000000"
    + "789c2b28ca2fc94f2a4dd3cd2cce5048aa2c492d2e18f422005d39479b",
  );
  const payload = bytes("protobuf-ish bytes".repeat(10));
  const cands = datPayloadCandidates(dat);
  assert.deepEqual(cands.map(([encoding]) => encoding), ["14-byte-metadata+hash+size+zlib", "raw"]);
  assert.deepEqual(cands[0][1], payload);
  assert.deepEqual(cands[1][1], dat);

  // Trailing bytes after the zlib stream are ignored, exactly like
  // zlib.decompress (the adler trailer is still verified at stream end).
  const withJunk = hexToBytes(
    "111111111111111111111111111111b4000000"
    + "789c2b28ca2fc94f2a4dd3cd2cce5048aa2c492d2e18f422005d39479b545241494c494e47",
  );
  const cands2 = datPayloadCandidates(withJunk);
  assert.deepEqual(cands2.map(([encoding]) => encoding), ["14-byte-metadata+hash+size+zlib", "raw"]);
  assert.deepEqual(cands2[0][1], payload);

  // size+raw fallback and raw fallback.
  const rawDat = hexToBytes("020000004142");
  const cands3 = datPayloadCandidates(rawDat);
  assert.deepEqual(cands3.map(([encoding]) => encoding), ["size+raw", "raw"]);
  assert.deepEqual(cands3[0][1], bytes("AB"));
  assert.deepEqual(cands3[1][1], rawDat);
  assert.deepEqual(datPayloadCandidates(hexToBytes("deadbeef")).map(([e]) => e), ["raw"]);
});

test("parseResDat decodes the first viable candidate", () => {
  const payload = bytes("\x3a\x04\x0a\x02te");
  const stream = zlibSync(payload);
  const dat = new Uint8Array(5 + 4 + stream.length);
  dat.fill(0x22, 0, 5);
  new DataView(dat.buffer).setUint32(5, payload.length, true);
  dat.set(stream, 9);
  const { encoding, payload: protobuf, rrc } = parseResDat(dat);
  assert.equal(encoding, "4-byte-metadata+hash+size+zlib");
  assert.deepEqual(protobuf, payload);
  assert.deepEqual([...rrc.NR_band_group_table_high], [0x74, 0x65]);
  assert.equal(rrc.nr5g_info_per_band_sub_cap_high_num, 0);
  assert.equal(rrc.env_name_high, "");

  assert.throws(() => parseResDat(hexToBytes("deadbeef")), /Cannot parse res DAT protobuf: /);
});

test("protobuf field walker matches Python", () => {
  const data = hexToBytes(
    "3a03089601" + "40ac02" + "3a0101" + "4a0496 01ac02".replace(/ /g, "")
    + "2d01020304" + "291111111111111111",
  );
  const fields = protobufFields(data);
  assert.deepEqual(
    fields.get(7).map(([w, v]) => [w, hex(v)]),
    [[2, "089601"], [2, "01"]],
  );
  assert.deepEqual(fields.get(8), [[0, 300]]);
  assert.deepEqual(fields.get(9).map(([w, v]) => [w, hex(v)]), [[2, "9601ac02"]]);
  assert.deepEqual(fields.get(5).map(([w, v]) => [w, hex(v)]), [[5, "01020304"], [1, "1111111111111111"]]);

  assert.deepEqual([...protoBytes(fields, 7)], [0x08, 0x96, 0x01, 0x01]);
  assert.equal(protoUint(fields, 8), 300);
  assert.deepEqual(protoRepeatedUint(fields, 9), [150, 300]);
  assert.equal(protoUint(fields, 99), 0);
  assert.deepEqual(protoBytes(fields, 99), new Uint8Array(0));
  assert.deepEqual(protoRepeatedUint(fields, 99), []);

  assert.throws(() => protobufFields(new Uint8Array([0x00])), /Invalid protobuf field zero/);
  assert.throws(() => protobufFields(new Uint8Array([0x36])), /Unsupported protobuf wire type 6/);
  assert.throws(() => protobufFields(new Uint8Array([0x0a])), /Truncated protobuf varint/);
  assert.throws(() => protobufFields(new Uint8Array([0x39, 0x01, 0x02])), /Truncated protobuf fixed64/);
  assert.throws(() => protobufFields(new Uint8Array([0x2a, 0x05, 0x61, 0x62])), /Truncated protobuf length-delimited field/);
  assert.throws(() => protobufFields(new Uint8Array([0x08, 0x80])), /Truncated protobuf varint/);
});

test("makeRrcView requires the rrc field #7", () => {
  assert.throws(() => makeRrcView(new Uint8Array(0)), /res protobuf has no rrc field #7/);
  assert.throws(() => makeRrcView(new Uint8Array([0x08, 0x01])), /res protobuf has no rrc field #7/);
});

test("enum assignments and reverse lookup match Python", () => {
  const e = enumAssignments();
  assert.equal(Object.keys(e).length, 156);
  assert.equal(e.BW_5, 1);
  assert.equal(e.BW_100_100, 23);
  assert.equal(e.BW_DEFAULT, 0);
  assert.equal(e.ANTENNA_INVALID, 0);
  assert.equal(e.ANTENNA_1, 1);
  assert.equal(e.ANTENNA_2_1, 5);
  assert.equal(e.ANTENNA_4_2, 7);
  assert.equal(e.ANTENNA_8, 81);
  assert.equal(e.ANTENNA_6_6, 89);
  assert.equal(Object.keys(e).filter((k) => k.startsWith("ANTENNA_")).length, 90);

  const bw = reverseEnum(e, "BW_");
  assert.equal(bw.get(0), undefined); // BW_DEFAULT blacklisted
  assert.equal(bw.get(1), "5");
  assert.equal(bw.get(22), "100_60");
  const ant = reverseEnum(e, "ANTENNA_");
  assert.equal(ant.get(0), undefined); // ANTENNA_INVALID blacklisted
  assert.equal(ant.get(5), "2_1");
});

test("LTE combo decode matches Python", () => {
  // Python: bytearray(50) with <HBBBBB>(66,1,3,1,1,2)@2 and <HBBBBB>(12,1,2,0,0,0)@10
  assert.equal(
    decodeLteCombo(hexToBytes(
      "000042000103010102000c000102000000000000000000000000000000000000000000000000000000000000000000000000",
    )),
    "B66A[3];A[1]+B12A[2]",
  );
});

test("NR band group text decode matches Python", () => {
  const bw = reverseEnum(enumAssignments(), "BW_");
  const ant = reverseEnum(enumAssignments(), "ANTENNA_");
  assert.equal(
    decodeNrBandGroup(decodeBandGroup(packBandGroup({ tech: 2, band: 78, dl_bw_class: 10, dl_bw_per_cc: 21, dl_max_antennas_index: 2 })), bw, ant),
    "N78J[100x2]",
  );
  assert.equal(
    decodeNrBandGroup(decodeBandGroup(packBandGroup({ tech: 1, band: 3, dl_bw_class: 1, dl_bw_per_cc: 4, dl_max_antennas_index: 2, ul_bw_class: 2, ul_bw_per_cc: 21, ul_max_antennas_index: 1 })), bw, ant),
    "B3A[20x2];B[100x1]",
  );
  // Supplementary uplink: dl_bw_class 0 renders the N<band>_ syntax.
  assert.equal(
    decodeNrBandGroup(decodeBandGroup(packBandGroup({ tech: 2, band: 78, dl_bw_class: 0, dl_bw_per_cc: 21, dl_max_antennas_index: 2, ul_bw_class: 3, ul_bw_per_cc: 4, ul_max_antennas_index: 1 })), bw, ant),
    "N78_;C[20x1]",
  );
  // Multi-CC bandwidths pad missing antenna layers with the last value.
  assert.equal(
    decodeNrBandGroup(decodeBandGroup(packBandGroup({ tech: 2, band: 41, dl_bw_class: 5, dl_bw_per_cc: 24, dl_max_antennas_index: 5 })), bw, ant),
    "N41E[100x2,100x1,100x1]",
  );
});

// --- golden (corpus-gated): differential parity for "DAT/protobuf" records ---

test("modern DAT/protobuf records match Python goldens", { skip: !corpusAvailable() }, async () => {
  const corpus = JSON.parse(await readFile(new URL("../goldens/corpus.json", import.meta.url)));
  let checked = 0;
  let skipped = 0;
  for (const [img, recs] of Object.entries(corpus)) {
    // sparse/... and fat/... records live in containers that are not ported
    // yet (Task 9); only plain direct-FAT16 inner paths are resolvable here.
    const resolvable = recs.filter((r) => r.generation === "DAT/protobuf" && r.inner_path.startsWith("/"));
    skipped += recs.filter((r) => r.generation === "DAT/protobuf" && !r.inner_path.startsWith("/")).length;
    if (resolvable.length === 0) continue;
    const src = await sourceFor(join(CORPUS_DIR, img));
    const fat = new Fat16Image(src);
    await fat.init();
    const byPath = new Map((await fat.walk()).map((e) => [e.path, e]));
    const imgTag = img.replace(/\.[^.]+$/, "").slice(0, 40).replaceAll(" ", "_");
    for (const rec of resolvable) {
      const entry = byPath.get(rec.inner_path);
      assert.ok(entry, `${img}: missing ${rec.inner_path}`);
      const blob = await fat.readFile(entry);
      const parsed = parseModernModule({ name: rec.name, inner_path: rec.inner_path }, blob);
      const goldenPath = `../goldens/parse/${imgTag}__${rec.name.replaceAll("/", "_")}.json`;
      const expected = JSON.parse(await readFile(new URL(goldenPath, import.meta.url)));
      deepEqualOrdered(truncateParse(parsed), expected, `${img}/${rec.name}`);
      checked++;
    }
    await src.close();
  }
  assert.equal(checked, 328);
  assert.equal(skipped, 8);
});
