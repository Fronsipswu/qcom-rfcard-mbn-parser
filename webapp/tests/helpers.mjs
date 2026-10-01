import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

export const CORPUS_DIR = process.env.CORPUS_DIR ?? "/home/henrik/apps/qualcomm-hwcombos-mbn-parser";
export const corpusAvailable = () => existsSync(CORPUS_DIR) && existsSync(join(CORPUS_DIR, "radio.img"));

export function skipWithoutCorpus(t) {
  if (!corpusAvailable()) { t.skip("corpus not available"); }
}

// Python-style deep equal that also checks key insertion order
export function deepEqualOrdered(a, b, path = "$") {
  if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${path}: length`);
    a.forEach((v, i) => deepEqualOrdered(v, b[i], `${path}[${i}]`));
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    assert.deepEqual(ka, kb, `${path}: key order/set`);
    ka.forEach((k) => deepEqualOrdered(a[k], b[k], `${path}.${k}`));
  } else {
    assert.equal(a, b, `${path}`);
  }
}
