// Unit tests for the workbench splitter's pure clamp/persist logic
// (webapp/js/splitter.js). DOM wiring lives in main.js and is verified in the
// browser; these tests pin the math: min 320px, max = container - 420px
// (viewer keeps a usable minimum), min wins on tiny containers, and stored
// widths are clamped to the current container on restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_CARD_PANE_PX,
  VIEWER_MIN_PX,
  SPLITTER_STORAGE_KEY,
  clampSplitterWidth,
  maxCardPaneWidth,
  parseStoredWidth,
} from "../js/splitter.js";

test("constants: card pane min 320px, viewer keeps 420px, storage key", () => {
  assert.equal(MIN_CARD_PANE_PX, 320);
  assert.equal(VIEWER_MIN_PX, 420);
  assert.equal(SPLITTER_STORAGE_KEY, "rfcards.splitter.width");
});

test("maxCardPaneWidth: container minus viewer minimum, floor at the card min", () => {
  assert.equal(maxCardPaneWidth(2000), 1580);
  assert.equal(maxCardPaneWidth(740), 320); // exactly min + 420
  assert.equal(maxCardPaneWidth(700), 320); // below min + 420 -> floor
});

test("clampSplitterWidth passes through in-range widths (bounds inclusive)", () => {
  assert.equal(clampSplitterWidth(800, 2000), 800);
  assert.equal(clampSplitterWidth(320, 2000), 320); // exactly min
  assert.equal(clampSplitterWidth(1580, 2000), 1580); // exactly max
});

test("clampSplitterWidth clamps widths below min up to 320", () => {
  assert.equal(clampSplitterWidth(0, 2000), 320);
  assert.equal(clampSplitterWidth(100, 2000), 320);
  assert.equal(clampSplitterWidth(-50, 2000), 320);
});

test("clampSplitterWidth clamps widths above max down to container-420", () => {
  assert.equal(clampSplitterWidth(5000, 2000), 1580);
  assert.equal(clampSplitterWidth(1581, 2000), 1580);
});

test("clampSplitterWidth: container smaller than min+420 -> min wins", () => {
  assert.equal(clampSplitterWidth(600, 700), 320);
  assert.equal(clampSplitterWidth(600, 739), 320);
  assert.equal(clampSplitterWidth(600, 740), 320); // max == min at the boundary
  assert.equal(clampSplitterWidth(600, 741), 321); // first container px past it
});

test("parseStoredWidth returns null for absent/corrupt entries (default 44% stays)", () => {
  assert.equal(parseStoredWidth(null, 2000), null);
  assert.equal(parseStoredWidth(undefined, 2000), null);
  assert.equal(parseStoredWidth("", 2000), null);
  assert.equal(parseStoredWidth("  ", 2000), null);
  assert.equal(parseStoredWidth("abc", 2000), null);
  assert.equal(parseStoredWidth("NaN", 2000), null);
});

test("parseStoredWidth clamps valid stored widths to the current container", () => {
  assert.equal(parseStoredWidth("800", 2000), 800);
  assert.equal(parseStoredWidth("100", 2000), 320); // window shrank below min
  assert.equal(parseStoredWidth("5000", 2000), 1580); // window shrank below max
  assert.equal(parseStoredWidth("900", 700), 320); // tiny container
});
