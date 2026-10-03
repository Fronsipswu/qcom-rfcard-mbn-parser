// Unit tests for the uecaps.hennes.xyz import helpers (pure logic only).
// DOM/fetch wiring lives in main.js and is verified by the suite + manual pass
// (no browser harness exists on this machine — established precedent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportEntries, resultUrl } from "../js/importparser.js";

const B0CD = "# rf_config_1426_0_0_0170.mbn [LTE] b0cd_v41\nPayload: 0011aa\n\n";
const B826 = "# rf_config_1426_0_0_0170.mbn [NR] b826_v22\nPayload: 0022bb\n\n";
const NAME = "rf_config_1426_0_0_0170.mbn";

test("buildImportEntries: both packet sets -> QLTE+QNR entries with dense indexes", () => {
  const { entries, files } = buildImportEntries(B0CD, B826, NAME);
  assert.deepEqual(entries, [
    { inputIndexes: [0], type: "QLTE", description: NAME },
    { inputIndexes: [1], type: "QNR", description: NAME },
  ]);
  assert.deepEqual(files, [
    { filename: `${NAME}.b0cd.txt`, text: B0CD },
    { filename: `${NAME}.b826.txt`, text: B826 },
  ]);
});

test("buildImportEntries: b0cd only -> single QLTE entry, index 0", () => {
  const { entries, files } = buildImportEntries(B0CD, "", NAME);
  assert.deepEqual(entries, [{ inputIndexes: [0], type: "QLTE", description: NAME }]);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, `${NAME}.b0cd.txt`);
});

test("buildImportEntries: b826 only -> single QNR entry, index 0 (dense)", () => {
  const { entries, files } = buildImportEntries("", B826, NAME);
  assert.deepEqual(entries, [{ inputIndexes: [0], type: "QNR", description: NAME }]);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, `${NAME}.b826.txt`);
});

test("buildImportEntries: whitespace-only text counts as empty", () => {
  const { entries } = buildImportEntries("   \n", B826, NAME);
  assert.deepEqual(entries, [{ inputIndexes: [0], type: "QNR", description: NAME }]);
});

test("buildImportEntries: both empty -> throws 'No DIAG packets to import'", () => {
  assert.throws(() => buildImportEntries("", "", NAME), /No DIAG packets to import/);
  assert.throws(() => buildImportEntries(undefined, null, NAME), /No DIAG packets to import/);
});

test("buildImportEntries: description passes through as-is", () => {
  const { entries } = buildImportEntries(B0CD, B826, "  keep  me.mbn ");
  assert.equal(entries[0].description, "  keep  me.mbn ");
  assert.equal(entries[1].description, "  keep  me.mbn ");
});

test("resultUrl: /view/multi/?id= with the id query-encoded", () => {
  assert.equal(
    resultUrl("550e8400-e29b-41d4-a716-446655440000"),
    "https://uecaps.hennes.xyz/view/multi/?id=550e8400-e29b-41d4-a716-446655440000"
  );
  assert.equal(resultUrl("a b&c"), "https://uecaps.hennes.xyz/view/multi/?id=a%20b%26c");
});
