// Unit tests for the main-thread pure viewer logic ported from viewer.py:
// apply_filter (:467-502 incl. the 5319687 re-sort-on-filter fix), the count
// label strings, _layout_columns' SCS visibility rule (:261) and TAB_DEFINITIONS.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAB_DEFINITIONS,
  EMPTY_COUNT_LABEL,
  filterRows,
  countLabelText,
  visibleColumns,
  infoBannerParts,
  memoBandColor,
  sortRows,
  compareKeys,
  bandSortKey,
  columnSortKey,
} from "../js/viewer.js";
import { bandColor } from "../js/lib/bandcolors.js";

// apply_filter joins str(v) for v in row.values() — VALUES only, no headers.
const ROWS = [
  { "LTE DL": "1A + 3A", "LTE MIMO DL": "2 + 2", "SCS DL (kHz)": "15" },
  { "LTE DL": "42E", "LTE MIMO DL": "4", "SCS DL (kHz)": "30 + 30" },
  { "LTE DL": "7A", "LTE MIMO DL": "2", "SCS DL (kHz)": "15" },
];
// casefolded row texts: "1a + 3a 2 + 2 15" / "42e 4 30 + 30" / "7a 2 15"
// nospace row texts:    "1a+3a2+215"        / "42e430+30"       / "7a215"

test("TAB_DEFINITIONS mirror viewer.py (label, table key) pairs", () => {
  assert.deepEqual(TAB_DEFINITIONS, [
    ["LTE", "lte_ca"],
    ["NRCA", "nr_ca"],
    ["ENDC", "endc"],
    ["NRDC", "nrdc"],
  ]);
});

test("EMPTY_COUNT_LABEL matches the no-tabs label (viewer.py:390)", () => {
  assert.equal(EMPTY_COUNT_LABEL, "0 combos");
});

test("filterRows: casefold substring match over joined row values", () => {
  assert.deepEqual(filterRows(ROWS, ""), ROWS); // no query -> all rows
  assert.deepEqual(filterRows(ROWS, "42e"), [ROWS[1]]); // case-insensitive
  assert.deepEqual(filterRows(ROWS, "  42E  "), [ROWS[1]]); // query stripped
  assert.deepEqual(filterRows(ROWS, "2 + 2"), [ROWS[0]]); // plain substring
  assert.deepEqual(filterRows(ROWS, "mimo"), []); // headers are not searched
  assert.deepEqual(filterRows(ROWS, "zzz"), []);
  assert.deepEqual(filterRows(ROWS, undefined), ROWS);
});

test("filterRows: nospace fallback matches across the collapsed join (viewer.py:479-484)", () => {
  // "1a+3a" only exists in the nospace form (plain has spaces around "+").
  assert.deepEqual(filterRows(ROWS, "1a+3a"), [ROWS[0]]);
  // "e430" spans the LTE DL / MIMO DL boundary of row 1.
  assert.deepEqual(filterRows(ROWS, "e430"), [ROWS[1]]);
  // Plain form still wins when it matches.
  assert.deepEqual(filterRows(ROWS, "1a + 3a"), [ROWS[0]]);
});

test("filterRows uses Python casefold, not toLowerCase", () => {
  const rows = [{ v: "Straße" }];
  assert.deepEqual(filterRows(rows, "STRASSE"), rows); // casefold(ß)=ss
  assert.deepEqual(filterRows(rows, "STRASSE").length, 1);
});

test("countLabelText reproduces viewer.py:497-502 exactly", () => {
  assert.equal(countLabelText("abc", 1234, 56789), "Showing 1,234 of 56,789 combos");
  assert.equal(countLabelText(" ", 1, 1515), "Total: 1,515 combos"); // whitespace-only = no query
  assert.equal(countLabelText("", 2855, 2855), "Total: 2,855 combos");
  assert.equal(countLabelText("x", 0, 0), "Showing 0 of 0 combos");
});

test("visibleColumns: SCS columns hidden unless Show SCS is checked (viewer.py:261)", () => {
  const columns = ["LTE DL", "LTE MIMO DL", "SCS DL (kHz)", "LTE UL", "NR SCS UL (kHz)", "BCS"];
  assert.deepEqual(visibleColumns(columns, false), ["LTE DL", "LTE MIMO DL", "LTE UL", "BCS"]);
  assert.deepEqual(visibleColumns(columns, true), columns);
  // Case-sensitive "SCS" substring, like the Python `in` check.
  assert.deepEqual(visibleColumns(["scs dl (khz)"], false), ["scs dl (khz)"]);
});

