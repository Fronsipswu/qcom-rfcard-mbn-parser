// FTAB / bbfw container-layer tests (plan Task 2). Corpus-gated golden gates +
// a synthetic hand-rolled stored-entry zip exercising findFtabInBbfw.
import test from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { CORPUS_DIR } from "./helpers.mjs";
import { FTAB_MAGIC_OFFSET, isFtab, parseFtabEntries, findFtabInBbfw } from "../js/lib/apple_ftab.js";

const REF = join(CORPUS_DIR, "apple-c-modem-parser");
const corpusAvailableForApple = () =>
  existsSync(join(REF, "c1", "ftab.bin")) && existsSync(join(REF, "c2", "ftab_cr_banks"));

test("isFtab: magic at +0x20, false on short input", () => {
  assert.equal(FTAB_MAGIC_OFFSET, 0x20);
  assert.equal(isFtab(new Uint8Array(10)), false);
  const short = new Uint8Array(0x27);
  short.set(new TextEncoder().encode("rkosftab"), 0x20 - 1); // would end at 0x27
  assert.equal(isFtab(short), false);
  const ok = new Uint8Array(0x40);
  ok.set(new TextEncoder().encode("rkosftab"), 0x20);
  assert.equal(isFtab(ok), true);
});

test("golden c2 ftab: 37 CR descriptors, first CR04 profile 0x1F2126, uncomp 0x590D00", { skip: !corpusAvailableForApple() }, async () => {
  const ftab = await readFile(join(REF, "c2", "ftab.bin"));
  const entries = parseFtabEntries(ftab);
  assert.equal(entries.length, 37);
  assert.equal(entries[0].name, "CR04");
  assert.equal(entries[0].profileId, 0x1f2126);
  for (const e of entries) {
    assert.equal(e.uncompSize, 0x590d00, `${e.name}: uncompSize`);
    assert.ok(e.compSize > 0, `${e.name}: compSize`);
    assert.equal(e.streamStart, e.offset + 12, `${e.name}: streamStart`);
    assert.ok(e.tag.startsWith("CR"), `${e.name}: tag`);
  }
});

test("golden c1 ftab: 21 CR descriptors, first CR11 profile 0x10548C, uncomp 0x5776E0", { skip: !corpusAvailableForApple() }, async () => {
  const ftab = await readFile(join(REF, "c1", "ftab.bin"));
  const entries = parseFtabEntries(ftab);
  assert.equal(entries.length, 21);
  assert.equal(entries[0].name, "CR11");
  assert.equal(entries[0].profileId, 0x10548c);
  for (const e of entries) assert.equal(e.uncompSize, 0x5776e0, `${e.name}: uncompSize`);
});

test("golden descriptor envelopes match the committed manifest without decompressing", { skip: !corpusAvailableForApple() }, async () => {
  const manifest = JSON.parse(await readFile(new URL("../goldens/apple/manifest.json", import.meta.url)));
  for (const layout of ["c1", "c2"]) {
    const ftab = await readFile(join(REF, layout, "ftab.bin"));
    const entries = parseFtabEntries(ftab);
    assert.equal(entries.length, layout === "c1" ? 21 : 37);
    for (const e of entries) {
      const m = manifest[`${layout}/${e.name}`];
      assert.ok(m, `${layout}/${e.name}: missing from manifest`);
      assert.equal(e.profileId, m.profile_id, `${layout}/${e.name}: profileId`);
      assert.ok(e.compSize > 0 && e.compSize < ftab.length, `${layout}/${e.name}: compSize sane`);
      assert.equal(e.streamStart, e.offset + 12);
    }
  }
});

test("parseFtabEntries throws on non-ftab input", () => {
  assert.throws(() => parseFtabEntries(new Uint8Array(0x100)), /rkosftab/);
});

// --- synthetic bbfw (hand-rolled stored-entry zip; the vendored fflate build
// exposes no zipSync, so the test builds the zip deterministically) ------------

function crc32(u8) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ table[(crc ^ u8[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function storedZip(members) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of members) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(8, 0, true); // method 0 = stored
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // method 0 = stored
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// Tiny synthetic ftab: "rkosftab" at +0x20, one kernel entry and one CR entry
// whose envelope holds a bvx- raw stream (lzfse.js not needed to parse it).
function syntheticFtab() {
  const raw = new TextEncoder().encode("synthetic apple CR bank payload");
  const stream = new Uint8Array(8 + raw.length + 4);
  const sv = new DataView(stream.buffer);
  sv.setUint32(0, 0x2d787662, true); // bvx-
  sv.setUint32(4, raw.length, true);
  stream.set(raw, 8);
  sv.setUint32(8 + raw.length, 0x24787662, true); // bvx$
  const envOffset = 0x30 + 2 * 16; // after the two entry slots
  const profileId = 0x123456;
  const envSize = 12 + stream.length;
  const ftab = new Uint8Array(envOffset + envSize);
  const dv = new DataView(ftab.buffer);
  ftab.set(new TextEncoder().encode("rkosftab"), 0x20);
  // entry 1: kernel tag (ignored by the CR walk)
  ftab.set(new TextEncoder().encode("krnl"), 0x30);
  dv.setUint32(0x34, 0, true);
  dv.setUint32(0x38, 0, true);
  dv.setUint32(0x3c, 0, true);
  // entry 2: CR01 with a 12-byte envelope + bvx- stream
  ftab.set(new TextEncoder().encode("CR01"), 0x40);
  dv.setUint32(0x44, envOffset, true);
  dv.setUint32(0x48, envSize, true);
  dv.setUint32(0x4c, 0, true);
  dv.setUint32(envOffset, profileId, true);
  dv.setUint32(envOffset + 4, raw.length, true);
  dv.setUint32(envOffset + 8, stream.length, true);
  ftab.set(stream, envOffset + 12);
  return { ftab, profileId, rawLen: raw.length, streamLen: stream.length };
}

test("findFtabInBbfw: synthetic stored zip with an inner ftab member", async () => {
  const { ftab, profileId, rawLen, streamLen } = syntheticFtab();
  const zip = storedZip([
    { name: "kernelcache.research", data: new Uint8Array(16) },
    { name: "022-22116-011__ftab.bin", data: ftab },
  ]);
  const entries = await findFtabInBbfw(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "CR01");
  assert.equal(entries[0].tag, "CR01");
  assert.equal(entries[0].profileId, profileId);
  assert.equal(entries[0].uncompSize, rawLen);
  assert.equal(entries[0].compSize, streamLen);
  assert.equal(entries[0].streamStart, entries[0].offset + 12);
});

test("findFtabInBbfw: nested bbfw zip inside an ipsw-style outer zip", async () => {
  const { ftab } = syntheticFtab();
  const inner = storedZip([{ name: "ftab.bin", data: ftab }]);
  const outer = storedZip([
    { name: "baseband firmware.n56.bbfw", data: inner },
  ]);
  const entries = await findFtabInBbfw(outer);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "CR01");
});

test("findFtabInBbfw: throws when no ftab member exists", async () => {
  const zip = storedZip([{ name: "unrelated.bin", data: new Uint8Array(32) }]);
  await assert.rejects(() => findFtabInBbfw(zip), /ftab/i);
});
