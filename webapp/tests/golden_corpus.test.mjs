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

// Count-stage progress: direct FAT16 images report { stage: "count" } per
// processed candidate (gates applied upfront, records built per target);
// container images report { stage: "extract" } before extraction, then the
// same count-stage infos per discovered MBN. The final count done must equal
// the records the scan produced AND the reported total (no gated-out or
// deduped candidates remain on these images).
test("scanSource reports count-stage progress matching the produced records", { skip: !corpusAvailable() }, async () => {
  // One direct FAT16 image + both container images cover both count paths.
  const imgs = [
    "17uCNOS4beta.img",
    "radio.img",
    "CP_F976BXXU1AZFW_CP35078515_MQB111318003_REV00_user_low_ship_MULTI_CERT.tar.md5",
  ];
  for (const img of imgs) {
    const isContainer = img !== "17uCNOS4beta.img";
    const src = await sourceFor(join(CORPUS_DIR, img));
    try {
      const infos = [];
      const { records } = await scanSource(src, img, { onScanProgress: (info) => infos.push(info) });
      const counts = infos.filter((i) => i.stage === "count");
      assert.ok(counts.length > 0, `${img}: expected count-stage progress infos`);
      // Containers: exactly one uncountable "extract" phase, before any count.
      const extracts = infos.filter((i) => i.stage === "extract");
      assert.equal(extracts.length, isContainer ? 1 : 0, `${img}: extract infos`);
      assert.equal(infos[0].stage, isContainer ? "extract" : "count", `${img}: first info stage`);
      assert.equal(counts[0].done, 0, `${img}: count stage starts at 0`);
      for (let i = 1; i < counts.length; i++) {
        assert.ok(counts[i].done >= counts[i - 1].done, `${img}: count done non-decreasing at info ${i}`);
      }
      assert.ok(counts.every((i) => i.done <= i.total), `${img}: no count info exceeds total`);
      assert.equal(counts[counts.length - 1].done, records.length, `${img}: final count done === records.length`);
      assert.equal(counts[counts.length - 1].done, counts[counts.length - 1].total, `${img}: count done ends at total`);
    } finally {
      await src.close();
    }
  }
});
