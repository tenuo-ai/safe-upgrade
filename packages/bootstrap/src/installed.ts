/**
 * Which version of a dependency this repository actually uses.
 *
 * A manifest range is not an answer. `"ms": "^2.1.3"` says what is permitted, not what is
 * installed, and almost every real repository declares ranges rather than pins. The whole
 * research phase is about the difference between two concrete versions — what the registry
 * says about each, which exports one has and the other lacks, whether the gap is a major bump
 * — and none of those questions can be asked about a caret.
 *
 * So the lockfile decides, for the same reason it decides which package manager runs: it is
 * the file the manager itself obeys. When it cannot be read for the package in question, this
 * refuses instead of approximating. Guessing the low end of a range would produce findings
 * about a version the repository does not have, and a finding nobody can reproduce is worse
 * than no finding.
 *
 * Each parser here reads only the entry for one named package, and treats anything it does not
 * recognise as unknown rather than as absent.
 */

import { readFileSync } from "node:fs";
import type { PackageManager } from "@safe-upgrade/domain";

/** An exact version, or null when the lockfile does not answer for this package. */
export function resolveInstalledVersion(
  manager: PackageManager,
  lockfilePath: string,
  packageName: string,
): string | null {
  let content: string;
  try {
    content = readFileSync(lockfilePath, "utf8");
  } catch {
    return null;
  }

  switch (manager) {
    case "npm":
      return fromNpm(content, packageName);
    case "pnpm":
      return fromPnpm(content, packageName);
    case "yarn":
      return fromYarn(content, packageName);
  }
}

/** True for a bare exact version, the one specifier that needs no lockfile. */
export function isExactVersion(specifier: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(specifier);
}

/**
 * `package-lock.json`, both layouts.
 *
 * v2 and v3 key installed packages by path, and the root copy of a direct dependency is at
 * `node_modules/<name>`. A nested path is a different copy for some other dependent, so only
 * the root one is read. v1 keyed by name under `dependencies`.
 */
function fromNpm(content: string, packageName: string): string | null {
  let lock: unknown;
  try {
    lock = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof lock !== "object" || lock === null) {
    return null;
  }
  const root = lock as Record<string, unknown>;

  const byPath = asRecord(root["packages"])?.[`node_modules/${packageName}`];
  const fromPath = versionOf(byPath);
  if (fromPath !== null) {
    return fromPath;
  }

  return versionOf(asRecord(root["dependencies"])?.[packageName]);
}

/**
 * `pnpm-lock.yaml`.
 *
 * Read from `importers` rather than from `packages`: `importers` records what each workspace
 * project resolved, while `packages` lists every version in the store, including several of
 * the same package for different dependents. The root project is `.`.
 *
 * Indentation-scanned rather than parsed as YAML. The shape being read is three levels of
 * plain mappings, and the alternative is a YAML dependency whose own surface is larger than
 * this function.
 */
function fromPnpm(content: string, packageName: string): string | null {
  const lines = content.split("\n");
  let inImporters = false;
  let inRoot = false;
  let inBlock = false;
  let inPackage = false;

  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      inImporters = trimmed === "importers:";
      inRoot = false;
      inBlock = false;
      inPackage = false;
      continue;
    }
    if (!inImporters) {
      continue;
    }
    if (indent === 2) {
      // A project. Only the root project's resolutions describe this repository.
      inRoot = trimmed === ".:" || trimmed === "'.':";
      inBlock = false;
      inPackage = false;
      continue;
    }
    if (!inRoot) {
      continue;
    }
    if (indent === 4) {
      inBlock =
        trimmed === "dependencies:" ||
        trimmed === "devDependencies:" ||
        trimmed === "optionalDependencies:";
      inPackage = false;
      continue;
    }
    if (!inBlock) {
      continue;
    }
    if (indent === 6) {
      inPackage = unquote(trimmed.replace(/:$/, "")) === packageName;
      continue;
    }
    if (inPackage && indent === 8 && trimmed.startsWith("version:")) {
      return cleanPnpmVersion(unquote(trimmed.slice("version:".length).trim()));
    }
  }
  return null;
}

/**
 * A pnpm version can carry the peers it was resolved against, as in
 * `1.4.16(@langchain/core@1.2.11)`, and a workspace link is not a published version at all.
 */
function cleanPnpmVersion(value: string): string | null {
  if (value.startsWith("link:") || value.startsWith("file:")) {
    return null;
  }
  const version = value.split("(")[0]?.trim() ?? "";
  return isExactVersion(version) ? version : null;
}

/**
 * `yarn.lock`, classic and berry.
 *
 * Both are blocks headed by one or more `name@range` descriptors, so a block is this
 * package's when any of its descriptors names it. Berry writes `name@npm:range` and
 * `version: 1.2.3`; classic writes `name@range` and `version "1.2.3"`.
 *
 * A package can appear in several blocks when dependents disagree on a range. The first is
 * not necessarily the one the root project installed, so an ambiguous file is treated as
 * unanswered rather than resolved to a guess.
 */
function fromYarn(content: string, packageName: string): string | null {
  const found = new Set<string>();
  let inBlock = false;

  for (const line of content.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const isHeader = !line.startsWith(" ") && !line.startsWith("\t");
    if (isHeader) {
      inBlock = describesPackage(line, packageName);
      continue;
    }
    if (!inBlock) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith("version")) {
      continue;
    }
    const value = unquote(trimmed.replace(/^version\s*:?\s*/, "").trim());
    if (isExactVersion(value)) {
      found.add(value);
    }
    inBlock = false;
  }

  // Exactly one resolution, or nothing this function is willing to claim.
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/**
 * Whether a yarn block header lists this package as a published dependency.
 *
 * A descriptor's protocol matters. `probe@workspace:.` is the repository describing itself,
 * and its `0.0.0-use.local` is shaped exactly like a version, so a header check that looked
 * only at the name would hand back the project's own placeholder as a dependency's version.
 */
function describesPackage(header: string, packageName: string): boolean {
  const descriptors = header.replace(/:\s*$/, "").split(",");
  for (const descriptor of descriptors) {
    const text = unquote(descriptor.trim());
    // Split on the last `@` so a scoped name keeps its leading one.
    const at = text.lastIndexOf("@");
    if (at <= 0 || text.slice(0, at) !== packageName) {
      continue;
    }
    if (LOCAL_PROTOCOLS.some((protocol) => text.slice(at + 1).startsWith(protocol))) {
      continue;
    }
    return true;
  }
  return false;
}

/** Ranges that resolve to something on this disk rather than to a published version. */
const LOCAL_PROTOCOLS = ["workspace:", "link:", "portal:", "file:", "exec:"] as const;

function versionOf(entry: unknown): string | null {
  const version = asRecord(entry)?.["version"];
  return typeof version === "string" && isExactVersion(version) ? version : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}
