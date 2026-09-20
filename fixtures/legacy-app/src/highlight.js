"use strict";

// Second affected usage, deliberately left uncovered by the test suite.
const escapeStringRegexp = require("escape-string-regexp");

/** Wrap every literal occurrence of `term` in brackets. */
function highlight(text, term) {
  if (term === "") {
    return text;
  }
  const matcher = new RegExp(escapeStringRegexp(term), "gi");
  return text.replace(matcher, (found) => `[${found}]`);
}

module.exports = { highlight };
