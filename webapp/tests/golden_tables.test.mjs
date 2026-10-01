// Golden (corpus-gated): generateWebTables must reproduce
// webapp/goldens/tables/<imgTag>__<safe>.json exactly (deepEqualOrdered:
// column names AND their insertion order per row).
//
// Each image is walked once; records are re-parsed through the same
// parseModule dispatch the analyzer uses. Container records (radio.img
// sparse/ + tar.md5 fat/) resolve through the Task 9 extraction layer, keyed
// by the normalized inner_path (all 383 goldens tested).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Fat16Image } from "../js/lib/fat16.js";
import { sourceFor } from "../js/lib/source.js";
import { CORPUS_DIR, corpusAvailable, deepEqualOrdered } from "./helpers.mjs";
import { parseModule, generateWebTables } from "../js/lib/analyzer.js";
import { containerBlobs } from "./helpers.mjs";

test("generate_web_tables matches Python goldens for every corpus record", { skip: !corpusAvailable() }, async () => {
  const corpus = JSON.parse(await readFile(new URL("../goldens/corpus.json", import.meta.url)));
  let tested = 0;
  let images = 0;
  for (const [img, recs] of Object.entries(corpus)) {
    images++;
    const src = await sourceFor(join(CORPUS_DIR, img));
    try {
      let readBlob;
      if (recs.some((r) => !r.inner_path.startsWith("/"))) {
        // container image: MBN blobs come from the extraction layer
        const blobs = await containerBlobs(src, img);
        readBlob = async (rec) => {
          const vfile = blobs.get(rec.inner_path);
          assert.ok(vfile, `${img}: extraction missed ${rec.inner_path}`);
          return vfile.read();
        };
      } else {
        const fat = new Fat16Image(src);
        await fat.init();
        const byPath = new Map((await fat.walk()).map((e) => [e.path, e]));
        readBlob = async (rec) => {
          const entry = byPath.get(rec.inner_path);
          assert.ok(entry, `${img}: missing ${rec.inner_path}`);
          return fat.readFile(entry);
        };
      }
      const imgTag = img.replace(/\.[^.]+$/, "").slice(0, 40).replaceAll(" ", "_");
      for (const rec of recs) {
        const blob = await readBlob(rec);
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
  assert.equal(images, 13);
  assert.equal(tested, 383);
});
