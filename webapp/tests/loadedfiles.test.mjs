// Unit tests for the loaded-file chips helper (webapp/js/loadedfiles.js): the
// chip row under the import bar renders one pill per distinct loaded source
// file, deduped by file name in first-appearance order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uniqueFileNames } from "../js/loadedfiles.js";

test("uniqueFileNames dedupes repeated names keeping first-appearance order", () => {
  assert.deepEqual(
    uniqueFileNames([
      "ximi18max_modemfirmware_a.img",
      "17uCNOS4beta.img",
      "ximi18max_modemfirmware_a.img",
    ]),
    ["ximi18max_modemfirmware_a.img", "17uCNOS4beta.img"],
  );
});

test("uniqueFileNames keeps first appearance even when repeats are non-adjacent", () => {
  assert.deepEqual(
    uniqueFileNames(["b.img", "a.img", "c.img", "a.img", "b.img"]),
    ["b.img", "a.img", "c.img"],
  );
});

test("uniqueFileNames handles empty and single inputs", () => {
  assert.deepEqual(uniqueFileNames([]), []);
  assert.deepEqual(uniqueFileNames(["only.img"]), ["only.img"]);
});

test("uniqueFileNames does not mutate its input", () => {
  const input = ["a.img", "a.img"];
  const out = uniqueFileNames(input);
  assert.deepEqual(input, ["a.img", "a.img"]);
  assert.deepEqual(out, ["a.img"]);
});
