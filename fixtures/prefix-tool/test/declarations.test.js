"use strict";

// Covers readDeclarations only. splitProperty — the usage that actually breaks at
// the target version — has no test, which is the coverage gap the run should notice.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readDeclarations } = require("../src/declarations.js");

test("readDeclarations returns every property and value", () => {
  assert.deepEqual(readDeclarations("a { color: red; -moz-tab-size: 4 }"), [
    { property: "color", value: "red" },
    { property: "-moz-tab-size", value: "4" },
  ]);
});

test("readDeclarations finds declarations inside nested rules", () => {
  assert.deepEqual(readDeclarations("@media print { a { color: blue } }"), [
    { property: "color", value: "blue" },
  ]);
});
