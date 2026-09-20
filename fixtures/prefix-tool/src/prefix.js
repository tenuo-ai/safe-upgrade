"use strict";

// The affected usage. `postcss.vendor` exists in postcss 7 and is gone in 8.
// Nothing in either manifest says so: both publish as CommonJS with the same entry
// point and the same callable shape, so the break is visible only in what the
// package exports.
const postcss = require("postcss");

/** Split a possibly-prefixed property into its vendor prefix and bare name. */
function splitProperty(property) {
  return {
    prefix: postcss.vendor.prefix(property),
    name: postcss.vendor.unprefixed(property),
  };
}

module.exports = { splitProperty };
