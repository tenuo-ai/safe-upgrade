/**
 * Where a dependency is actually used, and how it is loaded.
 *
 * Source text, not a module graph. A resolver would be more accurate but would
 * execute the repository's own configuration to find out, and this runs before
 * anything about the repository has been established as safe. What is needed here
 * is narrower than resolution anyway: which files name the package, and whether
 * they reach it with `require` or with `import`.
 */

export type LoadStyle = "require" | "import" | "dynamic_import";

export interface Usage {
  readonly file: string;
  readonly style: LoadStyle;
  readonly line: number;
  /** The matched line, bounded, for the finding to quote. */
  readonly excerpt: string;
}

/** Longest first, so `require` is not reported for a `await import` line twice. */
const PATTERNS: readonly { readonly style: LoadStyle; readonly build: (name: string) => RegExp }[] = [
  {
    style: "dynamic_import",
    build: (name) => new RegExp(String.raw`\bimport\s*\(\s*['"\`]${name}(?:/[^'"\`]*)?['"\`]`),
  },
  {
    style: "import",
    build: (name) => new RegExp(String.raw`\bfrom\s*['"\`]${name}(?:/[^'"\`]*)?['"\`]|\bimport\s*['"\`]${name}(?:/[^'"\`]*)?['"\`]`),
  },
  {
    style: "require",
    build: (name) => new RegExp(String.raw`\brequire\s*\(\s*['"\`]${name}(?:/[^'"\`]*)?['"\`]`),
  },
];

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Comments are stripped first. A package named in a comment is not a call site,
 * and counting it would put a file into `affectedFiles` that the implementer then
 * has to be authorized to write.
 */
export function findUsages(file: string, source: string, packageName: string): readonly Usage[] {
  const escaped = escapeForRegExp(packageName);
  const matchers = PATTERNS.map(({ style, build }) => ({ style, pattern: build(escaped) }));
  const usages: Usage[] = [];

  let inBlockComment = false;
  const lines = source.split("\n");
  for (const [index, raw] of lines.entries()) {
    const { text, stillInComment } = stripComments(raw, inBlockComment);
    inBlockComment = stillInComment;
    if (text.trim().length === 0) {
      continue;
    }
    for (const { style, pattern } of matchers) {
      if (pattern.test(text)) {
        usages.push({ file, style, line: index + 1, excerpt: raw.trim().slice(0, 240) });
        break;
      }
    }
  }
  return usages;
}

function stripComments(line: string, inBlockComment: boolean): { text: string; stillInComment: boolean } {
  let text = "";
  let inComment = inBlockComment;
  for (let index = 0; index < line.length; index += 1) {
    if (inComment) {
      if (line.startsWith("*/", index)) {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (line.startsWith("//", index)) {
      break;
    }
    if (line.startsWith("/*", index)) {
      inComment = true;
      index += 1;
      continue;
    }
    text += line[index];
  }
  return { text, stillInComment: inComment };
}

/** Extensions worth reading. Anything else cannot contain a JavaScript import. */
const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** A file whose purpose is to test, which only the test author may write. */
export function isTestFile(path: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|__tests__|spec)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}
