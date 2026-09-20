/**
 * What a published version of a package exports.
 *
 * This is the only structural way to see an API change. A renamed or removed export is
 * invisible in a package manifest — postcss 7 and 8 both publish as CommonJS with the
 * same entry point and the same callable shape, and `postcss.vendor` is simply gone —
 * so comparing manifests cannot tell you anything, and the alternative is reading
 * release prose, which this system does not act on.
 *
 * Reading the surface means loading the package, and loading a package runs its
 * top-level code. That is third-party code execution and it is worth being plain about
 * it, so:
 *
 * - it happens in a scratch directory outside the run's worktree, installed with
 *   `--ignore-scripts`, so no lifecycle script runs;
 * - it happens in a child process with the run's usual bounds — no shell, an
 *   environment allowlist, an output cap, a timeout, and process-tree termination;
 * - the child prints a list of names and exits. It is handed no arguments, no paths
 *   from the repository, and nothing a worker chose;
 * - it is audited like any other tool call.
 *
 * The authority is not new in kind. The repository is about to depend on this exact
 * version, and the verifier already runs a clean install and the repository's own
 * scripts, which load it anyway. What changes is only that it happens earlier, for the
 * purpose of finding out what broke instead of discovering it from a stack trace.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionError } from "@safe-upgrade/domain";
import type { CommandSpec } from "@safe-upgrade/domain";
import { defineTool, type RawTool, type ToolContext } from "./context.ts";
import { runProcess } from "./process.ts";

export type ReadPackageExportsArgs = {
  readonly packageName: string;
  readonly version: string;
}

export interface PackageExports {
  readonly packageName: string;
  readonly version: string;
  /** Top-level names the package exports, sorted. Own enumerable keys only. */
  readonly names: readonly string[];
  /** Whether the export itself can be called or constructed. */
  readonly callable: boolean;
  /** Whether the surface could be read at all. */
  readonly observed: boolean;
  /** Why not, when it could not. Recorded rather than thrown: an unreadable surface is
   *  a limit on what the run can conclude, not a failure of the run. */
  readonly unreadable: string | null;
}

/** Names on every object, which say nothing about the package. */
const UNINTERESTING = new Set(["constructor", "__proto__", "prototype", "caller", "arguments"]);

const MAX_NAMES = 500;

/**
 * Printed by the child and parsed by the parent.
 *
 * Own enumerable keys of both the namespace and, when the export is a function, the
 * function object itself: a CommonJS package whose export is callable hangs its API off
 * that function, which is how `postcss.vendor` and `glob.sync` are reached.
 */
const PROBE = `
const target = process.argv[2];
let value;
try {
  value = require(target);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error && error.message).slice(0, 200) }));
  process.exit(0);
}
const names = new Set();
for (const key of Object.keys(value ?? {})) {
  names.add(key);
}
if (typeof value === "function") {
  for (const key of Object.getOwnPropertyNames(value)) {
    names.add(key);
  }
}
process.stdout.write(
  JSON.stringify({ names: [...names].sort(), callable: typeof value === "function" }),
);
`;

