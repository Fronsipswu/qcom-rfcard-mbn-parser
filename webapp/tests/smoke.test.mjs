import { test } from "node:test";
import { deepEqualOrdered } from "./helpers.mjs";

test("smoke: runner works", () => {
  if (1 + 1 !== 2) throw new Error("math broke");
});

test("smoke: deepEqualOrdered passes on identical nested data", () => {
  deepEqualOrdered({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] });
});
