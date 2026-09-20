/**
 * Repository isolation.
 *
 * Everything the run does happens in a worktree this module creates. The user's
 * checkout is read and never written: no clean, no reset, no stash, no checkout,
 * no fetch. The only git commands issued against it are `rev-parse` and
 * `status`, and the worktree is created from a commit, so uncommitted work in
 * the original is neither included nor disturbed.
 *
 * This is trusted code in the strict sense: the capability ceilings for the
 * whole run are built from the values it returns. `under(worktreePath)` is only
 * a containment boundary if `worktreePath` is genuinely the canonical path of a
 * directory outside the user's checkout, and `exact(runBranch)` only pins a push
 * target if the branch name cannot be influenced by repository contents. Nothing
 * here reads a file from the repository under inspection.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { InputValidationError, RepositoryError } from "@safe-upgrade/domain";

export interface IsolationRequest {
  /** The user's checkout. Read only. */
  readonly repositoryPath: string;
  /** Used in the worktree directory and branch names, so it must be inert. */
  readonly runId: string;
  /** Commit to branch from. Defaults to the source repository's HEAD. */
  readonly startCommit?: string;
}

export interface Isolation {
  /** Canonical path of the user's checkout. */
  readonly sourcePath: string;
  /** Canonical path of the run's worktree, always outside `sourcePath`. */
  readonly worktreePath: string;
  readonly startCommit: string;
  /** The default branch, resolved from the source and never pushed to. */
  readonly defaultBranch: string;
  /** The single branch this run may create and push. */
  readonly runBranch: string;
  /**
   * False when the user had uncommitted changes. The run proceeds from the
   * commit regardless; this is reported so the result can say the working tree
   * was not what was verified.
   */
  readonly sourceClean: boolean;
  /**
   * Everything this run changed, as a unified diff against the commit it started from.
   *
   * The whole change whether or not it was committed: new files are staged
   * intent-to-add first, because a test the run wrote is part of what a reviewer has to
   * read and `git diff` alone would not mention it. Reading this is safe at any point —
   * it touches the run's worktree, never the user's checkout.
   */
  patch(): string;
  /** Remove the worktree. Leaves the user's checkout untouched. */
  release(): void;
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * Only ever run against the source repository, and only these verbs. Kept as a
 * closed list rather than a general git runner so that adding a mutating command
 * here has to be a deliberate edit.
 */
const SOURCE_READ_VERBS: ReadonlySet<string> = new Set(["rev-parse", "status", "symbolic-ref"]);

function gitRead(cwd: string, args: readonly string[]): string {
  const verb = args[0];
  if (verb === undefined || !SOURCE_READ_VERBS.has(verb)) {
    throw new RepositoryError(`refusing to run 'git ${String(verb)}' against the source repository`);
  }
  return git(cwd, args);
}

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      // No shell, and no inherited stdin: a git command that wants a credential
      // or an editor must fail rather than wait.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...gitEnvironment(), PATH: process.env["PATH"] ?? "" },
      timeout: 60_000,
    }).trim();
  } catch (cause) {
    throw new RepositoryError(`git ${args.join(" ")} failed`, { cause });
  }
}

/**
 * A git invocation that cannot be steered by the user's config, prompted for
 * credentials, or made to run a hook or an editor.
 */
function gitEnvironment(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: tmpdir(),
    GIT_EDITOR: "true",
  };
}

