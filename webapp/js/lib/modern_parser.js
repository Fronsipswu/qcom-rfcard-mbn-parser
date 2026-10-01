// Port of the modern (DAT/protobuf) RF-card parsing core:
// gui_version/new_rfcard_parser.py plus the modern orchestration from
// gui_version/qualcomm_rf_combo_analyzer.py (_modern_lte_rows,
// _modern_nr_rows, parse_modern). Byte-identical behaviour contract with the
// Python originals: values, dict key insertion order and iteration order.
//
// Python tuples return as JS arrays; Python None as null; dict keys keep the
// exact Python snake_case spelling. zlib decompression uses the vendored
// fflate (webapp/lib/vendor/fflate.js); error message strings inside
// parse_res_dat's aggregated ValueError differ from Python's zlib.error text
// (candidate selection and results are identical).
import { StructReader, hex as bytesHex, utf8 } from "./bytes.js";
import { sha256Hex } from "./hash.js";
import { Inflate } from "../../lib/vendor/fflate.js";
import { TABLE_DISPLAY, ToolError } from "./legacy_parser.js";

export { ToolError };

const VERSION = "1.8.0";

export { TABLE_DISPLAY };

export function chunks(data, size) {
  const out = [];
  for (let p = 0; p + size <= data.length; p += size) out.push(data.subarray(p, p + size));
  return out;
}

