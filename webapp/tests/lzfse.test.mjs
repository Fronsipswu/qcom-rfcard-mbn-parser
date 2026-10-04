// LZFSE decode-only port tests (plan Task 1). Corpus-gated hard gate: every CR
// stream in both golden ftab.bin files must decompress byte-exactly (sha256 +
// length) to the pre-extracted golden bank files.
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { CORPUS_DIR } from "./helpers.mjs";
import { lzfseDecode } from "../js/lib/lzfse.js";

const sha256 = (u8) => createHash("sha256").update(u8).digest("hex");
const REF = join(CORPUS_DIR, "apple-c-modem-parser");
const corpusAvailableForApple = () =>
  existsSync(join(REF, "c1", "ftab.bin")) && existsSync(join(REF, "c2", "ftab_cr_banks"));

test("lzfse: synthetic bvx- (raw) block round-trips", () => {
  const raw = new TextEncoder().encode("hello lzfse raw block, plainly stored");
  const stream = new Uint8Array(8 + raw.length + 4);
  const dv = new DataView(stream.buffer);
  dv.setUint32(0, 0x2d787662, true); // bvx-
  dv.setUint32(4, raw.length, true);
  stream.set(raw, 8);
  dv.setUint32(8 + raw.length, 0x24787662, true); // bvx$ end of stream
  assert.equal(new TextDecoder().decode(lzfseDecode(stream)), new TextDecoder().decode(raw));
});

test("lzfse: truncated stream throws", () => {
  assert.throws(() => lzfseDecode(new Uint8Array([0x62, 0x76, 0x78, 0x2d])), /lzfse/);
});

// Inline FTAB walk (lzfse-only test; apple_ftab.js does the full contract):
// magic "rkosftab" at +0x20, entries from +0x30, stride 16 = [4-char tag]
// [u32 offset LE][u32 size][u32 reserved]; CR entries carry a 12-byte envelope
// at <offset>: [u32 profile_id][u32 uncomp_size][u32 comp_size]; the stream
// starts at offset+12.
function ftabCrEntries(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(String.fromCharCode(...data.subarray(0x20, 0x28)), "rkosftab");
  const entries = [];
  let off = 0x30;
  while (off + 16 <= data.length) {
    let printable = true;
    for (let i = 0; i < 4; i++) {
      const c = data[off + i];
      if (c < 32 || c >= 127) {
        printable = false;
        break;
      }
    }
    if (!printable) break;
    const tag = String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
    const eoff = dv.getUint32(off + 4, true);
    const size = dv.getUint32(off + 8, true);
    const res = dv.getUint32(off + 12, true);
    if (res !== 0 || eoff > data.length || eoff + size > data.length) break;
    if (tag.startsWith("CR")) {
      const profileId = dv.getUint32(eoff, true);
      const uncomp = dv.getUint32(eoff + 4, true);
      const comp = dv.getUint32(eoff + 8, true);
      entries.push({ tag, profileId, uncomp, comp, streamStart: eoff + 12 });
    }
    off += 16;
  }
  return entries;
}

test("lzfse: every CR stream in both golden ftabs decompresses to the exact golden bank", { skip: !corpusAvailableForApple() }, async () => {
  let checked = 0;
  for (const layout of ["c1", "c2"]) {
    const ftab = await readFile(join(REF, layout, "ftab.bin"));
    const entries = ftabCrEntries(ftab);
    for (const e of entries) {
      const bank = await readFile(join(REF, layout, "ftab_cr_banks", `${e.tag}.bin`));
      assert.equal(bank.length, e.uncomp, `${layout}/${e.tag}: envelope uncomp_size`);
      const stream = ftab.subarray(e.streamStart, e.streamStart + e.comp);
      const out = lzfseDecode(stream);
      assert.equal(out.length, bank.length, `${layout}/${e.tag}: decoded length`);
      assert.equal(sha256(out), sha256(bank), `${layout}/${e.tag}: decoded sha256`);
      checked++;
    }
  }
  assert.equal(checked, 58, "expected 21 c1 + 37 c2 CR banks");
});
