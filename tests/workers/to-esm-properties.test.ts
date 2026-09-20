/**
 * The codemod's property, checked against generated input rather than chosen examples.
 *
 * The claim the whole ESM migration rests on is narrow: for any CommonJS file, the transform
 * either refuses, or produces a file that is valid ES module syntax with no CommonJS left in its
 * code. A hand-written test can only assert that for the forms someone thought of, and the forms
 * nobody thinks of are exactly where a codemod does damage — it writes source that has to
 * compile, and a file that parses as neither module system fails every check afterwards with an
 * error about syntax rather than about the upgrade.
 *
 * Validity is judged by Node itself, through `node --check` on a `.mjs` file. A regular
 * expression asserting the output "looks like" ESM would be the same class of reasoning that
 * produced the output, so it could agree with a mistake.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertToEsm } from "@safe-upgrade/workers";

const scratch = mkdtempSync(join(tmpdir(), "esm-props-"));
let counter = 0;

/** Whether Node accepts this text, as a module or as a script. */
function parses(source: string, extension: "mjs" | "cjs"): { ok: boolean; error: string } {
  counter += 1;
  const file = join(scratch, `probe-${String(counter)}.${extension}`);
  writeFileSync(file, source);
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true, error: "" };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    return { ok: false, error: stderr.split("\n").slice(0, 4).join(" ") };
  }
}

const isValidModule = (source: string) => parses(source, "mjs");

/**
 * The generator combines fragments freely, so it sometimes declares the same name twice. That is
 * invalid before the transform touches it, and a transform is not answerable for input that
 * never parsed. Only files Node accepts as CommonJS carry the property.
 */
const isValidScript = (source: string) => parses(source, "cjs");

/**
 * Fragments of real CommonJS, each a line or small block.
 *
 * Deliberately a mix of what the transform handles, what it should refuse, and what it should
 * leave alone, so a generated file is usually a combination of all three.
 */
const FRAGMENTS: readonly string[] = [
  `const escape = require("escape-string-regexp");`,
  `const { join, resolve } = require("node:path");`,
  `const { readFile: read } = require("node:fs/promises");`,
  `let chalk = require('chalk');`,
  `var os = require("node:os");`,
  `const nested = require("pkg").sub;`,
  `const computed = require(nameFromSomewhere);`,
  `require("./side-effect");`,
  `module.exports = { one, two };`,
  `module.exports = function main() { return 1; };`,
  `module.exports.helper = helper;`,
  `exports.named = named;`,
  `exports = something;`,
  `const dir = __dirname;`,
  `const file = __filename;`,
  `function one() { return 1; }`,
  `const two = () => 2;`,
  `class Thing { run() { return escape("a"); } }`,
  `// require("commented-out");`,
  `/* module.exports = { fake: true }; */`,
  `const text = "module.exports is not code here";`,
  `const other = 'require("neither is this")';`,
  `const template = \`require(\${name})\`;`,
  `if (typeof require === "function") { load(); }`,
  `async function main() { const mod = await import("./x.js"); return mod; }`,
  `process.on("exit", () => {});`,
  ``,
  `  `,
  `const indented = require("indented-pkg");`,
  `const noSemi = require("no-semi")`,
  `const spaced   =   require(  "spaced"  )  ;`,
];

/**
 * Declarations for the names the fragments refer to.
 *
 * Without these, a generated file can export an identifier nothing declares. That is legal
 * CommonJS — `module.exports = { one }` with no `one` is a runtime error, not a parse error — but
 * `export { one }` with no `one` does not link, so the property would fail on input no real
 * repository contains. The point is to test the transform, not to rediscover that ESM checks its
 * export list.
 */
const PREAMBLE = [
  "const one = 1;",
  "const two = 2;",
  "const helper = () => 3;",
  "const named = 4;",
  "const something = 5;",
  "const name = \"pkg\";",
  "const x = 6;",
  "const nameFromSomewhere = \"pkg\";",
  "const load = () => 7;",
].join("\n");

