// Golden (corpus-gated): generateWebTables must reproduce
// webapp/goldens/tables/<imgTag>__<safe>.json exactly (deepEqualOrdered:
// column names AND their insertion order per row).
//
// Each image is walked once; records are re-parsed through the same
// parseModule dispatch the analyzer uses. The 8 records inside containers
// (radio.img sparse/ + tar.md5 fat/) stay untestable until Task 9; the
// asserted counts make that explicit (375 tested = 383 goldens - 8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Fat16Image } from "../js/lib/fat16.js";
import { sourceFor } from "../js/lib/source.js";
import { CORPUS_DIR, corpusAvailable, deepEqualOrdered } from "./helpers.mjs";
import { parseModule, generateWebTables } from "../js/lib/analyzer.js";

test("generate_web_tables matches Python goldens for every corpus record", { skip: !corpusAvailable() }, async () => {
  const corpus = JSON.parse(await readFile(new URL("../goldens/corpus.json", import.meta.url)));
  let tested = 0;
  let skipped = 0;
  let images = 0;
  for (const [img, recs] of Object.entries(corpus)) {
    if (recs.some((r) => !r.inner_path.startsWith("/"))) {
      skipped += recs.length; // container records: Task 9
      continue;
    }
    images++;
    const src = await sourceFor(join(CORPUS_DIR, img));
    try {
      const fat = new Fat16Image(src);
      await fat.init();
      const byPath = new Map((await fat.walk()).map((e) => [e.path, e]));
      const imgTag = img.replace(/\.[^.]+$/, "").slice(0, 40).replaceAll(" ", "_");
      for (const rec of recs) {
        const entry = byPath.get(rec.inner_path);
        assert.ok(entry, `${img}: missing ${rec.inner_path}`);
        const blob = await fat.readFile(entry);
        const parsed = parseModule({ name: rec.name, inner_path: rec.inner_path, generation: rec.generation }, blob);
        const tables = generateWebTables(parsed.combinations, parsed.components);
        const goldenPath = `../goldens/tables/${imgTag}__${rec.name.replaceAll("/", "_")}.json`;
        const expected = JSON.parse(await readFile(new URL(goldenPath, import.meta.url)));
        deepEqualOrdered(tables, expected, `${img}/${rec.name}`);
        tested++;
      }
    } finally {
      await src.close();
    }
  }
  assert.equal(images, 11);
  assert.equal(tested, 375);
  assert.equal(skipped, 8);
});
