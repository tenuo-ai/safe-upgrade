/**
 * Path safety and file classification.
 *
 * Tenuo's `under()` constraint is a path-algebra check on the string it is
 * given, so it cannot see through a symlink. That makes the realpath checks
 * here load-bearing rather than redundant: the capability decides which root a
 * worker may touch, and this module makes sure the path really lives there.
 *
 * Classification is deterministic and derived only from the path. A worker
 * cannot relabel `src/index.ts` as a test by passing a different argument.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ToolExecutionError } from "@safe-upgrade/domain";

export type FileClass = "source" | "test" | "ci" | "manifest" | "lockfile" | "sensitive";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRECTORY = /(^|[\\/])(__tests__|__mocks__|tests?|fixtures)([\\/]|$)/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const WORKFLOW_FILE = /\.ya?ml$/;

const MANIFEST_NAMES: ReadonlySet<string> = new Set(["package.json"]);
const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
]);

/**
 * Paths no worker may read or write, whatever its capabilities say. Secrets and
 * repository internals are excluded here so that a capability scoped to the
 * worktree root does not transitively grant them.
 */
const SENSITIVE_SEGMENT: ReadonlySet<string> = new Set([".git", ".ssh", ".gnupg", "node_modules"]);
const SENSITIVE_FILE = /^(\.env($|\..*)|\.npmrc|\.netrc|\.pgpass|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keystore))$/i;

export interface PathContext {
  /** Canonical, symlink-resolved worktree root. */
  readonly realRoot: string;
}

export function createPathContext(root: string): PathContext {
  if (!isAbsolute(root)) {
    throw new ToolExecutionError(`worktree root must be absolute: ${root}`);
  }
  return { realRoot: realpathSync(root) };
}

function segments(relativePath: string): string[] {
  return relativePath.split(sep).filter((part) => part.length > 0);
}

/** True when `candidate` is the root itself or strictly inside it. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve the closest existing ancestor through symlinks. A path that does not
 * exist yet still has to land inside the root once its parent is resolved,
 * which is how we stop a write through a symlinked directory.
 */
function realAncestor(path: string): string {
  let current = path;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new ToolExecutionError(`cannot resolve any ancestor of ${path}`);
      }
      current = parent;
    }
  }
}

export interface ResolvedPath {
  /** Absolute path to operate on, with the root's real prefix. */
  readonly absolute: string;
  /** Path relative to the worktree root, using forward slashes. */
  readonly relative: string;
  readonly fileClass: FileClass;
}

/**
 * Canonicalize an absolute path and confirm it stays inside the worktree.
 * Throws for traversal, symlink escapes, and sensitive locations.
 */
export function resolveInsideRoot(context: PathContext, candidate: string): ResolvedPath {
  if (!isAbsolute(candidate)) {
    throw new ToolExecutionError(`path must be absolute: ${candidate}`);
  }
  if (candidate.includes("\0")) {
    throw new ToolExecutionError("path must not contain a null byte");
  }

  const normalized = resolve(candidate);
  if (!isInside(context.realRoot, normalized)) {
    throw new ToolExecutionError(`path escapes the worktree root: ${candidate}`);
  }

  // The path may not exist yet, so resolve the deepest ancestor that does and
  // re-append the remainder. Either the target or its parent chain is a symlink
  // out of the tree, and this catches both.
  const existing = realAncestor(normalized);
  if (!isInside(context.realRoot, existing)) {
    throw new ToolExecutionError(`path resolves outside the worktree root: ${candidate}`);
  }
  const tail = relative(existing, normalized);
  const absolute = tail.length === 0 ? existing : resolve(existing, tail);
  if (!isInside(context.realRoot, absolute)) {
    throw new ToolExecutionError(`path resolves outside the worktree root: ${candidate}`);
  }

  const rel = relative(context.realRoot, absolute);
  const fileClass = classifyPath(rel);
  if (fileClass === "sensitive") {
    throw new ToolExecutionError(`path is in a protected location: ${rel}`);
  }
  return { absolute, relative: rel.split(sep).join("/"), fileClass };
}

/**
 * Classify a repository-relative path. Order matters: sensitive wins over
 * everything, then CI, then tests, so that a workflow file under a `tests/`
 * directory is still treated as CI.
 */
export function classifyPath(relativePath: string): FileClass {
  const parts = segments(relativePath);
  const name = parts.at(-1) ?? "";

  if (parts.some((part) => SENSITIVE_SEGMENT.has(part)) || SENSITIVE_FILE.test(name)) {
    return "sensitive";
  }
  if (parts[0] === ".github" && parts[1] === "workflows" && WORKFLOW_FILE.test(name)) {
    return "ci";
  }
  if (LOCKFILE_NAMES.has(name)) {
    return "lockfile";
  }
  if (MANIFEST_NAMES.has(name)) {
    return "manifest";
  }
  if (TEST_FILE.test(name) || TEST_DIRECTORY.test(relativePath)) {
    return "test";
  }
  if (SOURCE_FILE.test(name)) {
    return "source";
  }
  return "source";
}

/** Reject a resolved path whose class is not one the tool is allowed to write. */
export function requireClass(resolved: ResolvedPath, allowed: readonly FileClass[]): void {
  if (!allowed.includes(resolved.fileClass)) {
    throw new ToolExecutionError(
      `${resolved.relative} is classified as ${resolved.fileClass}; this tool may only write ${allowed.join(", ")}`,
    );
  }
}