/** A deterministic generator, so a failure can be reproduced from its seed. */
function pick(seed: number, count: number): string {
  let state = seed;
  const next = (): number => {
    // A small linear congruential step. Repeatable across runs and platforms.
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(FRAGMENTS[next() % FRAGMENTS.length] ?? "");
  }
  return `${PREAMBLE}\n${lines.join("\n")}\n`;
}

describe("for any generated CommonJS file", () => {
  it("either refuses, or produces something Node parses as a module", () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 400; seed += 1) {
      const source = pick(seed, 1 + (seed % 9));
      if (!isValidScript(source).ok) {
        continue;
      }
      const result = convertToEsm(source);
      if (result.kind === "refused") {
        continue;
      }
      const output = result.kind === "converted" ? result.result.converted : source;
      if (result.kind === "unchanged") {
        // Nothing was rewritten, so the file's validity is the repository's business and not
        // this transform's. Only converted output carries the claim.
        continue;
      }
      const verdict = isValidModule(output);
      if (!verdict.ok) {
        failures.push(`seed ${String(seed)}: ${verdict.error}\n--- input\n${source}--- output\n${output}`);
      }
    }

    expect(failures.join("\n\n")).toBe("");
  });

  it("leaves no CommonJS in the code it converted", () => {
    const failures: string[] = [];

    for (let seed = 1; seed <= 400; seed += 1) {
      const source = pick(seed, 1 + (seed % 9));
      const result = convertToEsm(source);
      if (result.kind !== "converted") {
        continue;
      }
      // Strings and comments may still mention these; only code matters, and the transform's
      // own rule is that a file it converts has no CommonJS call sites left in code.
      const code = stripStringsAndComments(result.result.converted);
      for (const marker of ["require(", "module.exports", "exports.", "__dirname", "__filename"]) {
        if (code.includes(marker)) {
          failures.push(`seed ${String(seed)}: '${marker}' survived\n${result.result.converted}`);
        }
      }
    }

    expect(failures.join("\n\n")).toBe("");
  });

  it("converts once, and then has nothing left to do", () => {
    // Idempotence. A transform that keeps finding work on its own output would loop, and the
    // implementer runs it on files it may have already touched.
    const failures: string[] = [];

    for (let seed = 1; seed <= 400; seed += 1) {
      const first = convertToEsm(pick(seed, 1 + (seed % 9)));
      if (first.kind !== "converted") {
        continue;
      }
      const second = convertToEsm(first.result.converted);
      if (second.kind === "converted" && second.result.converted !== first.result.converted) {
        failures.push(`seed ${String(seed)} changed again:\n${second.result.converted}`);
      }
    }

    expect(failures.join("\n\n")).toBe("");
  });

  it("never loses a line", () => {
    // The transform rewrites lines in place. A converted file with a different line count means
    // something was dropped or duplicated, which a reviewer reading the diff would have to
    // reconstruct.
    for (let seed = 1; seed <= 200; seed += 1) {
      const source = pick(seed, 1 + (seed % 9));
      const result = convertToEsm(source);
      if (result.kind === "converted") {
        expect(result.result.converted.split("\n"), `seed ${String(seed)}`).toHaveLength(
          source.split("\n").length,
        );
      }
    }
  });
});

describe("the forms it must not touch", () => {
  it("refuses a computed require, rather than inventing a specifier", () => {
    const result = convertToEsm(`const mod = require(chooseName());\n`);
    expect(result.kind).toBe("refused");
  });

  it("refuses the CommonJS-only globals, which have no import to become", () => {
    for (const source of [`const d = __dirname;\n`, `const f = __filename;\n`]) {
      expect(convertToEsm(source).kind, source).toBe("refused");
    }
  });

  it("does not read a mention inside a string or comment as code", () => {
    const source = [
      `const note = "module.exports = x";`,
      `// const old = require("legacy");`,
      `/* exports.thing = thing; */`,
      `const t = \`require(\${x})\`;`,
      "",
    ].join("\n");
    // Nothing here is a call site, so there is nothing to convert and nothing to refuse.
    expect(convertToEsm(source).kind).toBe("unchanged");
  });
});

/** Blank out string bodies and comments, so only code is examined. */
function stripStringsAndComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}