export function isolateRepository(request: IsolationRequest): Isolation {
  if (!RUN_ID.test(request.runId)) {
    throw new InputValidationError(`run id must be a lowercase slug, got ${request.runId}`);
  }
  if (!isAbsolute(request.repositoryPath)) {
    throw new InputValidationError(`repository path must be absolute, got ${request.repositoryPath}`);
  }

  let sourcePath: string;
  try {
    sourcePath = realpathSync(resolve(request.repositoryPath));
  } catch (cause) {
    throw new RepositoryError(`repository path does not exist: ${request.repositoryPath}`, { cause });
  }

  // The path given must be the repository root, not a subdirectory of one. A
  // subdirectory would make `under(worktreePath)` look like containment while
  // leaving the rest of the repository reachable through git.
  const topLevel = realpathSync(gitRead(sourcePath, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== sourcePath) {
    throw new RepositoryError(
      `repository path must be the repository root; ${sourcePath} sits inside ${topLevel}`,
    );
  }
  if (gitRead(sourcePath, ["rev-parse", "--is-bare-repository"]) === "true") {
    throw new RepositoryError("a bare repository has no working tree to verify");
  }

  const startCommit = resolveStartCommit(sourcePath, request.startCommit);
  const sourceClean = gitRead(sourcePath, ["status", "--porcelain=v1"]).length === 0;
  const defaultBranch = resolveDefaultBranch(sourcePath);
  const runBranch = `safe-upgrade/${request.runId}`;

  // Outside the user's checkout, so nothing the run writes can land in it even
  // if a path check is wrong somewhere downstream.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), `safe-upgrade-${request.runId}-`)));
  const worktreePath = join(parent, "worktree");
  git(sourcePath, ["worktree", "add", "--detach", "--no-checkout", worktreePath, startCommit]);
  git(worktreePath, ["checkout", "--detach", startCommit]);

  const canonicalWorktree = realpathSync(worktreePath);
  assertOutside(canonicalWorktree, sourcePath);

  let released = false;
  return {
    sourcePath,
    worktreePath: canonicalWorktree,
    startCommit,
    defaultBranch,
    runBranch,
    sourceClean,
    patch(): string {
      // Against the run's worktree, so deliberately not through `gitRead`: that guard
      // exists to keep the user's checkout limited to three read verbs, and widening it
      // for a diff taken somewhere else would weaken it for no reason.
      //
      // Intent-to-add rather than a real add, so the index still describes the same tree
      // and a commit the publisher makes later is unaffected.
      git(canonicalWorktree, ["add", "--all", "--intent-to-add"]);
      return git(canonicalWorktree, ["diff", "--no-color", startCommit]);
    },
    release(): void {
      if (released) {
        return;
      }
      released = true;
      // Prune the registration first so the source repository is not left with a
      // record of a worktree that no longer exists.
      try {
        git(sourcePath, ["worktree", "remove", "--force", canonicalWorktree]);
      } catch {
        rmSync(parent, { recursive: true, force: true });
        try {
          git(sourcePath, ["worktree", "prune"]);
        } catch {
          // The worktree directory is gone either way; a stale registration is
          // the user's to prune and not worth failing a completed run over.
        }
        return;
      }
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

function resolveStartCommit(sourcePath: string, requested: string | undefined): string {
  if (requested === undefined) {
    return gitRead(sourcePath, ["rev-parse", "HEAD"]);
  }
  if (!COMMIT.test(requested)) {
    // Deliberately not a revision expression. `HEAD@{1}`, `main~3`, and a branch
    // name all resolve to something that can move or that names a ref the run
    // has no business resolving.
    throw new InputValidationError(`start commit must be a hex object id, got ${requested}`);
  }
  return gitRead(sourcePath, ["rev-parse", "--verify", `${requested}^{commit}`]);
}

/**
 * The branch the run must never push to. Taken from the remote's published head
 * when there is one, and from the checked-out branch otherwise.
 */
function resolveDefaultBranch(sourcePath: string): string {
  try {
    const ref = gitRead(sourcePath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (name.length > 0) {
      return name;
    }
  } catch {
    // No remote, or no published head. Fall through.
  }
  const current = gitRead(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current === "HEAD") {
    throw new RepositoryError(
      "the source repository has a detached HEAD, so there is no default branch to protect",
    );
  }
  return current;
}

function assertOutside(candidate: string, source: string): void {
  if (candidate === source || candidate.startsWith(source + sep)) {
    throw new RepositoryError(
      `the run worktree must not be inside the repository under test: ${candidate}`,
    );
  }
}
