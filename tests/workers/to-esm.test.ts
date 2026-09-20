/**
 * The codemod's contract is mostly about what it refuses.
 *
 * A transform that converts most of a file produces something that imports cleanly
 * and behaves differently, which is the one outcome verification is least likely to
 * catch. So the tests that matter here are the ones asserting that an unrecognised
 * form stops the whole file.
 */

import { describe, expect, it } from "vitest";
import { convertToEsm } from "@safe-upgrade/workers";

function converted(source: string): string {
  const outcome = convertToEsm(source);
  if (outcome.kind !== "converted") {
    throw new Error(`expected a conversion, got ${outcome.kind}`);
  }
  return outcome.result.converted;
}

function refusals(source: string): readonly string[] {
  const outcome = convertToEsm(source);
  if (outcome.kind !== "refused") {
    throw new Error(`expected a refusal, got ${outcome.kind}`);
  }
  return outcome.refusals.map((refusal) => refusal.reason);
}

describe("forms it converts", () => {
  it("rewrites a default require", () => {
    expect(converted(`const esc = require("escape-string-regexp");\n`)).toBe(
      `import esc from "escape-string-regexp";\n`,
    );
  });

  it("rewrites a destructured require to a named import", () => {
    expect(converted(`const { a, b } = require("./x.js");\n`)).toBe(`import { a, b } from "./x.js";\n`);
  });

  it("keeps a renaming binding as written", () => {
    expect(converted(`const { a: b } = require("./x.js");\n`)).toBe(`import { a: b } from "./x.js";\n`);
  });

  it("rewrites a bare require to a side-effect import", () => {
    expect(converted(`require("./polyfill.js");\n`)).toBe(`import "./polyfill.js";\n`);
  });

  it("rewrites module.exports of an object to named exports", () => {
    expect(converted(`module.exports = { findLines, highlight };\n`)).toBe(
      `export { findLines, highlight };\n`,
    );
  });

  it("rewrites module.exports of a value to a default export", () => {
    expect(converted(`module.exports = handler;\n`)).toBe(`export default handler;\n`);
  });

  it("drops a redundant 'use strict', which an ES module does not need", () => {
    expect(converted(`"use strict";\n\nconst a = require("b");\n`)).toBe(`import a from "b";\n`);
  });

  it("preserves indentation so the diff shows only what moved", () => {
    expect(converted(`  const a = require("b");\n`)).toBe(`  import a from "b";\n`);
  });

  it("leaves a file with nothing to convert alone", () => {
    expect(convertToEsm(`export const a = 1;\n`).kind).toBe("unchanged");
  });
});

describe("forms it refuses, rather than guessing", () => {
  it("refuses a computed require, because the specifier is not knowable here", () => {
    expect(refusals(`const m = require(join(root, entry));\n`)[0]).toMatch(/does not recognise/);
  });

  it("refuses a conditional require", () => {
    expect(refusals(`if (flag) { require("./a.js"); }\n`)[0]).toMatch(/does not recognise/);
  });

  it("refuses assignment to exports, which has no single ESM equivalent", () => {
    expect(refusals(`exports.a = 1;\n`)[0]).toMatch(/assigns to `exports\.` directly/);
  });

  it("refuses __dirname, which needs a judgement about what the path meant", () => {
    expect(refusals(`const here = __dirname;\n`)[0]).toMatch(/import\.meta\.url/);
  });

  it("refuses require.resolve", () => {
    expect(refusals(`const p = require.resolve("x");\n`)[0]).toMatch(/does not exist in ESM/);
  });

  it("refuses a renaming module.exports rather than reordering the export", () => {
    expect(refusals(`module.exports = { public: internal };\n`)[0]).toMatch(
      /does not recognise/,
    );
  });

  it("writes nothing for a file that is mostly convertible", () => {
    // The whole file, or none of it. A file with one unrecognised line is exactly
    // the case where a partial conversion would look finished.
    const source = `const a = require("a");\nexports.b = a;\n`;
    expect(convertToEsm(source).kind).toBe("refused");
  });

  it("names the line, so the refusal can be acted on", () => {
    const outcome = convertToEsm(`const a = require("a");\n\nexports.b = a;\n`);
    if (outcome.kind !== "refused") {
      throw new Error("expected a refusal");
    }
    expect(outcome.refusals[0]?.line).toBe(3);
    expect(outcome.refusals[0]?.excerpt).toBe("exports.b = a;");
  });
});

describe("text that looks like code but is not", () => {
  it("ignores a require inside a line comment", () => {
    expect(convertToEsm(`// const a = require("a");\nexport const b = 1;\n`).kind).toBe("unchanged");
  });

  it("ignores a require inside a block comment", () => {
    expect(convertToEsm(`/*\nconst a = require("a");\n*/\nexport const b = 1;\n`).kind).toBe(
      "unchanged",
    );
  });

  it("ignores exports mentioned inside a string", () => {
    // Otherwise a log message about the word would refuse the whole file.
    expect(convertToEsm(`export const m = "set exports.foo to enable";\n`).kind).toBe("unchanged");
  });

  it("does not refuse a file for the word require in a template literal", () => {
    expect(convertToEsm("export const m = `use require() instead`;\n").kind).toBe("unchanged");
  });

  it("still sees code on a line that ends in a comment", () => {
    expect(converted(`const a = require("a"); // keep\n`)).toBe(`import a from "a";\n`);
  });
});