export function createSurfaceTools(context: ToolContext): {
  readonly readPackageExports: RawTool<ReadPackageExportsArgs, PackageExports>;
} {
  return {
    readPackageExports: defineTool<ReadPackageExportsArgs, PackageExports>(
      context,
      "read_package_exports",
      "Report the top-level export names of one published package version.",
      async (args) => {
        const unreadable = (reason: string): PackageExports => ({
          packageName: args.packageName,
          version: args.version,
          names: [],
          callable: false,
          observed: false,
          unreadable: reason,
        });

        const scratch = mkdtempSync(join(tmpdir(), `safe-upgrade-surface-${context.runId}-`));
        try {
          // A manifest with no dependencies of its own, so the install resolves exactly
          // the one package asked for and nothing is inherited from the worktree.
          writeFileSync(
            join(scratch, "package.json"),
            `${JSON.stringify({ name: "surface-probe", version: "0.0.0", private: true }, null, 2)}\n`,
          );

          const install = await runProcess(
            {
              executable: "npm",
              args: [
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--no-package-lock",
                `${args.packageName}@${args.version}`,
              ],
              cwd: scratch,
              purpose: "install",
              timeoutMs: context.limits.commandTimeoutMs,
            },
            context.limits,
            isolatedHome(scratch),
            { network: "allow", writableRoots: [scratch] },
          );
          if (install.exitCode !== 0) {
            return unreadable(`installing ${args.packageName}@${args.version} failed`);
          }

          writeFileSync(join(scratch, "probe.cjs"), PROBE);
          const probe = await runProcess(
            {
              executable: process.execPath,
              // The installed directory, not a specifier: resolution must not depend on
              // anything but what was just installed here.
              args: ["probe.cjs", join(scratch, "node_modules", args.packageName)],
              cwd: scratch,
              purpose: "lint",
              timeoutMs: Math.min(context.limits.commandTimeoutMs, 60_000),
            } satisfies CommandSpec,
            context.limits,
            isolatedHome(scratch),
            { network: "deny", writableRoots: [scratch] },
          );
          if (probe.exitCode !== 0) {
            return unreadable(`loading ${args.packageName}@${args.version} failed`);
          }

          return parseProbe(args, probe.stdout, unreadable);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    ),
  };
}

function parseProbe(
  args: ReadPackageExportsArgs,
  stdout: string,
  unreadable: (reason: string) => PackageExports,
): PackageExports {
  let parsed: { names?: unknown; callable?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(stdout.trim()) as typeof parsed;
  } catch {
    return unreadable(`the export surface of ${args.packageName}@${args.version} could not be read`);
  }
  if (typeof parsed.error === "string") {
    return unreadable(`${args.packageName}@${args.version} could not be loaded: ${parsed.error}`);
  }
  if (!Array.isArray(parsed.names)) {
    return unreadable(`the export surface of ${args.packageName}@${args.version} could not be read`);
  }
  if (parsed.names.length > MAX_NAMES) {
    // A surface this large is not something findings can be derived from, and it is not
    // worth carrying through state to say so.
    return unreadable(`${args.packageName}@${args.version} exports more names than can be compared`);
  }

  const names = parsed.names
    .filter((name): name is string => typeof name === "string")
    .filter((name) => !UNINTERESTING.has(name));
  if (names.length !== parsed.names.length && names.length === 0) {
    return unreadable(`${args.packageName}@${args.version} exports nothing nameable`);
  }
  return {
    packageName: args.packageName,
    version: args.version,
    names,
    callable: parsed.callable === true,
    observed: true,
    unreadable: null,
  };
}

/** Names present at `from` and absent at `to`. Empty when either could not be read. */
/**
 * A home directory of its own for the two processes that touch the published package.
 *
 * This is the one place in the system that deliberately executes third-party code, and the
 * default environment would have handed it the real `HOME`. That is where `~/.npmrc`,
 * `~/.gitconfig`, `~/.ssh`, and cloud credential files live, and a package that read one of
 * them on load could print it straight into output this run captures and writes to disk. The
 * scratch directory is removed with everything else in it when the probe finishes.
 *
 * The cost is a cold npm cache for this install, and that a private registry configured in the
 * user's `.npmrc` is not consulted. Both are acceptable: a published version's export list
 * should come from the public registry, and nothing about reading it needs a credential.
 */
function isolatedHome(scratch: string): Readonly<Record<string, string>> {
  return {
    HOME: scratch,
    // Windows resolves `~` through this one instead.
    USERPROFILE: scratch,
    npm_config_cache: join(scratch, ".npm"),
  };
}

export function removedNames(from: PackageExports, to: PackageExports): readonly string[] {
  if (!from.observed || !to.observed) {
    return [];
  }
  const present = new Set(to.names);
  return from.names.filter((name) => !present.has(name));
}

/** Names absent at `from` and present at `to`. Empty when either could not be read. */
export function addedNames(from: PackageExports, to: PackageExports): readonly string[] {
  if (!from.observed || !to.observed) {
    return [];
  }
  const present = new Set(from.names);
  return to.names.filter((name) => !present.has(name));
}

export function assertPackageSpec(args: ReadPackageExportsArgs): void {
  if (!/^[a-z0-9@][a-z0-9._@/-]*$/i.test(args.packageName)) {
    throw new ToolExecutionError(`not an acceptable package name: ${args.packageName}`);
  }
}
