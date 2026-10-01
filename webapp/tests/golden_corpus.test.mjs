// Golden (corpus-gated): scanSource must reproduce tools/generate_goldens.py
// corpus.json exactly — records.map(recordJson) compared with deepEqualOrdered
// (key order and array order sensitive).
//
// Task 9 boundary: radio.img (sparse) and the Samsung tar.md5 (fat) records
// live inside containers that are not ported yet; their inner paths start with
// "sparse/"/"fat/" instead of "/". scanSource must already return the
// structured empty-with-warnings result for them; the assertions below pin the
// skip count so Task 9 has to lift it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceFor } from "../js/lib/source.js";
import { CORPUS_DIR, corpusAvailable, deepEqualOrdered } from "./helpers.mjs";
import { scanSource, recordJson } from "../js/lib/analyzer.js";

test("scanSource matches corpus.json records on all direct-FAT16 images", { skip: !corpusAvailable() }, async () => {
  const corpus = JSON.parse(await readFile(new URL("../goldens/corpus.json", import.meta.url)));
  let tested = 0;
  let skipped = 0;
  const skippedImages = [];
  for (const [img, expected] of Object.entries(corpus)) {
    const src = await sourceFor(join(CORPUS_DIR, img));
    try {
      const result = await scanSource(src, img);
      if (expected.some((r) => !r.inner_path.startsWith("/"))) {
        // Container record: Task 9 must produce the records; for now the
        // scan must fail softly with a warning, never throw.
        assert.deepEqual(result.records, [], img);
        assert.ok(result.warnings.length >= 1, `${img}: expected a container warning`);
        skippedImages.push(img);
        skipped++;
        continue;
      }
      deepEqualOrdered(result.records.map(recordJson), expected, img);
      tested++;
    } finally {
      await src.close();
    }
  }
  assert.equal(tested, 11);
  assert.equal(skipped, 2);
  assert.deepEqual(skippedImages.sort(), [
    "CP_F976BXXU1AZFW_CP35078515_MQB111318003_REV00_user_low_ship_MULTI_CERT.tar.md5",
    "radio.img",
  ]);
});
