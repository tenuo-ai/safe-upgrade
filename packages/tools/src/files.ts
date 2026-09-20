/**
 * File tools.
 *
 * Reads and writes are separate capabilities, and writes are split by file
 * class so that "may edit tests" and "may edit production code" are different
 * authorities rather than different arguments to one authority.
 *
 * Writes use optimistic concurrency: the caller states the hash it believes the
 * file currently has. A mismatch means someone else changed the file, and the
 * correct response is to replan rather than overwrite.
 */

import { openSync, closeSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ToolExecutionError } from "@safe-upgrade/domain";
import { sha256Hex } from "@safe-upgrade/evidence";
import { defineTool, type RawTool, type ToolContext } from "./context.ts";
import { classifyPath, requireClass, resolveInsideRoot, type FileClass } from "./paths.ts";

/**
 * Stand-in for "I expect this file not to exist yet". Tenuo constraints reject
 * null and omitted arguments, so absence has to be spelled out as a value.
 */
export const ABSENT = "absent";

export type ReadFileArgs = {
  readonly path: string;
}

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
  readonly fileClass: FileClass;
}

export type ListFilesArgs = {
  readonly root: string;
  /** Simple glob: `*` and `?` within a segment, `**` across segments. */
  readonly glob: string;
}

export type WriteFileArgs = {
  readonly path: string;
  readonly expectedBeforeHash: string;
  readonly content: string;
}

export interface WriteFileResult {
  readonly path: string;
  readonly beforeHash: string | null;
  readonly afterHash: string;
  readonly fileClass: FileClass;
}

function readIfPresent(path: string, maxBytes: number): { content: string; hash: string } | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    throw new ToolExecutionError(`not a regular file: ${path}`);
  }
  if (stat.size > maxBytes) {
    throw new ToolExecutionError(`file exceeds the ${maxBytes} byte read limit: ${path}`);
  }
  const content = readFileSync(path, "utf8");
  return { content, hash: sha256Hex(content) };
}

/**
 * Write through a temporary file in the same directory and rename, so a reader
 * never observes a half-written file and a failed write leaves the original.
 */
function writeAtomic(path: string, content: string): void {
  const temporary = join(dirname(path), `.safe-upgrade-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created.
    }
    throw error;
  }
  // Fail loudly if the rename did not land where we intended.
  const verify = readFileSync(path, "utf8");
  if (verify !== content) {
    throw new ToolExecutionError(`atomic write verification failed for ${path}`);
  }
}

function globToRegExp(glob: string): RegExp {
  if (glob.length === 0 || glob.length > 256) {
    throw new ToolExecutionError("glob must be between 1 and 256 characters");
  }
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
        continue;
      }
      pattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

function walk(root: string, limit: number): string[] {
  const found: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0 && found.length < limit) {
    const current = queue.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (classifyPath(rel) === "sensitive") {
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (entry.isFile()) {
        found.push(full);
        if (found.length >= limit) {
          break;
        }
      }
      // Symlinks are deliberately skipped: listing them invites a later write
      // through a link that points outside the tree.
    }
  }
  return found;
}

export function createFileTools(context: ToolContext): {
  readonly readFile: RawTool<ReadFileArgs, ReadFileResult>;
  readonly listFiles: RawTool<ListFilesArgs, readonly string[]>;
  readonly writeSourceFile: RawTool<WriteFileArgs, WriteFileResult>;
  readonly writeTestFile: RawTool<WriteFileArgs, WriteFileResult>;
  readonly writeCiFile: RawTool<WriteFileArgs, WriteFileResult>;
} {
  const write = (name: string, allowed: readonly FileClass[]) =>
    defineTool<WriteFileArgs, WriteFileResult>(
      context,
      name,
      `Write a ${allowed.join("/")} file with optimistic concurrency.`,
      async (args) => {
        const resolved = resolveInsideRoot(context.paths, args.path);
        requireClass(resolved, allowed);
        if (args.content.length > context.limits.maxFileBytes) {
          throw new ToolExecutionError(`content exceeds the ${context.limits.maxFileBytes} byte write limit`);
        }

        const existing = readIfPresent(resolved.absolute, context.limits.maxFileBytes);
        const beforeHash = existing?.hash ?? null;
        const expected = args.expectedBeforeHash;
        if (expected === ABSENT) {
          if (existing !== null) {
            throw new ToolExecutionError(`${resolved.relative} already exists but the caller expected it to be absent`);
          }
        } else if (beforeHash === null) {
          throw new ToolExecutionError(`${resolved.relative} does not exist; pass expectedBeforeHash "${ABSENT}" to create it`);
        } else if (expected !== beforeHash) {
          throw new ToolExecutionError(
            `${resolved.relative} changed since it was read; replan instead of overwriting`,
          );
        }

        if (existing === null) {
          // The directory may not exist yet. A repository with no `.github/workflows` is
          // ordinary, and the path has already been resolved inside the worktree and checked
          // against this tool's file class, so the only thing missing is the directory itself.
          // Without this the run died on a raw ENOENT naming a temporary worktree.
          mkdirSync(dirname(resolved.absolute), { recursive: true });
          // Create the file exclusively first so a symlink planted between the
          // resolve above and the write cannot be followed.
          closeSync(openSync(resolved.absolute, "wx", 0o600));
        }
        writeAtomic(resolved.absolute, args.content);
        return {
          path: resolved.relative,
          beforeHash,
          afterHash: sha256Hex(args.content),
          fileClass: resolved.fileClass,
        };
      },
    );

  return {
    readFile: defineTool<ReadFileArgs, ReadFileResult>(
      context,
      "read_file",
      "Read a UTF-8 file inside the worktree.",
      async (args) => {
        const resolved = resolveInsideRoot(context.paths, args.path);
        const existing = readIfPresent(resolved.absolute, context.limits.maxFileBytes);
        if (existing === null) {
          throw new ToolExecutionError(`no such file: ${resolved.relative}`);
        }
        return {
          path: resolved.relative,
          content: existing.content,
          hash: existing.hash,
          fileClass: resolved.fileClass,
        };
      },
    ),

    listFiles: defineTool<ListFilesArgs, readonly string[]>(
      context,
      "list_files",
      "List files under a directory that match a simple glob. Returns absolute paths.",
      async (args) => {
        const resolved = resolveInsideRoot(context.paths, args.root);
        const matcher = globToRegExp(args.glob);
        // Absolute, because every path *argument* in this package is absolute:
        // `read_file` rejects a relative path outright, and the capability that
        // bounds it is `under(worktreeRoot)`, which a relative path cannot satisfy.
        // Returning worktree-relative paths here made the obvious next call fail and
        // left each caller rebuilding the prefix by hand. The glob is still matched
        // against the relative path, so a pattern stays readable.
        return walk(resolved.absolute, 20_000)
          .map((file) => ({ file, rel: relative(context.paths.realRoot, file).split(sep).join("/") }))
          .filter(({ rel }) => matcher.test(rel))
          .map(({ file }) => file)
          .sort();
      },
    ),

    // Manifests and lockfiles are deliberately excluded: they change through
    // `update_manifest` and the package manager, not through a text write.
    writeSourceFile: write("write_source_file", ["source"]),
    writeTestFile: write("write_test_file", ["test"]),
    writeCiFile: write("write_ci_file", ["ci"]),
  };
}
