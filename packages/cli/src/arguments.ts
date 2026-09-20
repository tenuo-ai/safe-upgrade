/**
 * Turning a command line into a run, spec criterion 1 and section 18.
 *
 * Hand-written rather than delegated to an argument parser. The surface is a dozen flags,
 * and a tool whose purpose is to bound what an upgrade may do should not add a dependency
 * to read its own arguments.
 *
 * Two rules shape everything here.
 *
 * The target version is exact. A range is a request to resolve a version later, and every
 * claim this system makes is about one version it read the manifest of: "verified against
 * `^8.0.0`" would be a claim about whatever the registry serves next week.
 *
 * No secret is a flag. Spec 18 requires secrets to arrive through runtime configuration,
 * and a token in `argv` is a token in shell history, in `ps` output, and in the CI log that
 * echoed the command. Tokens are read from the environment, and the parser rejects a flag
 * that looks like one rather than silently ignoring it.
 */

import { isAbsolute, resolve } from "node:path";
import type { ElevationGrant } from "@safe-upgrade/domain";

export interface ParsedArguments {
  readonly repositoryPath: string;
  readonly packageName: string;
  readonly targetVersion: string;
  readonly runId: string | undefined;
  readonly artifactsDirectory: string | undefined;
  readonly approvals: readonly ElevationGrant[];
  readonly publishApproved: boolean;
  readonly createDraftPullRequest: boolean;
  readonly githubRepository: string | undefined;
  readonly allowTransitive: boolean;
  readonly partialAllowed: boolean;
  readonly format: "markdown" | "json";
}

export class UsageError extends Error {}

/** An exact version. Not a range, not a tag, not a partial. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** npm's own rules, narrowed: no uppercase, no leading dot or underscore. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const GITHUB_REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** Flags that would put a credential in argv, refused by name so the refusal is legible. */
const SECRET_FLAGS = new Set([
  "--github-token",
  "--token",
  "--api-key",
  "--typesafe-api-key",
  "--holder-secret",
  "--warrant",
]);

const TAKES_VALUE = new Set([
  "--repository",
  "--artifacts",
  "--run-id",
  "--approve",
  "--approved-by",
  "--github-repository",
  "--format",
]);

export function parseArguments(argv: readonly string[], now: () => Date = () => new Date()): ParsedArguments {
  const values = new Map<string, string>();
  const approveIds: string[] = [];
  const flags = new Set<string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    // `--flag=value` and `--flag value` both, because both get typed.
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);

    if (SECRET_FLAGS.has(name)) {
      throw new UsageError(
        `${name} is not accepted as a flag, because an argument ends up in shell history and in process listings. Set it in the environment instead.`,
      );
    }
    if (!TAKES_VALUE.has(name) && !KNOWN_FLAGS.has(name)) {
      throw new UsageError(`unknown option ${name}`);
    }
    if (!TAKES_VALUE.has(name)) {
      if (equals !== -1) {
        throw new UsageError(`${name} takes no value`);
      }
      flags.add(name);
      continue;
    }

    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (value === undefined || (equals === -1 && value.startsWith("-"))) {
      throw new UsageError(`${name} needs a value`);
    }
    if (equals === -1) {
      index += 1;
    }
    if (name === "--approve") {
      approveIds.push(value);
    } else {
      values.set(name, value);
    }
  }

  if (positional.length === 0) {
    throw new UsageError("name the package to upgrade, as name@version");
  }
  if (positional.length > 1) {
    throw new UsageError(
      `one package per run, and ${String(positional.length)} were given. A run establishes a claim about one upgrade.`,
    );
  }

  const { packageName, targetVersion } = parseSpecifier(positional[0] ?? "");
  const approvals = buildApprovals(approveIds, values.get("--approved-by"), now);

  const githubRepository = values.get("--github-repository");
  if (githubRepository !== undefined && !GITHUB_REPOSITORY.test(githubRepository)) {
    throw new UsageError(`--github-repository must be owner/name, not ${githubRepository}`);
  }

  const format = values.get("--format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new UsageError(`--format must be markdown or json, not ${format}`);
  }

  const artifacts = values.get("--artifacts");
  return {
    repositoryPath: resolve(values.get("--repository") ?? process.cwd()),
    packageName,
    targetVersion,
    runId: values.get("--run-id"),
    artifactsDirectory: artifacts === undefined ? undefined : resolve(artifacts),
    approvals,
    publishApproved: flags.has("--publish"),
    // Asking to push implies wanting the draft it pushes for; the reverse is not true.
    createDraftPullRequest: flags.has("--draft-pr") || flags.has("--publish"),
    githubRepository,
    allowTransitive: flags.has("--allow-transitive"),
    partialAllowed: flags.has("--partial-allowed"),
    format,
  };
}

const KNOWN_FLAGS = new Set([
  "--publish",
  "--draft-pr",
  "--allow-transitive",
  "--partial-allowed",
  "--help",
  "-h",
  "--version",
]);

export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv.length === 0;
}

export function wantsVersion(argv: readonly string[]): boolean {
  return argv.includes("--version");
}

function parseSpecifier(specifier: string): { packageName: string; targetVersion: string } {
  // From the last `@` so that a scoped name keeps its own.
  const separator = specifier.lastIndexOf("@");
  if (separator <= 0) {
    throw new UsageError(
      `name the package as name@version, with an exact version. Got ${specifier || "nothing"}.`,
    );
  }
  const packageName = specifier.slice(0, separator);
  const targetVersion = specifier.slice(separator + 1);

  if (!PACKAGE_NAME.test(packageName)) {
    throw new UsageError(`not a package name: ${packageName}`);
  }
  if (!EXACT_VERSION.test(targetVersion)) {
    throw new UsageError(
      `${targetVersion} is not an exact version. A range or a tag resolves to whatever the registry serves at the time, and every claim this run makes is about one version it read.`,
    );
  }
  return { packageName, targetVersion };
}

/**
 * Approvals, each naming one call a previous run asked about by id.
 *
 * `--approved-by` is required rather than defaulted to the current user: an approval is a
 * statement about who decided, and inferring it from `$USER` would record the account that
 * happened to run the command as though it had agreed to something.
 */
function buildApprovals(
  ids: readonly string[],
  approvedBy: string | undefined,
  now: () => Date,
): readonly ElevationGrant[] {
  if (ids.length === 0) {
    if (approvedBy !== undefined) {
      throw new UsageError("--approved-by was given with nothing to approve");
    }
    return [];
  }
  if (approvedBy === undefined || approvedBy.trim() === "") {
    throw new UsageError("--approve needs --approved-by, naming who approved it");
  }
  const approvedAt = now().toISOString();
  return ids.map((id) => ({ id, approvedBy: approvedBy.trim(), approvedAt }));
}

export function relativeToCwd(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}
