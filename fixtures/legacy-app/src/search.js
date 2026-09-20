"use strict";

// First affected usage. `require` of escape-string-regexp stops working at 5.0.0,
// which is ESM-only.
const escapeStringRegexp = require("escape-string-regexp");

/** Find every line containing `term`, treating `term` as literal text. */
function findLines(haystack, term) {
  if (term === "") {
    return [];
  }
  const matcher = new RegExp(escapeStringRegexp(term), "i");
  return haystack.split("\n").filter((line) => matcher.test(line));
}

module.exports = { findLines };
