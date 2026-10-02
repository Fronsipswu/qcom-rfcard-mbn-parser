// Unit tests for the batch-export plan helpers (webapp/js/exportplan.js):
// job list construction (ticked cards x enabled formats), the files-vs-zip
// delivery decision, deterministic zip entry name dedupe, and the BOM
// preserving UTF-8 decode used before every download (Python writes utf-8-sig).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_FORMATS,
  ZIP_FILE_THRESHOLD,
  buildExportJobs,
  deliveryMode,
  dedupeFilenames,
  decodeExportBytes,
} from "../js/exportplan.js";

test("EXPORT_FORMATS lists the five export formats in canonical order", () => {
  assert.deepEqual(EXPORT_FORMATS, ["json", "csv", "webcsv", "b0cd", "b826"]);
});

test("buildExportJobs pairs every ticked card with every enabled format", () => {
  const cardA = { key: "a" };
  const cardB = { key: "b" };
  const jobs = buildExportJobs([cardA, cardB], ["json", "b0cd"]);
  assert.deepEqual(jobs, [
    { card: cardA, format: "json" },
    { card: cardA, format: "b0cd" },
    { card: cardB, format: "json" },
    { card: cardB, format: "b0cd" },
  ]);
});

test("buildExportJobs applies formats in canonical order regardless of input order", () => {
  const jobs = buildExportJobs([{ key: "a" }], ["b826", "json", "webcsv"]);
  assert.deepEqual(jobs.map((j) => j.format), ["json", "webcsv", "b826"]);
});

test("buildExportJobs drops unknown formats and duplicate formats", () => {
  const jobs = buildExportJobs([{ key: "a" }], ["csv", "bogus", "csv", "json"]);
  assert.deepEqual(jobs.map((j) => j.format), ["json", "csv"]);
});

test("buildExportJobs returns an empty list for no cards or no formats", () => {
  assert.deepEqual(buildExportJobs([], ["json"]), []);
  assert.deepEqual(buildExportJobs([{ key: "a" }], []), []);
});

test("deliveryMode stays on individual files at the threshold and zips above it", () => {
  assert.equal(ZIP_FILE_THRESHOLD, 20);
  assert.equal(deliveryMode(0), "files");
  assert.equal(deliveryMode(1), "files");
  assert.equal(deliveryMode(20), "files");
  assert.equal(deliveryMode(21), "zip");
  assert.equal(deliveryMode(295), "zip");
});

test("dedupeFilenames keeps unique names untouched", () => {
  assert.deepEqual(
    dedupeFilenames(["a_all_combos.json", "b_all_combos.json"]),
    ["a_all_combos.json", "b_all_combos.json"],
  );
  assert.deepEqual(dedupeFilenames([]), []);
});

test("dedupeFilenames suffixes repeat names _2, _3 before the extension", () => {
  assert.deepEqual(
    dedupeFilenames(["x.mbn", "x.mbn", "x.mbn"]),
    ["x.mbn", "x_2.mbn", "x_3.mbn"],
  );
});

test("dedupeFilenames handles corpus-style card export names colliding across images", () => {
  const first = "rf_config_1306_0_0_lteca.csv";
  assert.deepEqual(
    dedupeFilenames([first, first]),
    [first, "rf_config_1306_0_0_lteca_2.csv"],
  );
});

test("dedupeFilenames skips a suffix already claimed by a real file", () => {
  assert.deepEqual(
    dedupeFilenames(["a.txt", "a_2.txt", "a.txt"]),
    ["a.txt", "a_2.txt", "a_3.txt"],
  );
});

test("dedupeFilenames suffixes names without an extension at the end", () => {
  assert.deepEqual(dedupeFilenames(["noext", "noext"]), ["noext", "noext_2"]);
});

test("dedupeFilenames never returns duplicate names", () => {
  const names = ["x.json", "x_2.json", "x.json", "x.json", "x_2.json"];
  const out = dedupeFilenames(names);
  assert.equal(new Set(out).size, out.length);
  assert.equal(out.length, names.length);
});

test("decodeExportBytes keeps a UTF-8 BOM so CSV downloads stay byte-identical to Python utf-8-sig", () => {
  const bytes = new TextEncoder().encode("\uFEFFname,combo\r\nB1,1\r\n");
  const text = decodeExportBytes(bytes);
  assert.equal(text.codePointAt(0), 0xfeff);
  assert.equal(text, "\uFEFFname,combo\r\nB1,1\r\n");
  // And at the byte level: re-encoding the decoded text round-trips the BOM.
  assert.deepEqual([...new TextEncoder().encode(text)].slice(0, 3), [0xef, 0xbb, 0xbf]);
});

test("decodeExportBytes decodes plain UTF-8 without a BOM unchanged", () => {
  const bytes = new TextEncoder().encode("# Headerless Qualcomm DIAG payloads reconstructed from static RF tables.\n");
  assert.equal(
    decodeExportBytes(bytes),
    "# Headerless Qualcomm DIAG payloads reconstructed from static RF tables.\n",
  );
});

test("decodeExportBytes differs from the default TextDecoder, which strips the BOM", () => {
  const bytes = new TextEncoder().encode("\uFEFFa,b\r\n");
  assert.equal(new TextDecoder().decode(bytes).codePointAt(0), 0x61); // the bug
  assert.equal(decodeExportBytes(bytes).codePointAt(0), 0xfeff); // the fix
});
