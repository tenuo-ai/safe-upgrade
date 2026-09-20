/**
 * Repository detection.
 *
 * Every value here is read out of the repository under inspection, which means
 * every value here is attacker-influenced in the threat model that matters: a
 * dependency upgrade is exactly the situation where the repository content may
 * not be entirely trusted. So detection is written to fail rather than guess.
 *
 * The rule throughout is that a declaration in a manifest is a claim, not a
 * fact. The lockfile on disk decides which package manager runs, because that is
 * the file the manager itself will obey. A `packageManager` field that disagrees
 * with the lockfile is a contradiction and stops the run, rather than being
 * resolved in either direction.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { PackageResolutionError, RepositoryError } from "@safe-upgrade/domain";
import { isExactVersion, resolveInstalledVersion } from "./installed.ts";
import type {
  CheckPurpose,
  CommandSpec,
  PackageManager,
  RepositoryFacts,
} from "@safe-upgrade/domain";
import { assertSafeScriptName, screenScript } from "@safe-upgrade/tools";

/** Lockfile to manager. The file present on disk is what the manager obeys. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

const CHECK_PURPOSES: readonly CheckPurpose[] = ["test", "typecheck", "lint", "build"];

/** Conventional script name per purpose. Only these are ever run as a check. */
const CONVENTIONAL: Readonly<Record<string, string>> = {
  test: "test",
  typecheck: "typecheck",
  lint: "lint",
  build: "build",
};

const MAX_MANIFEST_BYTES = 2_000_000;

export interface DetectionRequest {
  /** Canonical worktree path from `isolateRepository`. */
  readonly worktreePath: string;
  readonly defaultBranch: string;
  /** The one package this run may touch. */
  readonly packageName: string;
  readonly commandTimeoutMs: number;
}

export interface Detection {
  readonly facts: RepositoryFacts;
  /**
   * Checks the repository does not define, or defines in a form we refuse to
   * run. Not failures: a repository with no lint script simply has no lint gate,
   * and the run says so rather than inventing one.
   */
  readonly absentChecks: readonly CheckPurpose[];
  /** Script name to use per detected check, for `run_check`. */
  readonly checkScripts: Readonly<Partial<Record<CheckPurpose, string>>>;
  /** Facts worth reporting that do not stop the run. */
  readonly warnings: readonly string[];
}

export function detectRepositoryFacts(request: DetectionRequest): Detection {
  const root = request.worktreePath;
  const warnings: string[] = [];

  const { manager, lockfile } = detectPackageManager(root);
  const manifest = readManifest(join(root, "package.json"));
  assertManagerAgreement(manifest, manager, lockfile);
  assertLockfileWritable(root, manager);

  const declaredRange = resolveDeclaredVersion(manifest, request.packageName);
  const currentVersion = resolveCurrentVersion(
    manager,
    join(root, lockfile),
    request.packageName,
    declaredRange,
  );
  const workspaceRoots = detectWorkspaces(root, manager, manifest, warnings);
  const manifests = [
    "package.json",
    ...workspaceRoots.map((directory) => join(directory, "package.json")),
  ].filter((candidate) => existsSync(join(root, candidate)));

  const { commands, scripts, absent } = planChecks(manifest, manager, root, request.commandTimeoutMs, warnings);

  const facts: RepositoryFacts = {
    worktreePath: root,
    defaultBranch: request.defaultBranch,
    packageManager: manager,
    workspaceRoots,
    manifests,
    lockfile,
    currentVersion,
    declaredRange,
    verificationCommands: [installCommand(manager, root, request.commandTimeoutMs), ...commands],
    existingCiFiles: detectCiFiles(root),
  };

  return { facts, absentChecks: absent, checkScripts: scripts, warnings };
}

/**
 * Exactly one lockfile, or the run stops.
 *
 * Two lockfiles is not a preference to be resolved; it means two managers
 * disagree about the dependency graph, and a "frozen" install would be frozen
 * against whichever one we happened to pick. No lockfile means there is nothing
 * to freeze against, so the clean install the verifier depends on cannot be
 * performed at all.
 */
function detectPackageManager(root: string): { manager: PackageManager; lockfile: string } {
  const present = LOCKFILES.filter(([file]) => existsSync(join(root, file)));
  if (present.length === 0) {
    throw new RepositoryError(
      // Not the path: detection runs inside a temporary worktree, and naming it sent readers
      // looking for a directory that no longer exists instead of at their own repository.
      `this repository has no lockfile, and a reproducible install needs one of ${LOCKFILES.map(([file]) => file).join(", ")}. Run an install and commit the result.`,
    );
  }
  if (present.length > 1) {
    throw new RepositoryError(
      `more than one lockfile present (${present.map(([file]) => file).join(", ")}), so the package manager is ambiguous`,
    );
  }
  const [entry] = present;
  if (entry === undefined) {
    throw new RepositoryError("lockfile detection produced no result");
  }
  const [lockfile, manager] = entry;
  return { manager, lockfile };
}

