// Golden (corpus-gated): scanSource must reproduce tools/generate_goldens.py
// corpus.json exactly — records.map(recordJson) compared with deepEqualOrdered
// (key order and array order sensitive). All 13 images flow through the same
// scanSource path: direct-FAT16 walks and the Task 9 container fallback
// (radio.img: Motorola wrapper -> sparse -> ext4; the Samsung tar.md5:
// tar -> lz4 -> FAT16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceFor } from "../js/lib/source.js";
import { CORPUS_DIR, corpusAvailable, deepEqualOrdered } from "./helpers.mjs";
import { scanSource, recordJson } from "../js/lib/analyzer.js";

test("scanSource matches corpus.json records on all 13 corpus images", { skip: !corpusAvailable() }, async () => {
  const corpus = JSON.parse(await readFile(new URL("../goldens/corpus.json", import.meta.url)));
  let tested = 0;
  for (const [img, expected] of Object.entries(corpus)) {
    const src = await sourceFor(join(CORPUS_DIR, img));
    try {
      const result = await scanSource(src, img);
      deepEqualOrdered(result.records.map(recordJson), expected, img);
      assert.deepEqual(result.warnings, [], `${img}: unexpected warnings`);
      tested++;
    } finally {
      await src.close();
    }
  }
  assert.equal(tested, 13);
});
