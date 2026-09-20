/**
 * Which exports a file reaches.
 *
 * The cases that matter are the negative ones: this analysis decides whether a removed
 * export gets reported against a file, so a false positive sends a reviewer to code that
 * is fine, and a false negative lets a break through. It reads text rather than types, so
 * the tests below fix what it does see and, just as deliberately, what it does not.
 */

import { describe, expect, it } from "vitest";
import { findMemberReferences, readBindings } from "@safe-upgrade/workers";

const removed = ["vendor", "list"];

function refs(source: string, members: readonly string[] = removed) {
  return findMemberReferences("src/a.js", source, "postcss", members);
}

describe("reaching an export through a whole-module binding", () => {
  it("finds a member access and reports the line it is on", () => {
    const found = refs(['const postcss = require("postcss");', "", "postcss.vendor.prefix(x);"].join("\n"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ member: "vendor", line: 3, file: "src/a.js" });
    expect(found[0]?.excerpt).toBe("postcss.vendor.prefix(x);");
  });

  it("reports one reference per member per line", () => {
    // Two uses in one expression are one place a reviewer has to look at.
    const found = refs(['const postcss = require("postcss");', "postcss.vendor.prefix(postcss.vendor.unprefixed(x));"].join("\n"));
    expect(found).toHaveLength(1);
  });

  it("reports each distinct member separately", () => {
    const found = refs(['const postcss = require("postcss");', "postcss.vendor; postcss.list;"].join("\n"));
    expect(found.map((reference) => reference.member).sort()).toEqual(["list", "vendor"]);
  });

  it("follows the local name, not the package name", () => {
    const found = refs(['const pc = require("postcss");', "pc.vendor.prefix(x);"].join("\n"));
    expect(found.map((reference) => reference.member)).toEqual(["vendor"]);
  });

  it("ignores a member of the same name on an unrelated object", () => {
    const found = refs(['const postcss = require("postcss");', "const config = { vendor: 1 };", "config.vendor;"].join("\n"));
    expect(found).toHaveLength(0);
  });

  it("ignores a file that never loads the package", () => {
    expect(refs("other.vendor.prefix(x);")).toHaveLength(0);
  });

  it("says nothing when no name was removed", () => {
    expect(refs('const postcss = require("postcss");\npostcss.vendor;', [])).toHaveLength(0);
  });
});

describe("reaching an export by name", () => {
  it("finds a destructured export", () => {
    const found = refs('const { vendor } = require("postcss");\nvendor.prefix(x);');
    expect(found.map((reference) => reference.member)).toEqual(["vendor"]);
  });

  it("finds one renamed on the way in, and reports the exported name", () => {
    const found = refs('const { vendor: v } = require("postcss");\nv.prefix(x);');
    expect(found.map((reference) => reference.member)).toEqual(["vendor"]);
    // The finding is about postcss.vendor, not about whatever this file called it.
    expect(found[0]?.member).toBe("vendor");
  });

  it("finds a named import and a namespace import alike", () => {
    expect(refs('import { vendor } from "postcss";\nvendor.prefix(x);')).toHaveLength(1);
    expect(refs('import * as postcss from "postcss";\npostcss.vendor;')).toHaveLength(1);
  });

  it("finds a member reached through a default import alongside named ones", () => {
    const found = refs('import postcss, { parse } from "postcss";\npostcss.vendor;');
    expect(found.map((reference) => reference.member)).toEqual(["vendor"]);
  });
});

describe("what it deliberately does not see", () => {
  it("ignores a mention in a comment", () => {
    const found = refs(['const postcss = require("postcss");', "// postcss.vendor is gone", "/* postcss.vendor */"].join("\n"));
    expect(found).toHaveLength(0);
  });

  it("ignores a mention inside a string", () => {
    const found = refs('const postcss = require("postcss");\nconst message = "postcss.vendor";');
    expect(found).toHaveLength(0);
  });

  it("does not resolve an alias assigned to a local variable", () => {
    // A known limit, fixed here so that it is a decision rather than a surprise: callers
    // have to read "no reference found" as "none visible", not as "none".
    const found = refs('const postcss = require("postcss");\nconst v = postcss["ven" + "dor"];\nv.prefix(x);');
    expect(found).toHaveLength(0);
  });
});

describe("reading the bindings themselves", () => {
  it("separates whole-module bindings from named ones", () => {
    const bindings = readBindings('const postcss = require("postcss");\nconst { parse, vendor: v } = require("postcss");', "postcss");
    expect(bindings.whole).toEqual(["postcss"]);
    expect([...bindings.named.entries()].sort()).toEqual([
      ["parse", "parse"],
      ["v", "vendor"],
    ]);
  });

  it("does not confuse one package with another whose name is a prefix", () => {
    const bindings = readBindings('const selector = require("postcss-selector-parser");', "postcss");
    expect(bindings.whole).toEqual([]);
    expect(bindings.named.size).toBe(0);
  });
});
