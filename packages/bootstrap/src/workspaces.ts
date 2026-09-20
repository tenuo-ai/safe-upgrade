/**
 * Workspace directories the package manager would treat as packages.
 *
 * Detection used to skip every glob, which made ordinary monorepos (`packages/*`)
 * invisible. Expanding here is conservative on purpose: `*` and `**` only, no
 * `?` or brace sets, only directories that already have a `package.json`, and a
 * hard cap so a malicious workspace list cannot turn detection into a walk of
 * the whole disk.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { RepositoryError } from "@safe-upgrade/domain";

const MAX_WORKSPACES = 80;
const MAX_WALK_DEPTH = 6;

export interface WorkspaceExpansion {
  readonly roots: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Turn declared workspace patterns into repository-relative directories.
 *
 * Literal entries are used as-is. Globs that this expander does not implement
 * are reported rather than guessed, so a monorepo is never half-handled in
 * silence.
 */
export function expandWorkspacePatterns(root: string, patterns: readonly string[]): WorkspaceExpansion {
  const found: string[] = [];
  const warnings: string[] = [];

  for (const pattern of patterns) {
    if (pattern.split(/[/\\]/).includes("..")) {
      throw new RepositoryError(`workspace '${pattern}' resolves outside the repository`);
    }
    const normalized = normalizeWorkspacePath(pattern);
    if (normalized === null) {
      warnings.push(`workspace pattern '${pattern}' is not a path this run will expand`);
      continue;
    }
    if (normalized.includes("?") || normalized.includes("{") || normalized.includes("[")) {
      warnings.push(`workspace pattern '${pattern}' uses a form that is not expanded`);
      continue;
    }
    if (!normalized.includes("*")) {
      const candidate = join(root, normalized);
      if (!isInside(root, candidate)) {
        throw new RepositoryError(`workspace '${pattern}' resolves outside the repository`);
      }
      if (existsSync(join(candidate, "package.json"))) {
        found.push(normalized);
      }
      continue;
    }

    const matches = matchGlob(root, normalized);
    if (matches.length === 0) {
      warnings.push(`workspace glob '${pattern}' matched no package.json directories`);
    }
    found.push(...matches);
  }

  const unique = [...new Set(found)].sort();
  if (unique.length > MAX_WORKSPACES) {
    warnings.push(
      `workspace expansion found ${String(unique.length)} packages and kept the first ${String(MAX_WORKSPACES)}`,
    );
    return { roots: unique.slice(0, MAX_WORKSPACES), warnings };
  }
  return { roots: unique, warnings };
}

/**
 * A workspace the command line or a Dependabot title named, resolved against
 * the directories detection found.
 *
 * Accepts a path (`packages/app`) or a workspace package name (`@acme/app`).
 * Empty means the repository root.
 */
export function resolveWorkspaceSelection(
  requested: string,
  roots: readonly string[],
  names: Readonly<Record<string, string>>,
): string {
  if (requested === "") {
    return "";
  }
  const normalized = normalizeWorkspacePath(requested);
  if (normalized === null) {
    throw new RepositoryError(`workspace '${requested}' is not a path this run will use`);
  }
  if (roots.includes(normalized)) {
    return normalized;
  }
  const byName = names[requested] ?? names[normalized];
  if (byName !== undefined && roots.includes(byName)) {
    return byName;
  }
  throw new RepositoryError(
    `workspace '${requested}' is not one of this repository's workspace packages` +
      (roots.length > 0 ? ` (${roots.join(", ")})` : ""),
  );
}

/**
 * Strip a leading `./` or `/` and refuse `..`.
 *
 * Dependabot writes `in /packages/app`. The command line accepts the same, or
 * `packages/app`, or `./packages/app`. All of those are one path.
 */
export function normalizeWorkspacePath(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed === "" || trimmed === "." || trimmed === "./" || trimmed === "/") {
    return "";
  }
  const withoutDot = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const withoutSlash = withoutDot.startsWith("/") ? withoutDot.slice(1) : withoutDot;
  if (withoutSlash === "" || withoutSlash.split("/").includes("..") || withoutSlash.includes("\0")) {
    return null;
  }
  return withoutSlash.replace(/\/+$/, "");
}

function matchGlob(root: string, pattern: string): string[] {
  const parts = pattern.split("/").filter((part) => part.length > 0 && part !== ".");
  return walk(root, root, parts, 0);
}

function walk(root: string, absolute: string, parts: readonly string[], index: number): string[] {
  const rel = relative(root, absolute);
  const depth = rel === "" ? 0 : rel.split(sep).length;
  if (depth > MAX_WALK_DEPTH) {
    return [];
  }

  if (index >= parts.length) {
    return existsSync(join(absolute, "package.json")) && rel.length > 0 ? [rel.split(sep).join("/")] : [];
  }

  const part = parts[index] ?? "";
  if (part === "**") {
    const out: string[] = [];
    out.push(...walk(root, absolute, parts, index + 1));
    for (const child of listDirectories(absolute)) {
      out.push(...walk(root, join(absolute, child), parts, index));
      out.push(...walk(root, join(absolute, child), parts, index + 1));
    }
    return out;
  }
  if (part === "*") {
    const out: string[] = [];
    for (const child of listDirectories(absolute)) {
      out.push(...walk(root, join(absolute, child), parts, index + 1));
    }
    return out;
  }

  const next = join(absolute, part);
  if (!isInside(root, next) || !existsSync(next)) {
    return [];
  }
  return walk(root, next, parts, index + 1);
}

function listDirectories(absolute: string): readonly string[] {
  if (!existsSync(absolute)) {
    return [];
  }
  try {
    return readdirSync(absolute)
      .filter((name) => name !== "node_modules" && name !== ".git" && !name.startsWith("."))
      .filter((name) => {
        try {
          return statSync(join(absolute, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep));
}
