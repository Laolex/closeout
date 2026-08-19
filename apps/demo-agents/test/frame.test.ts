import assert from "node:assert/strict";
import { test } from "node:test";

import { renderFrame } from "../src/frame.ts";

const rows = [
  { label: "receipt amount", refused: "250000  ← one field", settled: "25000" },
  { label: "verdict", refused: "REFUSED", settled: "VERIFIED" },
];

test("the refused column is read first", () => {
  const frame = renderFrame("t", rows, []);
  // A reader who stops after three seconds should learn that this system
  // declines things. If SETTLED ever migrates left of REFUSED, the frame
  // is making the opposite argument.
  assert.ok(frame.indexOf("REFUSED") < frame.indexOf("SETTLED"));
});

test("both outcomes stay in one picture", () => {
  const frame = renderFrame("t", rows, ["footnote"]);
  for (const expected of ["250000", "25000", "REFUSED", "VERIFIED", "footnote"]) {
    assert.ok(frame.includes(expected), `frame is missing ${expected}`);
  }
});

test("columns line up regardless of the widest cell", () => {
  const wide = [{ label: "l", refused: "x".repeat(60), settled: "y" }];
  const frame = renderFrame("t", wide, []);
  const settledLine = frame.split("\n").find((l) => l.includes("y"))!;
  assert.ok(settledLine.indexOf("y") > 60, "the settled column must clear the refused column");
});