function concatBytes(arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function bytesEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function adler32(u8) {
  // NMAX-batched so the modulo runs every 5552 bytes instead of per byte.
  let a = 1, b = 0, i = 0;
  while (i < u8.length) {
    const n = Math.min(5552, u8.length - i);
    for (let k = 0; k < n; k++, i++) { a += u8[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return (b * 65536 + a) >>> 0;
}

function inflateZlibStrict(data) {
  // Python zlib.decompress parity on top of fflate: unzlibSync skips the
  // adler32 trailer and assumes it sits in the final four bytes, while Python
  // verifies the trailer at the exact end of the deflate stream and ignores
  // any trailing bytes. The streaming Inflate tracks the consumed bit
  // position (after push() inf.p holds the unconsumed tail), so the trailer
  // can be located and verified exactly.
  if (data.length < 2) throw new Error("incomplete or truncated stream");
  if ((data[0] & 15) !== 8 || (data[0] >> 4) > 7 || ((data[0] << 8) | data[1]) % 31 !== 0) {
    throw new Error("incorrect header check");
  }
  if ((data[1] >> 5) & 1) throw new Error("invalid dictionary id");
  const headerLen = ((data[1] >> 3) & 4) + 2;
  const body = data.subarray(headerLen);
  if (body.length === 0) throw new Error("incomplete or truncated stream");
  const inf = new Inflate();
  const outs = [];
  inf.ondata = (chunk) => { if (chunk.length) outs.push(chunk); };
  inf.push(body, true);
  const consumedBits = (body.length - inf.p.length) * 8 + inf.s.p;
  const trailerOff = headerLen + Math.ceil(consumedBits / 8);
  if (trailerOff + 4 > data.length) throw new Error("incomplete or truncated stream");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (adler32(concatBytes(outs)) !== dv.getUint32(trailerOff)) throw new Error("incorrect data check");
  return concatBytes(outs);
}

// ASCII-only case-insensitive byte compare (the regex IGNORECASE behaviour).
function ciByte(u8, i, t) {
  const c = u8[i];
  return c === t || (c >= 0x41 && c <= 0x5a && c + 32 === t);
}

export function extractRfcDats(blob) {
  // Port of the rb"/rfc/[^\x00\r\n]{1,240}\.dat\x00" IGNORECASE scan plus the
  // Large-EFS TLV validation. Greedy {1,240} backtracking can only split at
  // L = runLen - 4, so the regex is equivalent to: maximal run of
  // non-NUL/CR/LF bytes with 5 <= runLen <= 244 ending in ".dat" and
  // terminated by a NUL. Returns Python dict semantics: entries deduped by
  // name, last data wins, first-appearance order.
  const byName = new Map();
  const indexOf = (from) => {
    for (let i = from; i < blob.length; i++) if (blob[i] === 0x2f) return i;
    return -1;
  };
  for (let i = indexOf(0); i >= 0 && i + 11 <= blob.length; i = indexOf(i + 1)) {
    if (!ciByte(blob, i + 1, 0x72) || !ciByte(blob, i + 2, 0x66) || !ciByte(blob, i + 3, 0x63) || !ciByte(blob, i + 4, 0x2f)) continue;
    let j = i + 5;
    while (j < blob.length && blob[j] !== 0 && blob[j] !== 13 && blob[j] !== 10) j++;
    const runLen = j - i - 5;
    if (
      blob[j] !== 0 || runLen < 5 || runLen > 244
      || !ciByte(blob, j - 4, 0x2e) || !ciByte(blob, j - 3, 0x64)
      || !ciByte(blob, j - 2, 0x61) || !ciByte(blob, j - 1, 0x74)
    ) continue;
    const name = utf8(blob, i, j);
    if (i >= 4) {
      const tlv = new StructReader(blob);
      if (tlv.u16(i - 4) === 1 && tlv.u16(i - 2) === name.length + 1) {
        const dataHdr = j + 1;
        if (dataHdr + 6 <= blob.length) {
          const dataType = tlv.u16(dataHdr);
          const dataLen = tlv.u32(dataHdr + 2);
          if (dataType === 2 && dataHdr + 6 + dataLen <= blob.length) {
            const data = blob.subarray(dataHdr + 6, dataHdr + 6 + dataLen);
            const prev = byName.get(name);
            if (prev) prev.data = data;
            else byName.set(name, { name, offset: i, data });
          }
        }
      }
    }
  }
  return [...byName.values()];
}

let ENUM_CACHE = null;

export function enumAssignments() {
  // Enums used by the MPSS.DE.9.0 NR5G_8RX RFCard schema.
  if (ENUM_CACHE) return ENUM_CACHE;
  const bwNames = [
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
  ];
  const result = {};
  bwNames.forEach((name, index) => { result[`BW_${name}`] = index; });

  const antennaNames = ["INVALID", "1", "2", "4"];
  for (let count = 2; count <= 8; count++) {
    antennaNames.push(new Array(count).fill("1").join("_"));
    for (let leading = 1; leading <= count; leading++) {
      antennaNames.push([...new Array(leading).fill("2"), ...new Array(count - leading).fill("1")].join("_"));
    }
    for (let leading = 1; leading <= count; leading++) {
      antennaNames.push([...new Array(leading).fill("4"), ...new Array(count - leading).fill("2")].join("_"));
    }
  }
  antennaNames.push("8", "8_4", "8_4_4", "8_8", "6", "4_8", "6_4", "4_6", "6_6");
  antennaNames.forEach((name, index) => { result[`ANTENNA_${name}`] = index; });
  ENUM_CACHE = result;
  return result;
}

const ENUM_SUFFIX_BLACKLIST = ["_SIZE", "_MAX_NUM", "_INVALID_INDEX", "_INVALID", "_DEFAULT"];

export function reverseEnum(enumMap, prefix) {
  const out = new Map();
  for (const [name, value] of Object.entries(enumMap)) {
    if (name.startsWith(prefix) && !ENUM_SUFFIX_BLACKLIST.some((s) => name.endsWith(s))) {
      out.set(value, name.slice(prefix.length));
    }
  }
  return out;
}

export function datPayloadCandidates(dat) {
  // RFPD default DAT = hash byte + uint32 raw size + zlib(protobuf).
  const out = [];
  const yielded = [];
  const r = new StructReader(dat);
  const zlibLimit = Math.min(32, Math.max(0, dat.length - 5));
  for (let base = 0; base < zlibLimit; base++) {
    const expected = r.u32(base + 1);
    let raw = null;
    try {
      raw = inflateZlibStrict(dat.subarray(base + 5));
    } catch {
      raw = null;
    }
    if (raw !== null && raw.length === expected) {
      if (!yielded.some((y) => bytesEquals(y, raw))) yielded.push(raw);
      out.push([base ? `${base}-byte-metadata+hash+size+zlib` : "hash+size+zlib", raw]);
    }
  }
  const rawLimit = Math.min(32, Math.max(0, dat.length - 4));
  for (let base = 0; base < rawLimit; base++) {
    const expected = r.u32(base);
    const raw = dat.subarray(base + 4);
    if (raw.length === expected && !yielded.some((y) => bytesEquals(y, raw))) {
      yielded.push(raw);
      out.push([base ? `${base}-byte-metadata+size+raw` : "size+raw", raw]);
    }
  }
  if (!yielded.some((y) => bytesEquals(y, dat))) out.push(["raw", dat]);
  return out;
}

export function readVarint(u8, pos) {
  let value = 0;
  let shift = 0;
  while (pos < u8.length && shift < 70) {
    const byte = u8[pos++];
    // Multiplication, not <<: protobuf varints exceed 32 bits.
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, pos };
    shift += 7;
  }
  throw new Error("Truncated protobuf varint");
}

export function protobufFields(data) {
  const result = new Map();
  let pos = 0;
  while (pos < data.length) {
    let key;
    ({ value: key, pos } = readVarint(data, pos));
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (number === 0) throw new Error("Invalid protobuf field zero");
    let value;
    if (wire === 0) {
      ({ value, pos } = readVarint(data, pos));
    } else if (wire === 1) {
      if (pos + 8 > data.length) throw new Error("Truncated protobuf fixed64");
      value = data.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 2) {
      let size;
      ({ value: size, pos } = readVarint(data, pos));
      if (pos + size > data.length) throw new Error("Truncated protobuf length-delimited field");
      value = data.subarray(pos, pos + size);
      pos += size;
    } else if (wire === 5) {
      if (pos + 4 > data.length) throw new Error("Truncated protobuf fixed32");
      value = data.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
    if (!result.has(number)) result.set(number, []);
    result.get(number).push([wire, value]);
  }
  return result;
}

export function protoBytes(fields, number) {
  return concatBytes((fields.get(number) ?? []).filter(([wire]) => wire === 2).map(([, value]) => value));
}

export function protoUint(fields, number) {
  const values = (fields.get(number) ?? []).filter(([wire]) => wire === 0).map(([, value]) => value);
  return values.length ? values[values.length - 1] : 0;
}

export function protoRepeatedUint(fields, number) {
  const result = [];
  for (const [wire, value] of fields.get(number) ?? []) {
    if (wire === 0) {
      result.push(value);
    } else if (wire === 2) {
      let pos = 0;
      while (pos < value.length) {
        let item;
        ({ value: item, pos } = readVarint(value, pos));
        result.push(item);
      }
    }
  }
  return result;
}

// Field map of the RRC container message, in the Python dict insertion order.
const RRC_FIELDS = [
  ["NR_band_group_table_high", "bytes", 1],
  ["NR_band_group_table_low", "bytes", 2],
  ["lte_info_per_band_sub_cap_high", "bytes", 3],
  ["nr5g_info_per_band_sub_cap_high", "bytes", 4],
  ["lte_nr5g_info_per_band_sub_cap_high", "bytes", 5],
  ["nr5g_nr5g_info_per_band_sub_cap_high", "bytes", 6],
  ["lte_info_per_band_sub_cap_high_num", "uint", 7],
  ["nr5g_info_per_band_sub_cap_high_num", "uint", 8],
  ["lte_nr5g_info_per_band_sub_cap_high_num", "uint", 9],
  ["nr5g_nr5g_info_per_band_sub_cap_high_num", "uint", 10],
  ["nr5g_band_group_indices_table_sub_cap_high", "bytes", 11],
  ["nr5g_band_group_indices_offset_table_sub_cap_high", "repeated", 12],
  ["nr5g_combo_properties_table_sub_cap_high", "bytes", 13],
  ["lte_nr5g_band_group_indices_table_sub_cap_high", "bytes", 14],
  ["lte_nr5g_band_group_indices_offset_table_sub_cap_high", "repeated", 15],
  ["lte_nr5g_combo_properties_table_sub_cap_high", "bytes", 16],
  ["nr5g_nr5g_band_group_indices_table_sub_cap_high", "bytes", 17],
  ["nr5g_nr5g_band_group_indices_offset_table_sub_cap_high", "repeated", 18],
  ["nr5g_nr5g_combo_properties_table_sub_cap_high", "bytes", 19],
  ["lte_info_per_band_sub_cap_low", "bytes", 39],
  ["nr5g_info_per_band_sub_cap_low", "bytes", 40],
  ["lte_nr5g_info_per_band_sub_cap_low", "bytes", 41],
  ["nr5g_nr5g_info_per_band_sub_cap_low", "bytes", 42],
  ["lte_info_per_band_sub_cap_low_num", "uint", 43],
  ["nr5g_info_per_band_sub_cap_low_num", "uint", 44],
  ["lte_nr5g_info_per_band_sub_cap_low_num", "uint", 45],
  ["nr5g_nr5g_info_per_band_sub_cap_low_num", "uint", 46],
  ["nr5g_band_group_indices_table_sub_cap_low", "bytes", 47],
  ["nr5g_band_group_indices_offset_table_sub_cap_low", "repeated", 48],
  ["nr5g_combo_properties_table_sub_cap_low", "bytes", 49],
  ["lte_nr5g_band_group_indices_table_sub_cap_low", "bytes", 50],
  ["lte_nr5g_band_group_indices_offset_table_sub_cap_low", "repeated", 51],
  ["lte_nr5g_combo_properties_table_sub_cap_low", "bytes", 52],
  ["nr5g_nr5g_band_group_indices_table_sub_cap_low", "bytes", 53],
  ["nr5g_nr5g_band_group_indices_offset_table_sub_cap_low", "repeated", 54],
  ["nr5g_nr5g_combo_properties_table_sub_cap_low", "bytes", 55],
  ["env_name_high", "string", 73],
  ["env_name_low", "string", 74],
];

export function makeRrcView(payload) {
  const outer = protobufFields(payload);
  const rrcMessages = (outer.get(7) ?? []).filter(([wire]) => wire === 2).map(([, value]) => value);
  if (rrcMessages.length === 0) throw new Error("res protobuf has no rrc field #7");
  const fields = protobufFields(rrcMessages[rrcMessages.length - 1]);
  const values = {};
  for (const [name, kind, number] of RRC_FIELDS) {
    if (kind === "bytes") values[name] = protoBytes(fields, number);
    else if (kind === "uint") values[name] = protoUint(fields, number);
    else if (kind === "string") {
      const raw = protoBytes(fields, number);
      values[name] = utf8(raw, 0, raw.length);
    } else values[name] = protoRepeatedUint(fields, number);
  }
  return values;
}

export function parseResDat(dat) {
  const errors = [];
  for (const [encoding, payload] of datPayloadCandidates(dat)) {
    try {
      return { encoding, payload, rrc: makeRrcView(payload) };
    } catch (exc) {
      errors.push(`${encoding}: ${exc.message}`);
    }
  }
  throw new Error("Cannot parse res DAT protobuf: " + errors.join("; "));
}

export function decodeLteCombo(raw) {
  // Native layout: bool + one pad + 6 * 8-byte per-band records = 50 bytes.
  const r = new StructReader(raw);
  const groups = [];
  for (let index = 0; index < 6; index++) {
    const pos = 2 + index * 8;
    const [band, dlCls, dlAnt, ulCls, ulAnt] = r.unpack("<HBBBBB", pos);
    if (band === 0) continue;
    const dlLetter = dlCls >= 1 && dlCls <= 26 ? String.fromCharCode(64 + dlCls) : `X${dlCls}`;
    let text = `B${band}${dlLetter}[${dlAnt}]`;
    if (ulCls) {
      const ulLetter = ulCls >= 1 && ulCls <= 26 ? String.fromCharCode(64 + ulCls) : `X${ulCls}`;
      text += `;${ulLetter}[${ulAnt}]`;
    }
    groups.push(text);
  }
  return groups.join("+");
}

export function decodeNrProperty(raw) {
  // RFPD compacts the 24 consecutive property bitfields into three bytes.
  if (raw.length < 12) throw new Error(`Short NRComboProperty: ${raw.length}`);
  const bits = raw[0] | (raw[1] << 8) | (raw[2] << 16);
  const r = new StructReader(raw);
  return {
    power_class: bits & 0x7,
    tdd_ant_swt_fdd_disruption: (bits >>> 3) & 0x1,
    simultaneousRxTxInterBandENDC: (bits >>> 4) & 0x1,
    simultaneousRxTxInterBandCA: (bits >>> 5) & 0x1,
    ul_tx_switch_type: (bits >>> 6) & 0x3,
    intra_contig_type: (bits >>> 8) & 0x7,
    srs_cs_type: (bits >>> 11) & 0x7,
    intra_ulca_dual_pa: (bits >>> 14) & 0x1,
    simultaneousRxTxInterBandSUL: (bits >>> 15) & 0x1,
    num_bands: (bits >>> 16) & 0x3f,
    has_bcs5_counterpart: (bits >>> 22) & 0x1,
    higher_power_limit: (bits >>> 23) & 0x1,
    bcs_num: raw[3],
    env_mode_mask_idx: r.u16(4),
    env_mode_subset_mask_idx: r.u16(6),
    simul_rxtx_bmap_idx: r.u16(8),
    simul_sul_rxtx_bmap_idx: r.u16(10),
  };
}

// ctypes NRBandGroup (LittleEndianStructure, _pack_=4, sizeof=12) bit layout,
// derived from Python: unit0 = tech@0-1, band@2-10, dl_bw_class@11-15,
// dl_bw_per_cc@16-22, ul_bw_class@23-27 (bits 28-31 unused); ul_bw_per_cc
// overflows unit0 and starts unit1 at bit 32; unit1 = ul_bw_per_cc@32-38,
// dl_max_antennas_index@39-45, ul_max_antennas_index@46-52, max_scs@53-55,
// ul_qam_cap_index@56-57, srs_tx_switch_type@58-61,
// tx_switch_impact_to_rx@62-63; unit2 = tx_switch_with_another_band@64-65,
// srs_carrier_hop@66, srs_carrier_hop_src@67-68, rx_limit@69,
// num_tx_meeting_combo_pc@70-71, link_id@72-73.
export function decodeBandGroup(raw) {
  if (raw.length < 12) throw new Error(`Short NRBandGroup: ${raw.length}`);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u0 = dv.getUint32(0, true);
  const u1 = dv.getUint32(4, true);
  const u2 = dv.getUint32(8, true);
  return {
    tech: u0 & 0x3,
    band: (u0 >>> 2) & 0x1ff,
    dl_bw_class: (u0 >>> 11) & 0x1f,
    dl_bw_per_cc: (u0 >>> 16) & 0x7f,
    ul_bw_class: (u0 >>> 23) & 0x1f,
    ul_bw_per_cc: u1 & 0x7f,
    dl_max_antennas_index: (u1 >>> 7) & 0x7f,
    ul_max_antennas_index: (u1 >>> 14) & 0x7f,
    max_scs: (u1 >>> 21) & 0x7,
    ul_qam_cap_index: (u1 >>> 24) & 0x3,
    srs_tx_switch_type: (u1 >>> 26) & 0xf,
    tx_switch_impact_to_rx: (u1 >>> 30) & 0x3,
    tx_switch_with_another_band: u2 & 0x3,
    srs_carrier_hop: (u2 >>> 2) & 0x1,
    srs_carrier_hop_src: (u2 >>> 3) & 0x3,
    rx_limit: (u2 >>> 5) & 0x1,
    num_tx_meeting_combo_pc: (u2 >>> 6) & 0x3,
    link_id: (u2 >>> 8) & 0x3,
  };
}

function formatSide(bwName, antennaName) {
  let layers = antennaName ? antennaName.split("_").map((x) => parseInt(x, 10)) : [];
  const bws = bwName ? bwName.split("_").map((x) => parseInt(x, 10)) : [];
  const count = Math.max(layers.length, bws.length, 1);
  if (layers.length === 0) layers = new Array(count).fill(0);
  if (bws.length === 0) return layers.join(",");
  if (layers.length < bws.length) {
    layers = layers.concat(new Array(bws.length - layers.length).fill(layers[layers.length - 1]));
  }
  return bws.map((bw, i) => `${bw}x${layers[i]}`).join(",");
}

export function decodeNrBandGroup(bg, bwByValue, antByValue) {
  const prefix = bg.tech === 1 ? "B" : bg.tech === 2 ? "N" : `T${bg.tech}-`;
  let text;
  if (bg.dl_bw_class) {
    const dlClass = bg.dl_bw_class >= 1 && bg.dl_bw_class <= 26
      ? String.fromCharCode(64 + bg.dl_bw_class)
      : `X${bg.dl_bw_class}`;
    const dl = formatSide(bwByValue.get(bg.dl_bw_per_cc), antByValue.get(bg.dl_max_antennas_index));
    text = `${prefix}${bg.band}${dlClass}[${dl}]`;
  } else {
    // RFCard's canonical syntax for a supplementary-uplink/UL-only
    // component is N<band>_;<UL class>[<UL BW>x<antennas>].
    text = `${prefix}${bg.band}_`;
  }
  if (bg.ul_bw_class) {
    const ulClass = bg.ul_bw_class >= 1 && bg.ul_bw_class <= 26
      ? String.fromCharCode(64 + bg.ul_bw_class)
      : `X${bg.ul_bw_class}`;
    const ul = formatSide(bwByValue.get(bg.ul_bw_per_cc), antByValue.get(bg.ul_max_antennas_index));
    text += `;${ulClass}[${ul}]`;
  }
  return text;
}

export function nrSectionRecords(rrc, prefix, suffix) {
  const refRaw = rrc[`${prefix}_info_per_band_sub_cap_${suffix}`];
  const bgRaw = rrc[`NR_band_group_table_${suffix}`];
  const indexRaw = rrc[`${prefix}_band_group_indices_table_sub_cap_${suffix}`];
  const offsets = rrc[`${prefix}_band_group_indices_offset_table_sub_cap_${suffix}`];
  const propRaw = rrc[`${prefix}_combo_properties_table_sub_cap_${suffix}`];
  const refCount = rrc[`${prefix}_info_per_band_sub_cap_${suffix}_num`];

  const refs = chunks(refRaw, 4)
    .map((item) => new StructReader(item).unpack("<HH", 0))
    .slice(0, refCount);
  const bandGroups = chunks(bgRaw, 12).map((item) => decodeBandGroup(item));
  const properties = chunks(propRaw, 12).map((item) => decodeNrProperty(item));

  const result = [];
  for (const [bgTableIndex, propIndex] of refs) {
    if (propIndex >= properties.length) continue;
    const prop = properties[propIndex];
    const count = prop.num_bands;
    if (count <= 0 || count > offsets.length) continue;
    // The flattened table contains uint16 band-group indices; offsets count
    // entries rather than bytes.
    const startEntry = offsets[count - 1] + bgTableIndex * count;
    const start = startEntry * 2;
    const rawIndices = indexRaw.subarray(start, start + count * 2);
    if (rawIndices.length !== count * 2) continue;
    const r = new StructReader(rawIndices);
    const bgIndices = [];
    for (let i = 0; i < count; i++) bgIndices.push(r.u16(i * 2));
    const selectedGroups = [];
    let outOfRange = false;
    for (const bgIndex of bgIndices) {
      if (bgIndex >= bandGroups.length) {
        outOfRange = true;
        break;
      }
      selectedGroups.push(bandGroups[bgIndex]);
    }
    if (outOfRange || selectedGroups.length === 0) continue;
    result.push([selectedGroups, prop]);
  }
  return result;
}

export function b0cdV41Packets(rrc, suffix, packetCombos = 100) {
  // Build headerless Qualcomm 0xB0CD v41 payloads.
  const field = `lte_info_per_band_sub_cap_${suffix}`;
  const rawCombos = chunks(rrc[field], 50).slice(0, rrc[`${field}_num`]);
  const encoded = [];
  for (const raw of rawCombos) {
    const r = new StructReader(raw);
    const parts = [];
    for (let index = 0; index < 6; index++) {
      const pos = 2 + index * 8;
      const [band, dlCls, dlAnt, ulCls, ulAnt, ulQam] = r.unpack("<HBBBBB", pos);
      if (!band) continue;
      const out = new Uint8Array(7);
      const dv = new DataView(out.buffer);
      dv.setUint16(0, band, true);
      out[2] = dlCls; out[3] = ulCls; out[4] = dlAnt; out[5] = ulAnt; out[6] = ulQam;
      parts.push(out);
    }
    if (parts.length) encoded.push(concatBytes([Uint8Array.of(parts.length), ...parts]));
  }
  const result = [];
  for (let start = 0; start < encoded.length; start += packetCombos) {
    const current = encoded.slice(start, start + packetCombos);
    result.push(concatBytes([Uint8Array.of(41, current.length), ...current]));
  }
  return result;
}

export function b826V22Component(bg) {
  // Encode one RFCard band group in the 10-byte 0xB826 v22 component layout.
  if (bg.band > 0x1ff) throw new Error(`0xB826 v22 band exceeds 9 bits: ${bg.band}`);
  const dlAnt = bg.dl_max_antennas_index;
  const ulAnt = bg.ul_max_antennas_index;
  const dlBw = bg.dl_bw_per_cc;
  const ulBw = bg.ul_bw_per_cc;
  if (dlAnt > 0x7f || ulAnt > 0x1f || dlBw > 0x7f || ulBw > 0x7f) {
    throw new Error("0xB826 v22 component field exceeds its bit width");
  }
  const head = bg.band
    | ((bg.tech === 2 ? 1 : 0) << 9)
    | ((bg.dl_bw_class & 0x1f) << 10)
    | ((dlAnt & 1) << 15);
  const byte1 = ((dlAnt >> 1) & 0x3f) | ((bg.ul_bw_class & 0x03) << 6);
  const byte2 = ((bg.ul_bw_class >> 2) & 0x07) | ((ulAnt & 0x1f) << 3);
  const qam = bg.ul_qam_cap_index & 0x03;
  const byte3 = ((qam & 1) << 2) | (((qam >> 1) & 1) << 1) | ((dlBw & 1) << 7);
  const byte4 = ((dlBw >> 1) & 0x3f) | ((ulBw & 0x03) << 6);
  const byte5 = (ulBw >> 2) & 0x1f;
  const out = new Uint8Array(10);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, head, true);
  out[2] = byte1; out[3] = byte2; out[4] = byte3; out[5] = byte4; out[6] = byte5;
  return out;
}

export function b826V22Packets(records, source, packetCombos = 100) {
  // Build headerless Qualcomm 0xB826 v22 payloads.
  const encoded = [];
  for (const [bandGroups, prop] of records) {
    const count = bandGroups.length;
    if (count < 1 || count > 15) {
      throw new Error(`0xB826 v22 supports 1..15 components, got ${count}`);
    }
    const features = (count << 6) | ((prop.ul_tx_switch_type & 0x03) << 13);
    const head = new Uint8Array(15);
    new DataView(head.buffer).setUint16(0, features, true);
    encoded.push(concatBytes([head, ...bandGroups.map((bg) => b826V22Component(bg))]));
  }
  const total = encoded.length;
  const result = [];
  for (let start = 0; start < total; start += packetCombos) {
    const current = encoded.slice(start, start + packetCombos);
    const header = new Uint8Array(11);
    const dv = new DataView(header.buffer);
    dv.setUint16(0, 22, true);
    dv.setUint16(2, 0, true);
    dv.setUint16(4, total, true);
    dv.setUint16(6, start, true);
    dv.setUint16(8, current.length, true);
    header[10] = source;
    result.push(concatBytes([header, ...current]));
  }
  return result;
}

function safeClass(value) {
  return value >= 1 && value <= 26 ? String.fromCharCode(64 + value) : value === 0 ? "-" : `X${value}`;
}

function modernLteRows(rrc, suffix, antennaNames) {
  const field = `lte_info_per_band_sub_cap_${suffix}`;
  const rawRecords = chunks(rrc[field], 50).slice(0, rrc[`${field}_num`]);
  const combos = [];
  const components = [];
  rawRecords.forEach((raw, comboIndex) => {
    const expression = decodeLteCombo(raw);
    const r = new StructReader(raw);
    const comboComponents = [];
    for (let position = 0; position < 6; position++) {
      const offset = 2 + position * 8;
      const [band, dlClass, dlAnt, ulClass, ulAnt, ulQam] = r.unpack("<HBBBBB", offset);
      if (!band) continue;
      const component = {
        table: "lte_ca",
        sub_capability: suffix,
        combo_index: comboIndex,
        position: comboComponents.length,
        technology: "LTE",
        band,
        dl_bw_class_code: dlClass,
        dl_bw_class: safeClass(dlClass),
        dl_bw_code: null,
        dl_bandwidth: null,
        dl_antenna_index: dlAnt,
        dl_antenna: antennaNames.get(dlAnt) ?? `INDEX_${dlAnt}`,
        ul_bw_class_code: ulClass,
        ul_bw_class: safeClass(ulClass),
        ul_bw_code: null,
        ul_bandwidth: null,
        ul_antenna_index: ulAnt,
        ul_antenna: antennaNames.get(ulAnt) ?? `INDEX_${ulAnt}`,
        ul_qam_cap_index: ulQam,
      };
      comboComponents.push(component);
      components.push(component);
    }
    combos.push({
      table: "lte_ca",
      table_name: TABLE_DISPLAY.lte_ca,
      sub_capability: suffix,
      combo_index: comboIndex,
      expression,
      component_count: comboComponents.length,
      power_class: null,
      bcs_num: null,
      ul_tx_switch_type: null,
      higher_power_limit: null,
      raw_hex: bytesHex(raw),
    });
  });
  return [combos, components];
}

function modernNrRows(rrc, suffix, prefix, table, bwNames, antennaNames) {
  const records = nrSectionRecords(rrc, prefix, suffix);
  const combos = [];
  const components = [];
  records.forEach(([groups, prop], comboIndex) => {
    const expression = groups.map((group) => decodeNrBandGroup(group, bwNames, antennaNames)).join("+");
    groups.forEach((group, position) => {
      components.push({
        table,
        sub_capability: suffix,
        combo_index: comboIndex,
        position,
        technology: group.tech === 1 ? "LTE" : group.tech === 2 ? "NR" : `TECH_${group.tech}`,
        band: group.band,
        dl_bw_class_code: group.dl_bw_class,
        dl_bw_class: safeClass(group.dl_bw_class),
        dl_bw_code: group.dl_bw_per_cc,
        dl_bandwidth: bwNames.get(group.dl_bw_per_cc) ?? null,
        dl_antenna_index: group.dl_max_antennas_index,
        dl_antenna: antennaNames.get(group.dl_max_antennas_index) ?? `INDEX_${group.dl_max_antennas_index}`,
        ul_bw_class_code: group.ul_bw_class,
        ul_bw_class: safeClass(group.ul_bw_class),
        ul_bw_code: group.ul_bw_per_cc,
        ul_bandwidth: bwNames.get(group.ul_bw_per_cc) ?? null,
        ul_antenna_index: group.ul_max_antennas_index,
        ul_antenna: antennaNames.get(group.ul_max_antennas_index) ?? `INDEX_${group.ul_max_antennas_index}`,
        ul_qam_cap_index: group.ul_qam_cap_index,
        max_scs: group.max_scs,
        srs_tx_switch_type: group.srs_tx_switch_type,
        tx_switch_impact_to_rx: group.tx_switch_impact_to_rx,
        tx_switch_with_another_band: group.tx_switch_with_another_band,
        srs_carrier_hop: group.srs_carrier_hop,
        srs_carrier_hop_src: group.srs_carrier_hop_src,
        rx_limit: group.rx_limit,
        link_id: group.link_id,
      });
    });
    combos.push({
      table,
      table_name: TABLE_DISPLAY[table],
      sub_capability: suffix,
      combo_index: comboIndex,
      expression,
      component_count: groups.length,
      power_class: prop.power_class,
      bcs_num: prop.bcs_num,
      ul_tx_switch_type: prop.ul_tx_switch_type,
      higher_power_limit: !!prop.higher_power_limit,
      tdd_ant_swt_fdd_disruption: !!prop.tdd_ant_swt_fdd_disruption,
      simultaneous_rx_tx_endc: !!prop.simultaneousRxTxInterBandENDC,
      simultaneous_rx_tx_ca: !!prop.simultaneousRxTxInterBandCA,
      simultaneous_rx_tx_sul: !!prop.simultaneousRxTxInterBandSUL,
      intra_contig_type: prop.intra_contig_type,
      srs_cs_type: prop.srs_cs_type,
      intra_ulca_dual_pa: !!prop.intra_ulca_dual_pa,
      has_bcs5_counterpart: !!prop.has_bcs5_counterpart,
      env_mode_mask_idx: prop.env_mode_mask_idx,
      env_mode_subset_mask_idx: prop.env_mode_subset_mask_idx,
      simul_rxtx_bmap_idx: prop.simul_rxtx_bmap_idx,
      simul_sul_rxtx_bmap_idx: prop.simul_sul_rxtx_bmap_idx,
    });
  });
  return [combos, components, records];
}

function pyStrip(text) {
  return text.replace(/^[\t\n\x0b\x0c\r ]+|[\t\n\x0b\x0c\r ]+$/g, "");
}

export function readRfcardInfo(datName, inputName, rrc) {
  // Recover the RFCard identifiers and embedded RRC environment names.
  const datMatch = /(?:^|\/)(\d+)_(\d+)_(?:res|cmn)\.dat\n?$/i.exec(datName);
  const mbnMatch = /rf_config_(\d+)_(\d+)_(\d+)\.mbn\n?$/i.exec(inputName);
  let hwid = datMatch ? parseInt(datMatch[1], 10) : null;
  let fsid = datMatch ? parseInt(datMatch[2], 10) : null;
  const bid = mbnMatch ? parseInt(mbnMatch[3], 10) : null;
  if (mbnMatch) {
    if (hwid === null) hwid = parseInt(mbnMatch[1], 10);
    if (fsid === null) fsid = parseInt(mbnMatch[2], 10);
  }
  const envHigh = pyStrip(rrc.env_name_high);
  const envLow = pyStrip(rrc.env_name_low);
  let displayName = envHigh || envLow;
  if (!displayName && hwid !== null && fsid !== null) displayName = `RFCARD_HWID${hwid}_FSID${fsid}`;
  return {
    name: displayName || null,
    name_source: envHigh
      ? "res.rrc.env_name_high"
      : envLow
        ? "res.rrc.env_name_low"
        : displayName
          ? "derived_from_hwid_fsid"
          : null,
    canonical_xml_variant_name: null,
    canonical_xml_variant_name_embedded: false,
    hwid,
    fsid,
    bid,
    key: hwid !== null && fsid !== null ? `${hwid}_${fsid}` : null,
    res_dat_path: datName,
    environment_name_high: envHigh || null,
    environment_name_low: envLow || null,
  };
}

function moduleFields(record) {
  return {
    inner_path: record.inner_path,
    name: record.name,
    generation: record.generation ?? null,
    size: record.size ?? null,
    hwid: record.hwid ?? null,
    fsid: record.fsid ?? null,
    bid: record.bid ?? null,
    external: record.external ?? false,
    source_path: record.source_path ?? "",
    sidecars: record.sidecars ?? {},
    sha256: record.sha256 ?? "",
    lte_combos: record.lte_combos ?? -1,
    nr_combos: record.nr_combos ?? "",
  };
}

const SECTION_SPECS = [
  ["nr5g", "nr_ca", 4],
  ["lte_nr5g", "endc", 3],
  ["nr5g_nr5g", "nrdc", 5],
];

export function parseModernModule(record, blob) {
  const dats = extractRfcDats(blob);
  const resItems = dats
    .filter((d) => d.name.toLowerCase().endsWith("_res.dat"))
    .map((d) => [d.name, d.data]);
  if (resItems.length === 0) throw new ToolError("No embedded /rfc/*_res.dat was found");
  if (resItems.length > 1) {
    throw new ToolError("More than one *_res.dat was found: " + resItems.map(([name]) => name).join(", "));
  }
  const [datName, resDat] = resItems[0];
  const { encoding, payload, rrc } = parseResDat(resDat);
  const cardInfo = readRfcardInfo(datName, record.name, rrc);

  const enumMap = enumAssignments();
  const bwNames = reverseEnum(enumMap, "BW_");
  const antennaNames = reverseEnum(enumMap, "ANTENNA_");

  const combinations = [];
  const components = [];
  const b0cdPackets = [];
  const b826Packets = [];
  for (const suffix of ["high", "low"]) {
    const [lteCombos, lteComponents] = modernLteRows(rrc, suffix, antennaNames);
    combinations.push(...lteCombos);
    components.push(...lteComponents);
    const ltePackets = b0cdV41Packets(rrc, suffix);
    ltePackets.forEach((packet, index) => {
      b0cdPackets.push([`${suffix} LTE CA packet ${index + 1}/${ltePackets.length}`, packet]);
    });

    for (const [prefix, table, source] of SECTION_SPECS) {
      const [comboRows, componentRows, rawRecords] = modernNrRows(rrc, suffix, prefix, table, bwNames, antennaNames);
      combinations.push(...comboRows);
      components.push(...componentRows);
      const packets = rawRecords.length ? b826V22Packets(rawRecords, source) : [];
      packets.forEach((packet, index) => {
        b826Packets.push([
          `${suffix} ${TABLE_DISPLAY[table]} source=${source} packet ${index + 1}/${packets.length}`,
          packet,
        ]);
      });
    }
  }

  return {
    metadata: {
      tool: "Qualcomm RF Combination Extractor",
      version: VERSION,
      generation: record.generation ?? null,
      module: moduleFields(record),
      module_sha256: sha256Hex(blob),
      res_dat_path: datName,
      res_dat_sha256: sha256Hex(resDat),
      dat_encoding: encoding,
      protobuf_size: payload.length,
      rfcard: cardInfo,
      diag_note: "Headerless synthetic DIAG payloads reconstructed from static RFCard tables.",
    },
    combinations,
    components,
    diag: { b0cd: b0cdPackets, b826: b826Packets },
  };
}
