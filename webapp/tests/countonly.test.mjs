// B1 count-only fast path: countModernCombos must tally exactly the same
// per-table combination counts as a full parseModernModule, without building
// components/DIAG packets/metadata. Verified on a synthetic modern blob and
// every modern record in the golden corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zlibSync } from "../lib/vendor/fflate.js";
import { CORPUS_DIR, corpusAvailable } from "./helpers.mjs";
import { countModernCombos, parseModernModule } from "../js/lib/modern_parser.js";
import { parseModule, matchesCandidate, normalizeInnerPath } from "../js/lib/analyzer.js";
import { sourceFor } from "../js/lib/source.js";
import { Fat16Image } from "../js/lib/fat16.js";
import { extractContainer, discoverCandidates } from "../js/lib/extractor.js";

function framedItem(path, data) {
  const enc = new TextEncoder();
  const p = enc.encode(path);
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

function makeModernBlob() {
  const payload = new TextEncoder().encode("\x3a\x04\x0a\x02te");
  const stream = zlibSync(payload);
  const resDat = new Uint8Array(5 + 4 + stream.length);
  resDat.fill(0x22, 0, 5);
  new DataView(resDat.buffer).setUint32(5, payload.length, true);
  resDat.set(stream, 9);
  return framedItem("/rfc/modem_rfcard_res.dat", resDat);
}

// Blob lookup for corpus records, mirroring the worker's readRecordBlob
// resolution order (FAT chain -> container re-extraction).
async function readBlobForTest(source, record, label) {
  if (record.external && record.inner_path === record.name && matchesCandidate(record.name)) {
    return source.read(0, source.size);
  }
  const fat = new Fat16Image(source);
  try {
    await fat.init();
    const entry = await fat.findFile(record.inner_path);
    if (entry) return (await fat.readClusters(entry.firstCluster)).slice(0, entry.size);
  } catch {
    // not FAT16: fall through to container extraction
  }
  const { outputs } = await extractContainer(source, label);
  const { mbns } = discoverCandidates(outputs);
  const wanted = normalizeInnerPath(record.inner_path);
  for (const { vfile, path } of mbns) {
    if (vfile.name === record.name && normalizeInnerPath(path) === wanted) return vfile.read();
  }
  throw new Error(`record not found in source: ${record.name} (${record.inner_path})`);
}

test("countModernCombos matches countTableRows(parseModernModule(...)) on synthetic and corpus cards", { skip: !corpusAvailable() }, async () => {
  // Synthetic: reuse the modern blob fixture from analyzer.test.mjs (makeModernBlob,
  // framedItem) with a record whose generation parses as modern.
  const blob = makeModernBlob();
  const record = { name: "rf_config_615_0_0.mbn", generation: "modern", hwid: null, fsid: null, bid: null };
  const full = parseModernModule(record, blob);
  const counts = {};
  for (const combo of full.combinations) counts[combo.table] = (counts[combo.table] ?? 0) + 1;
  assert.deepEqual(countModernCombos(record, blob), counts);

  // Corpus: every modern card in the golden corpus must agree too.
  const corpus = JSON.parse(await readFile(new URL("../goldens/corpus.json", import.meta.url)));
  for (const [img, records] of Object.entries(corpus)) {
    const src = await sourceFor(join(CORPUS_DIR, img));
    try {
      for (const record of records.filter((r) => r.generation !== "Legacy ELF" && r.generation !== "legacy")) {
        const blob = await readBlobForTest(src, record, img);
        const parsed = parseModule(record, blob);
        const expected = {};
        for (const combo of parsed.combinations) expected[combo.table] = (expected[combo.table] ?? 0) + 1;
        assert.deepEqual(countModernCombos(record, blob), expected, `${img} ${record.name}`);
      }
    } finally {
      await src.close();
    }
  }
});
