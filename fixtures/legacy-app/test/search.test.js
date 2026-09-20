"use strict";

// Covers findLines only. highlight() has no test at all, which is the coverage
// gap the run is meant to notice.
const test = require("node:test");
const assert = require("node:assert/strict");
const { findLines } = require("../src/search.js");

test("findLines matches a plain term", () => {
  assert.deepEqual(findLines("alpha\nbeta\ngamma", "beta"), ["beta"]);
});

test("findLines treats regex metacharacters as literal text", () => {
  assert.deepEqual(findLines("cost is 3.50\ncost is 350", "3.50"), ["cost is 3.50"]);
});

test("findLines returns nothing for an empty term", () => {
  assert.deepEqual(findLines("alpha", ""), []);
});
