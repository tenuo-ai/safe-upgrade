"use strict";

const { splitProperty } = require("./prefix.js");
const { readDeclarations } = require("./declarations.js");

/** Which vendor prefixes a stylesheet uses, and on which properties. */
function summarize(css) {
  const prefixed = [];
  for (const declaration of readDeclarations(css)) {
    const split = splitProperty(declaration.property);
    if (split.prefix !== "") {
      prefixed.push({ ...split, value: declaration.value });
    }
  }
  return prefixed;
}

module.exports = { summarize, splitProperty, readDeclarations };
