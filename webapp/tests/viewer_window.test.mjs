// Unit tests for the mobile-only viewer windowing (stacked layout paints a
// prefix of the filtered rows and grows it on scroll) and the responsive
// parseCard lane (card opens bypass the scan-serialized chain while stacked).
// ComboViewer itself is DOM-coupled and not importable under node --test, so
// the wiring is pinned at source level (same approach as stacked.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOW_INITIAL_ROWS, WINDOW_CHUNK_ROWS } from "../js/viewer.js";
import { STACKED_MEDIA_QUERY } from "../js/splitter.js";

const webappDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const readWebappFile = (...parts) => readFile(join(webappDir, ...parts), "utf8");

test("window sizes: 500 initial rows, 300 per scroll append", () => {
  assert.equal(WINDOW_INITIAL_ROWS, 500);
  assert.equal(WINDOW_CHUNK_ROWS, 300);
});

test("viewer.js: desktop renders every filtered row, stacked renders the window prefix", async () => {
  const source = await readWebappFile("js", "viewer.js");
  assert.ok(
    source.includes("this.mobile ? Math.min(WINDOW_INITIAL_ROWS, state.filtered.length) : state.filtered.length"),
    "resetWindow must gate the painted count on this.mobile",
  );
  assert.ok(
    source.includes("for (let i = 0; i < this.windowShown; i++)"),
    "renderTable must paint only the windowed prefix",
  );
  assert.ok(source.includes("appendMoreRow("), "renderTable must mark a truncated result set");
  assert.ok(source.includes("appendWindowRows("), "scroll growth entry point must exist");
  assert.ok(
    source.includes('tr.classList.contains("cv-more")'),
    "the tail marker row must never enter the selection index space",
  );
  assert.ok(source.includes("setMobile("), "stacked transitions must retarget a live viewer");
  assert.ok(
    source.includes("if (this.mobile) this.tableWrapEl.scrollTop = 0;"),
    "filter/sort re-renders restart at the top while stacked",
  );
  assert.ok(
    source.includes("el.scrollHeight - 400"),
    "append trigger must fire near the scroll bottom",
  );
});

test("main.js: stacked layout selects windowing + fast parse lane, desktop stays on the old paths", async () => {
  const source = await readWebappFile("js", "main.js");
  assert.ok(
    source.includes("function isMobileLayout()") && source.includes("stackedMq && stackedMq.matches"),
    "the stacked media query is the single mobile signal",
  );
  assert.equal(source.split("{ mobile: isMobileLayout() }").length - 1, 1, "ComboViewer gets the mobile flag");
  assert.equal(source.split("fast: isMobileLayout()").length - 1, 2, "both parseCard posts (view + compare) get fast");
  assert.ok(
    source.includes("viewer.setMobile(stacked)"),
    "stacked transitions retarget the live viewer",
  );
  assert.equal(STACKED_MEDIA_QUERY, "(max-width: 768px) and (orientation: portrait)");
});

test("worker.js: fast parseCard replies on its own chain, desktop chain unchanged", async () => {
  const source = await readWebappFile("js", "worker.js");
  assert.ok(source.includes("let parseChain = Promise.resolve();"), "parallel parse lane exists");
  assert.ok(
    source.includes('msg.type === "parseCard" && msg.fast'),
    "only messages flagged fast take the responsive lane",
  );
});
