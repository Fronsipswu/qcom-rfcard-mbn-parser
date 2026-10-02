// Corpus-gated test for the additive scanSource cancellation hook
// (Task 11: worker cancellation checks between files and inside the FAT walk
// loop). The callback is optional and defaults to a no-op, so every existing
// golden stays byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { sourceFor } from "../js/lib/source.js";
import { CORPUS_DIR, corpusAvailable, deepEqualOrdered } from "./helpers.mjs";
import { scanSource, recordJson, ScanCancelled } from "../js/lib/analyzer.js";

test("scanSource without options behaves exactly as before (golden spot-check)", { skip: !corpusAvailable() }, async () => {
  const corpus = JSON.parse(await readFile(new URL("../goldens/corpus.json", import.meta.url)));
  const img = "ximi18max_modemfirmware_a.img";
  assert.ok(corpus[img], "corpus.json contains the image");
  const src = await sourceFor(join(CORPUS_DIR, img));
  try {
    const result = await scanSource(src, img);
    deepEqualOrdered(result.records.map(recordJson), corpus[img], img);
  } finally {
    await src.close();
  }
});

test("scanSource honours shouldCancel checked before the walk and per iteration", { skip: !corpusAvailable() }, async (t) => {
  await t.test("cancel before any work -> ScanCancelled", async () => {
    const src = await sourceFor(join(CORPUS_DIR, "ximi18max_modemfirmware_a.img"));
    try {
      await assert.rejects(
        () => scanSource(src, "ximi18max_modemfirmware_a.img", { shouldCancel: () => true }),
        (err) => err instanceof ScanCancelled,
      );
    } finally {
      await src.close();
    }
  });

  await t.test("cancel mid-walk -> ScanCancelled (per-iteration check)", async () => {
    const src = await sourceFor(join(CORPUS_DIR, "11lite5g_modem.img"));
    let calls = 0;
    try {
      await assert.rejects(
        () => scanSource(src, "11lite5g_modem.img", {
          shouldCancel: () => (calls += 1) > 3, // entry + per FAT-walk iteration checks
        }),
        (err) => err instanceof ScanCancelled,
      );
      assert.ok(calls > 3, "shouldCancel must be consulted repeatedly during the walk");
    } finally {
      await src.close();
    }
  });
});
