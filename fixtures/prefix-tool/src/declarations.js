"use strict";

// A second usage of the same package that is *not* affected: `parse` exists at both
// versions. It is here so the run has to tell the two apart rather than treating
// every call site as broken.
const postcss = require("postcss");

/** Every declaration in a stylesheet, as property/value pairs. */
function readDeclarations(css) {
  const declarations = [];
  postcss.parse(css).walkDecls((declaration) => {
    declarations.push({ property: declaration.prop, value: declaration.value });
  });
  return declarations;
}

module.exports = { readDeclarations };
