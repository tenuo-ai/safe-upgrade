/**
 * A throwaway git repository seeded from `fixtures/legacy-app`.
 *
 * The fixture is committed as plain files rather than as a nested repository,
 * so each test gets a real repository with a real commit to branch from, and
 * mutations in one test cannot reach another.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "fixtures");

export interface FixtureRepo {
  readonly path: string;
  readonly defaultBranch: string;
  readonly headCommit: string;
  /** Write a file and commit it. */
  commit(files: Readonly<Record<string, string>>, message: string): string;
  /** Write a file without committing, leaving the worktree dirty. */
  write(relativePath: string, contents: string): void;
  status(): string;
  git(args: readonly string[]): string;
  cleanup(): void;
}

export function createFixtureRepo(
  options: { readonly fixture?: string; readonly defaultBranch?: string } = {},
): FixtureRepo {
  const fixture = options.fixture ?? "legacy-app";
  const defaultBranch = options.defaultBranch ?? "main";
  const root = realpathSync(mkdtempSync(join(tmpdir(), "safe-upgrade-fixture-")));

  cpSync(join(FIXTURE_ROOT, fixture), root, {
    recursive: true,
    // Installed dependencies and build output are not part of the fixture.
    filter: (source) => !source.includes(`${"node_modules"}`) && !source.includes("/dist"),
  });

  const git = (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git(["init", "--initial-branch", defaultBranch]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "."]);
  git(["commit", "-m", "legacy app at escape-string-regexp 4.0.0"]);

  return {
    path: root,
    defaultBranch,
    headCommit: git(["rev-parse", "HEAD"]),
    commit(files, message) {
      for (const [relativePath, contents] of Object.entries(files)) {
        writeFileSync(join(root, relativePath), contents);
      }
      git(["add", "."]);
      git(["commit", "-m", message]);
      return git(["rev-parse", "HEAD"]);
    },
    write(relativePath, contents) {
      writeFileSync(join(root, relativePath), contents);
    },
    status: () => git(["status", "--porcelain=v1"]),
    git,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