test("infoBannerParts mirrors viewer.py:183-197", () => {
  assert.deepEqual(
    infoBannerParts({ identity: "1426_0_0_0170", generation: "DAT/protobuf", size: 2048, inner_path: "/so/x.mbn" }),
    ["HWID_FSID_BID: 1426_0_0_0170", "Format: DAT/protobuf", "Size: 2.0 KB", "Path: /so/x.mbn"],
  );
  // Missing/empty fields are dropped; nothing at all falls back to the default.
  assert.deepEqual(infoBannerParts({}), []);
  assert.deepEqual(infoBannerParts({ identity: "", generation: "", size: 0, inner_path: "" }), []);
  assert.deepEqual(infoBannerParts(null), []);
  assert.deepEqual(infoBannerParts({ generation: "Legacy ELF" }), ["Format: Legacy ELF"]);
  assert.deepEqual(infoBannerParts({ size: 1536 }), ["Size: 1.5 KB"]);
});

test("memoBandColor caches bandColor results (viewer renders ~296 bands per card)", () => {
  assert.equal(memoBandColor("B3"), bandColor("B3"));
  assert.equal(memoBandColor("n78"), bandColor("n78"));
  // Second call must come from the cache: identical result, identical identity.
  assert.equal(memoBandColor("B3"), memoBandColor("B3"));
});

// --- sortRows (Rec-3: decorate-sort-undecorate must keep order identical) ---------

// Reference: the pre-refactor comparator implementation — key(a)/key(b) inside
// the comparator. sortRows must produce byte-identical order to this.
function sortRowsReference(rows, col, reverse = false) {
  const key = columnSortKey(col);
  return [...rows].sort(reverse ? (a, b) => compareKeys(key(b), key(a)) : (a, b) => compareKeys(key(a), key(b)));
}

const SORT_ROWS = [
  { "LTE DL": "1A + 3A", "LTE MIMO DL": "2 + 2" },
  { "LTE DL": "42E", "LTE MIMO DL": "4" },
  { "LTE DL": "7A", "LTE MIMO DL": "2" },
  { "LTE DL": "not-a-band", "LTE MIMO DL": "x" },
  { "LTE DL": "", "LTE MIMO DL": "10" },
  { "LTE DL": "3C + 28A", "LTE MIMO DL": "2 + 2" },
  { "LTE DL": "1A + 3A", "LTE MIMO DL": "2 + 2" }, // exact duplicate of row 0
];

test("sortRows keeps order identical to the per-comparison-key reference", () => {
  for (const col of ["LTE DL", "LTE MIMO DL"]) {
    for (const reverse of [false, true]) {
      assert.deepEqual(
        sortRows(SORT_ROWS, col, reverse),
        sortRowsReference(SORT_ROWS, col, reverse),
        `${col} reverse=${reverse}`,
      );
    }
  }
});

test("sortRows tie order follows input order (Python stable sort), both directions", () => {
  // Rows 0 and 6 share every key; rows 1 and 3 are non-band (kind 1) strings.
  const rows = [
    { c: "42E", n: "first" },
    { c: "7A", n: "mid" },
    { c: "42E", n: "second" },
    { c: "zz", n: "nonnumeric" },
    { c: "2A", n: "mid2" },
  ];
  assert.deepEqual(
    sortRows(rows, "c").map((r) => r.n),
    ["mid2", "first", "second", "mid", "nonnumeric"],
  );
  // reverse=True flips comparison, NOT tie order (viewer.py sort(reverse=True)).
  assert.deepEqual(
    sortRows(rows, "c", true).map((r) => r.n),
    ["nonnumeric", "mid", "first", "second", "mid2"],
  );
});

test("sortRows handles a 3,906-row band column (card 1426 shape) and completes", () => {
  const rows = [];
  for (let i = 0; i < 3906; i++) {
    const b1 = (i % 40) + 1;
    const b2 = (i % 45) + 1;
    rows.push({ "LTE DL": `${b1}A + ${b2}B`, "LTE MIMO DL": String((i % 4) + 2) });
  }
  const started = performance.now();
  const sorted = sortRows(rows, "LTE DL");
  const elapsed = performance.now() - started;
  assert.equal(sorted.length, 3906);
  assert.ok(elapsed < 1000, `sort should stay far under a second, took ${elapsed.toFixed(1)}ms`);
  // Spot-check ordering: band 1 before band 39 in ascending order.
  const firstBands = sorted.slice(0, 3).map((r) => r["LTE DL"]);
  assert.ok(firstBands.every((v) => v.startsWith("1A")), `smallest bands first, got ${firstBands.join(", ")}`);
});
