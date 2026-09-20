/**
 * CommonJS to ES module conversion, for the forms it can prove.
 *
 * A source-to-source transform on text, not an AST rewrite, with a hard rule: if
 * anything in the file is not one of the recognised forms, nothing is written and
 * the file is reported as needing a person. The failure mode of a partial codemod
 * is a file that parses, imports cleanly, and is subtly wrong, which is the worst
 * possible outcome for a change whose entire purpose is to be verifiable.
 *
 * So the recognised set is small and the refusals are loud. `exports.foo = ...`,
 * conditional requires, `__dirname`, and `require.resolve` are all refused rather
 * than guessed at.
 */

export interface Conversion {
  readonly converted: string;
  /** Forms the transform recognised, for the audit record. */
  readonly applied: readonly string[];
}

export interface Refusal {
  readonly line: number;
  readonly reason: string;
  readonly excerpt: string;
}

export type ConversionResult =
  | { readonly kind: "converted"; readonly result: Conversion }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly refusals: readonly Refusal[] };

/** `const x = require("m");` */
const DEFAULT_IMPORT = /^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?\s*$/;

/** `const { a, b: c } = require("m");` */
const NAMED_IMPORT = /^(\s*)(?:const|let|var)\s+(\{[^}]*\})\s*=\s*require\(\s*(['"])([^'"]+)\3\s*\)\s*;?\s*$/;

/** `require("m");` for side effects only. */
const BARE_IMPORT = /^(\s*)require\(\s*(['"])([^'"]+)\2\s*\)\s*;?\s*$/;

/** `module.exports = { a, b };` */
const NAMED_EXPORT = /^(\s*)module\.exports\s*=\s*\{([^}]*)\}\s*;?\s*$/;

/** `module.exports = identifier;` */
const DEFAULT_EXPORT = /^(\s*)module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/;

const USE_STRICT = /^\s*(['"])use strict\1\s*;?\s*$/;

/**
 * Forms that must stop the conversion.
 *
 * `require` and `module.exports` appear here as a backstop: any occurrence the
 * line patterns above did not consume is, by definition, a form this transform does
 * not understand.
 */
const REFUSE: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /\bexports\s*\./, reason: "assigns to `exports.` directly, which has no single ESM equivalent" },
  { pattern: /\bmodule\.exports\b/, reason: "assigns `module.exports` in a form this transform does not recognise" },
  { pattern: /\brequire\.(?:resolve|cache|main)\b/, reason: "uses a `require` property that does not exist in ESM" },
  { pattern: /\b__dirname\b|\b__filename\b/, reason: "uses `__dirname` or `__filename`, which need `import.meta.url` and a judgement about what the path meant" },
  { pattern: /\brequire\s*\(/, reason: "calls `require` in a form this transform does not recognise, such as conditionally or with a computed path" },
  // Reached only for lines no rewrite above consumed. Left alone, `exports = x` survives into a
  // module as an assignment to a name nothing declares: valid syntax, no export, and a
  // ReferenceError at run time rather than a parse error anyone would notice in review.
  { pattern: /\bexports\s*=/, reason: "assigns to `exports` as a whole, which in a module is an undeclared variable rather than an export" },
];

export function convertToEsm(source: string): ConversionResult {
  const lines = source.split("\n");
  const output: string[] = [];
  const applied: string[] = [];
  const refusals: Refusal[] = [];
  let changed = false;

  let inBlockComment = false;
  for (const [index, line] of lines.entries()) {
    const { code, stillInComment } = codeOnly(line, inBlockComment);
    inBlockComment = stillInComment;

    // Comments and strings are left exactly as they are. A `require` inside a
    // comment is not a call site, and rewriting it would produce a diff a reviewer
    // has to read past.
    if (code.trim().length === 0) {
      output.push(line);
      continue;
    }

    const rewritten = rewrite(code, line);
    if (rewritten !== null) {
      output.push(rewritten.text);
      applied.push(rewritten.form);
      changed = true;
      continue;
    }

    if (USE_STRICT.test(code)) {
      // An ES module is always strict, so the directive is not just redundant, it is
      // a leftover that suggests the file was not really converted.
      applied.push("removed a redundant 'use strict'");
      changed = true;
      continue;
    }

    // Refusals are matched with string contents blanked out as well as comments.
    // Every refusal is about an identifier, never about a specifier, so a log message
    // mentioning `require()` is not a reason to refuse the file. The rewrites above
    // need the opposite, since a specifier is exactly what they carry across.
    const withoutStrings = blankStrings(code);
    for (const { pattern, reason } of REFUSE) {
      if (pattern.test(withoutStrings)) {
        refusals.push({ line: index + 1, reason, excerpt: line.trim().slice(0, 240) });
        break;
      }
    }
    output.push(line);
  }

  if (refusals.length > 0) {
    return { kind: "refused", refusals };
  }
  if (!changed) {
    return { kind: "unchanged" };
  }

  // Checked on the output, because nothing above has a view of the whole file.
  const duplicate = duplicateBinding(output);
  if (duplicate !== null) {
    return { kind: "refused", refusals: [duplicate] };
  }

  return { kind: "converted", result: { converted: trimLeadingBlanks(output).join("\n"), applied } };
}

/**
 * The property a line-by-line transform cannot check for itself.
 *
 * Two CommonJS forms are legal repeated and illegal once converted. `var os = require("os")`
 * twice is fine, because `var` redeclares; two `import os from "os"` is a duplicate declaration.
 * `module.exports = { a }` twice is fine, because the second assignment replaces the first; two
 * `export { a }` is a duplicate export. In both cases every line was converted correctly and the
 * file still does not load, so the check belongs here, over the result, rather than in any of the
 * rules that produced it.
 */
function duplicateBinding(lines: readonly string[]): Refusal | null {
  const declared = new Set<string>();
  const exported = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const at = (name: string, kind: "declare" | "export"): Refusal => ({
      line: index + 1,
      reason:
        kind === "declare"
          ? `would declare '${name}' twice, which CommonJS allows through \`var\` and a module rejects outright`
          : `would export '${name}' twice, which CommonJS allows by overwriting and a module rejects outright`,
      excerpt: line.trim().slice(0, 240),
    });

    for (const name of importedNames(line)) {
      if (declared.has(name)) {
        return at(name, "declare");
      }
      declared.add(name);
    }

    const names = exportedNames(line);
    if (/^\s*export\s+default\b/.test(line)) {
      names.push("default");
    }
    for (const name of names) {
      if (exported.has(name)) {
        return at(name, "export");
      }
      exported.add(name);
    }
  }
  return null;
}

/** The local names an `import` statement brings into scope. */
function importedNames(line: string): string[] {
  const clause = /^\s*import\s+(.+?)\s+from\s+['"]/.exec(line)?.[1];
  if (clause === undefined) {
    // `import "m"` declares nothing.
    return [];
  }
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced === null) {
    return [clause.trim()];
  }
  return (braced[1] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const renamed = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(part);
      return renamed?.[1] ?? part;
    });
}

/** The names an `export { ... }` clause introduces, after any `as`. */
function exportedNames(line: string): string[] {
  const inner = /^\s*export\s*\{([^}]*)\}/.exec(line)?.[1] ?? "";
  return inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const renamed = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(part);
      return renamed?.[1] ?? part;
    });
}

function rewrite(code: string, original: string): { readonly text: string; readonly form: string } | null {
  const named = NAMED_IMPORT.exec(code);
  if (named !== null) {
    const bindings = normalizeBindings(named[2] ?? "{}");
    // A pattern an import clause cannot express falls through to the refusal backstop below,
    // which still sees the `require` on this line.
    if (bindings !== null) {
      return {
        text: `${named[1] ?? ""}import ${bindings} from ${JSON.stringify(named[4] ?? "")};`,
        form: "named require to named import",
      };
    }
  }

  const singular = DEFAULT_IMPORT.exec(code);
  if (singular !== null) {
    return {
      text: `${singular[1] ?? ""}import ${singular[2] ?? ""} from ${JSON.stringify(singular[4] ?? "")};`,
      form: "require to default import",
    };
  }

  const bare = BARE_IMPORT.exec(code);
  if (bare !== null) {
    return {
      text: `${bare[1] ?? ""}import ${JSON.stringify(bare[3] ?? "")};`,
      form: "bare require to side-effect import",
    };
  }

  const namedExport = NAMED_EXPORT.exec(code);
  if (namedExport !== null) {
    const inner = (namedExport[2] ?? "").trim().replace(/,$/, "");
    // `module.exports = { a: b }` renames on export, which `export { b as a }` does
    // say, but the two are different enough that guessing is not appropriate here.
    if (inner.includes(":")) {
      return null;
    }
    const names = inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return {
      text: `${namedExport[1] ?? ""}export { ${names.join(", ")} };`,
      form: "module.exports object to named exports",
    };
  }

  const defaultExport = DEFAULT_EXPORT.exec(code);
  if (defaultExport !== null) {
    return {
      text: `${defaultExport[1] ?? ""}export default ${defaultExport[2] ?? ""};`,
      form: "module.exports value to default export",
    };
  }

  return null;
}

/**
 * Turn a destructuring pattern into an import clause.
 *
 * The two notations are not interchangeable, which is the whole reason this function exists.
 * Destructuring renames with a colon and importing renames with `as`, so carrying the pattern
 * across unchanged turned `const { readFile: read } = require(...)` into
 * `import { readFile: read } from ...` — not a different meaning but a syntax error, in a file
 * that then failed every check with a parse error rather than anything about the upgrade.
 *
 * Returns null for a pattern with no single answer. A default value or a nested pattern is
 * destructuring an object at runtime, and an import clause cannot express either, so the caller
 * refuses the line rather than approximating it.
 */
function normalizeBindings(bindings: string): string | null {
  const inner = bindings.replace(/^\{|\}$/g, "").trim();
  const parts = inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  const clauses: string[] = [];
  for (const part of parts) {
    const plain = /^([A-Za-z_$][\w$]*)$/.exec(part);
    if (plain !== null) {
      clauses.push(plain[1] ?? "");
      continue;
    }
    const renamed = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(part);
    if (renamed !== null) {
      clauses.push(`${renamed[1] ?? ""} as ${renamed[2] ?? ""}`);
      continue;
    }
    // A default (`{ a = 1 }`), a rest element, a nested pattern, or a computed key. Each is a
    // runtime operation on an object, and an import clause is not one.
    return null;
  }
  return `{ ${clauses.join(", ")} }`;
}

function trimLeadingBlanks(lines: readonly string[]): readonly string[] {
  let start = 0;
  while (start < lines.length && (lines[start] ?? "").trim().length === 0) {
    start += 1;
  }
  return lines.slice(start);
}

/**
 * Replace the contents of every string literal with spaces, keeping the quotes.
 *
 * Length-preserving, so a line's shape is unchanged and a reported excerpt still
 * lines up with the original.
 */
function blankStrings(line: string): string {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote !== null) {
      if (character === "\\") {
        output += "  ";
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = null;
        output += character;
        continue;
      }
      output += " ";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    }
    output += character;
  }
  return output;
}

/** The line with comments blanked out, string literals left intact. */
function codeOnly(line: string, inBlockComment: boolean): { code: string; stillInComment: boolean } {
  let code = "";
  let inComment = inBlockComment;
  let quote: string | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (inComment) {
      code += " ";
      if (line.startsWith("*/", index)) {
        code += " ";
        index += 1;
        inComment = false;
      }
      continue;
    }
    if (quote !== null) {
      code += character;
      if (character === "\\") {
        code += line[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (line.startsWith("//", index)) {
      code += " ".repeat(line.length - index);
      break;
    }
    if (line.startsWith("/*", index)) {
      inComment = true;
      code += "  ";
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    }
    code += character;
  }
  return { code, stillInComment: inComment };
}
