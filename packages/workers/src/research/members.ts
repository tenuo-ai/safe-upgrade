/**
 * Which of a package's exports a file actually reaches.
 *
 * Knowing that `postcss.vendor` disappeared is only half a finding. The other half is
 * whether this repository touches it, and where — otherwise every major bump reports
 * every removed name and a reviewer has to work out which ones matter.
 *
 * This reads the two forms a CommonJS or ESM file uses to reach an export: a binding for
 * the whole module followed by a member access, and a destructured or named import. It
 * is text analysis, not a type checker, so it is wrong in one direction on purpose: it
 * reports what it can see and says nothing about what it cannot. A name reached through
 * a computed access, an alias assigned to a local variable, or a re-export is not found,
 * and callers have to treat "no reference found" as "none visible here".
 */

export interface MemberReference {
  readonly file: string;
  readonly member: string;
  readonly line: number;
  readonly excerpt: string;
}

/** How a file binds the package, if it does. */
interface Bindings {
  /** Local names bound to the whole module, as in `const postcss = require("postcss")`. */
  readonly whole: readonly string[];
  /** Exports pulled out by name, mapped from local name to exported name. */
  readonly named: ReadonlyMap<string, string>;
}

/**
 * Every reference in `source` to one of `members`, with the line it is on.
 *
 * `members` is the set worth looking for — normally the names a target version removed —
 * so a file mentioning an unrelated property is not reported.
 */
export function findMemberReferences(
  file: string,
  source: string,
  packageName: string,
  members: readonly string[],
): readonly MemberReference[] {
  if (members.length === 0) {
    return [];
  }
  // Bindings are read with string contents intact, because the package specifier is a
  // string. Uses are matched with them blanked, because a name inside a string literal is
  // not a use. Same source, two views.
  const declarations = withoutComments(source);
  const bindings = readBindings(declarations, packageName);
  if (bindings.whole.length === 0 && bindings.named.size === 0) {
    return [];
  }

  const wanted = new Set(members);
  const lines = blankStringBodies(declarations).split("\n");
  const declarationLines = lines.map((_, index) => bindsPackage(declarations.split("\n")[index] ?? "", packageName));
  const original = source.split("\n");
  const found: MemberReference[] = [];
  const seen = new Set<string>();

  for (const [index, line] of lines.entries()) {
    // The line that imports a name is not a place that uses it. It obviously has to change
    // too, which is why it is left out of the count rather than reported as a second site:
    // "reaches it in 2 places" should mean two uses, not one use and its import.
    for (const member of memberHits(line, bindings, wanted, declarationLines[index] === true)) {
      // One reference per member per line: `vendor.prefix(vendor.unprefixed(x))` is one
      // place a reviewer has to look at, not two.
      const key = `${String(index)}:${member}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push({
        file,
        member,
        line: index + 1,
        excerpt: (original[index] ?? line).trim().slice(0, 200),
      });
    }
  }
  return found;
}

function memberHits(
  line: string,
  bindings: Bindings,
  wanted: ReadonlySet<string>,
  isDeclaration: boolean,
): readonly string[] {
  const hits: string[] = [];

  for (const binding of bindings.whole) {
    const pattern = new RegExp(String.raw`\b${escapeForRegExp(binding)}\s*\.\s*([A-Za-z_$][\w$]*)`, "g");
    for (const match of line.matchAll(pattern)) {
      const member = match[1] ?? "";
      if (wanted.has(member)) {
        hits.push(member);
      }
    }
  }

  for (const [local, exported] of bindings.named) {
    if (!wanted.has(exported) || isDeclaration) {
      continue;
    }
    if (new RegExp(String.raw`\b${escapeForRegExp(local)}\b`).test(line)) {
      hits.push(exported);
    }
  }
  return hits;
}

/**
 * The local names this file binds the package to.
 *
 * Both module systems, because a file may be either, and the question — which exports
 * does this file reach — does not depend on how it loads them.
 */
export function readBindings(code: string, packageName: string): Bindings {
  const specifier = escapeForRegExp(packageName);
  const whole: string[] = [];
  const named = new Map<string, string>();

  const record = (clause: string): void => {
    const destructured = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (destructured === null) {
      const plain = /^[A-Za-z_$][\w$]*$/.exec(clause.trim());
      if (plain !== null) {
        whole.push(clause.trim());
      }
      return;
    }
    for (const entry of (destructured[1] ?? "").split(",")) {
      const renamed = /^\s*([A-Za-z_$][\w$]*)\s*(?::|\bas\b)\s*([A-Za-z_$][\w$]*)\s*$/.exec(entry);
      if (renamed !== null) {
        named.set(renamed[2] ?? "", renamed[1] ?? "");
        continue;
      }
      const direct = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(entry);
      if (direct !== null) {
        named.set(direct[1] ?? "", direct[1] ?? "");
      }
    }
  };

  // const x = require("pkg") / const { a, b: c } = require("pkg")
  for (const match of code.matchAll(
    new RegExp(
      String.raw`(?:const|let|var)\s+([\s\S]*?)\s*=\s*require\(\s*['"]${specifier}['"]\s*\)`,
      "g",
    ),
  )) {
    record(match[1] ?? "");
  }

  // import x from "pkg" / import { a as b } from "pkg" / import * as x from "pkg"
  for (const match of code.matchAll(
    new RegExp(String.raw`import\s+([\s\S]*?)\s+from\s*['"]${specifier}['"]`, "g"),
  )) {
    const clause = (match[1] ?? "").trim();
    const namespace = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (namespace !== null) {
      whole.push(namespace[1] ?? "");
      continue;
    }
    // `import postcss, { parse } from "postcss"` binds both.
    const [first, ...rest] = clause.split(/,(?=\s*\{)/);
    record(first ?? "");
    for (const part of rest) {
      record(part);
    }
  }

  return { whole, named };
}

/** Whether this line is where the package gets bound, rather than where it gets used. */
function bindsPackage(line: string, packageName: string): boolean {
  const specifier = escapeForRegExp(packageName);
  return new RegExp(String.raw`(?:require\(\s*|from\s*)['"]${specifier}['"]`).test(line);
}

/** Comments blanked, positions and line count preserved. */
function withoutComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

/** String contents blanked, quotes and positions kept, so a name in a literal is not a use. */
function blankStringBodies(source: string): string {
  return source.replace(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g, (_match, quote: string, body: string) =>
    `${quote}${body.replace(/[^\n]/g, " ")}${quote}`,
  );
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}