interface Manifest {
  readonly scripts: Readonly<Record<string, unknown>>;
  readonly dependencies: Readonly<Record<string, unknown>>;
  readonly devDependencies: Readonly<Record<string, unknown>>;
  readonly optionalDependencies: Readonly<Record<string, unknown>>;
  readonly packageManager: unknown;
  readonly workspaces: unknown;
}

function readManifest(path: string): Manifest {
  let raw: string;
  try {
    const size = statSync(path).size;
    if (size > MAX_MANIFEST_BYTES) {
      throw new RepositoryError(`package.json is implausibly large (${String(size)} bytes)`);
    }
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if (cause instanceof RepositoryError) {
      throw cause;
    }
    throw new RepositoryError(`cannot read ${path}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new RepositoryError(`${path} is not valid JSON`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RepositoryError(`${path} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  return {
    scripts: asRecord(record["scripts"]),
    dependencies: asRecord(record["dependencies"]),
    devDependencies: asRecord(record["devDependencies"]),
    optionalDependencies: asRecord(record["optionalDependencies"]),
    packageManager: record["packageManager"],
    workspaces: record["workspaces"],
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/**
 * A `packageManager` field that names a different manager than the lockfile is a
 * contradiction, and neither side wins. Picking the field would let a manifest
 * edit redirect which executable the run spawns; picking the lockfile silently
 * would leave a repository whose own declared tooling we are ignoring.
 */
function assertManagerAgreement(manifest: Manifest, manager: PackageManager, lockfile: string): void {
  const declared = manifest.packageManager;
  if (declared === undefined) {
    return;
  }
  if (typeof declared !== "string") {
    throw new RepositoryError("packageManager must be a string when present");
  }
  const [name] = declared.split("@");
  if (name === undefined || name.length === 0) {
    throw new RepositoryError(`packageManager is not in name@version form: ${declared}`);
  }
  if (name !== manager) {
    throw new RepositoryError(
      `packageManager declares ${name} but the lockfile is ${lockfile}, which ${manager} owns`,
    );
  }
}

/**
 * The requested package must be a direct dependency, declared at an exact
 * version. A range would make "the version we upgraded from" a matter of when
 * the install ran rather than what the repository says.
 */
/**
 * Refuse a repository that has told npm never to write a lockfile.
 *
 * `package-lock=false` in `.npmrc` is a common choice — `express`, `chalk`, and `execa` all
 * make it — and it is incompatible with everything this run depends on. The dependency move
 * updates `package.json` and npm silently leaves the lockfile alone, so the frozen install
 * that follows fails with a complaint about the two being out of sync, several minutes into a
 * run, with a message about integrity hashes rather than about configuration.
 *
 * Checked here instead, where it costs nothing and can be explained. This run will not write a
 * lockfile the repository has asked not to have, and it will not verify against an install it
 * cannot reproduce, so there is nothing left to do but say so.
 */
function assertLockfileWritable(root: string, manager: PackageManager): void {
  if (manager !== "npm") {
    return;
  }
  let content: string;
  try {
    content = readFileSync(join(root, ".npmrc"), "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const text = line.trim();
    if (text.startsWith("#") || text.startsWith(";")) {
      continue;
    }
    const [key, value] = text.split("=", 2);
    if (key?.trim() !== "package-lock") {
      continue;
    }
    if (value?.trim() === "false") {
      throw new RepositoryError(
        "this repository's .npmrc sets package-lock=false, so npm will not record the dependency move in the lockfile and the frozen install this run verifies against cannot be reproduced. Remove that setting, or run against a checkout that keeps a lockfile.",
      );
    }
  }
}

/**
 * The version the repository has now.
 *
 * An exact specifier answers for itself. Anything else — a caret, a tilde, a range, a tag —
 * is a statement about what would be acceptable, and only the lockfile knows which of those
 * was chosen. A lockfile that does not answer stops the run: research compares two concrete
 * versions, and inventing the first one would produce findings about code that is not here.
 */
function resolveCurrentVersion(
  manager: PackageManager,
  lockfilePath: string,
  packageName: string,
  declaredRange: string,
): string {
  if (isExactVersion(declaredRange)) {
    return declaredRange;
  }
  const installed = resolveInstalledVersion(manager, lockfilePath, packageName);
  if (installed === null) {
    throw new PackageResolutionError(
      `${packageName} is declared as '${declaredRange}', and ${basename(lockfilePath)} does not say which version that resolved to. ` +
        `This run compares two exact versions, so it will not guess the first one. Reinstall to refresh the lockfile, or pin ${packageName} to an exact version.`,
    );
  }
  return installed;
}

function resolveDeclaredVersion(manifest: Manifest, packageName: string): string {
  const sources: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ["dependencies", manifest.dependencies],
    ["devDependencies", manifest.devDependencies],
    ["optionalDependencies", manifest.optionalDependencies],
  ];
  const found = sources.filter(([, block]) => packageName in block);
  if (found.length === 0) {
    throw new PackageResolutionError(
      `${packageName} is not a direct dependency of this repository`,
    );
  }
  if (found.length > 1) {
    throw new PackageResolutionError(
      `${packageName} is declared in more than one place (${found.map(([name]) => name).join(", ")})`,
    );
  }
  const [entry] = found;
  const block = entry?.[1];
  const declared = block?.[packageName];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new PackageResolutionError(`${packageName} has no version specifier`);
  }
  return declared;
}

/**
 * Workspace directories, read from whichever file the manager uses.
 *
 * Globs are not expanded. A workspace glob decides which directories the run may
 * write to, and expanding it here means matching the manager's glob semantics
 * exactly or being quietly wrong. Literal entries are used and globs are
 * reported, so a monorepo is visibly out of scope instead of half handled.
 */
function detectWorkspaces(
  root: string,
  manager: PackageManager,
  manifest: Manifest,
  warnings: string[],
): readonly string[] {
  const declared =
    manager === "pnpm" ? readPnpmWorkspaces(root, warnings) : readManifestWorkspaces(manifest);

  const literal: string[] = [];
  for (const entry of declared) {
    if (entry.includes("*") || entry.includes("?")) {
      warnings.push(`workspace glob '${entry}' was not expanded, so its packages are out of scope`);
      continue;
    }
    const candidate = join(root, entry);
    if (!isInside(root, candidate)) {
      throw new RepositoryError(`workspace '${entry}' resolves outside the repository`);
    }
    if (existsSync(join(candidate, "package.json"))) {
      literal.push(entry);
    }
  }
  return literal;
}

function readManifestWorkspaces(manifest: Manifest): readonly string[] {
  const declared = manifest.workspaces;
  if (Array.isArray(declared)) {
    return declared.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof declared === "object" && declared !== null) {
    const packages = (declared as Record<string, unknown>)["packages"];
    if (Array.isArray(packages)) {
      return packages.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return [];
}

/**
 * The `packages:` list from pnpm-workspace.yaml, read with a deliberately narrow
 * line matcher rather than a YAML parser. A real parser is the right answer when
 * monorepos come into scope; until then, anything this does not recognise is
 * reported rather than guessed at.
 */
function readPnpmWorkspaces(root: string, warnings: string[]): readonly string[] {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const entries: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s+-\s+["']?([^"'#]+?)["']?\s*$/.exec(line);
      if (item?.[1] !== undefined) {
        entries.push(item[1]);
        continue;
      }
      if (line.trim().length > 0) {
        inPackages = false;
      }
    }
  }
  if (entries.length === 0) {
    warnings.push("pnpm-workspace.yaml was present but no packages list was recognised");
  }
  return entries;
}

/**
 * Turn the repository's own scripts into the check plan.
 *
 * A script is only usable when its name is a plain identifier and its body
 * starts with an allowlisted executable and contains no shell control syntax. A
 * `test` script that pipes into something, or runs a binary we do not allow, is
 * treated as absent: the run reports it has no test gate rather than executing
 * a line it cannot vouch for.
 */
function planChecks(
  manifest: Manifest,
  manager: PackageManager,
  root: string,
  timeoutMs: number,
  warnings: string[],
): {
  commands: readonly CommandSpec[];
  scripts: Readonly<Partial<Record<CheckPurpose, string>>>;
  absent: readonly CheckPurpose[];
} {
  const commands: CommandSpec[] = [];
  const scripts: Partial<Record<CheckPurpose, string>> = {};
  const absent: CheckPurpose[] = [];

  for (const purpose of CHECK_PURPOSES) {
    const name = CONVENTIONAL[purpose];
    if (name === undefined) {
      absent.push(purpose);
      continue;
    }
    const body = manifest.scripts[name];
    if (typeof body !== "string" || body.trim().length === 0) {
      absent.push(purpose);
      continue;
    }
    try {
      assertSafeScriptName(name);
    } catch {
      warnings.push(`script '${name}' is not a plain identifier, so ${purpose} has no gate`);
      absent.push(purpose);
      continue;
    }
    const refusal = screenScript(body);
    if (refusal !== null) {
      // The reason travels into the report. "Not in a form this run will execute" told a
      // reader nothing about which part of their script was the problem.
      warnings.push(`script '${name}' will not be used as a gate because ${refusal}`);
      absent.push(purpose);
      continue;
    }
    scripts[purpose] = name;
    commands.push({
      executable: manager,
      args: ["run", name],
      cwd: root,
      purpose,
      timeoutMs,
    });
  }

  return { commands, scripts, absent };
}

function installCommand(manager: PackageManager, root: string, timeoutMs: number): CommandSpec {
  const args = manager === "npm" ? ["ci", "--ignore-scripts"] : ["install", "--frozen-lockfile", "--ignore-scripts"];
  return { executable: manager, args, cwd: root, purpose: "install", timeoutMs };
}

/** Workflow files, so the run can say which checks CI does and does not gate. */
function detectCiFiles(root: string): readonly string[] {
  const directory = join(root, ".github", "workflows");
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => join(".github", "workflows", name));
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep);
}
