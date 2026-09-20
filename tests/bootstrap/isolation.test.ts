/**
 * Spec 14.1: the user's checkout is read and never written.
 *
 * These matter beyond tidiness. The run's capability ceilings are built from the
 * worktree path this module returns, so `under(worktreePath)` is a containment
 * boundary only if the path is canonical and genuinely outside the repository
 * under test. Two of these tests exist to catch the day someone "simplifies" the
 * worktree into a subdirectory of the source.
 */

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InputValidationError, RepositoryError } from "@safe-upgrade/domain";
import { isolateRepository } from "@safe-upgrade/bootstrap";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

let repo: FixtureRepo;
const releases: Array<() => void> = [];

afterEach(() => {
  while (releases.length > 0) {
    releases.pop()?.();
  }
  repo?.cleanup();
});

function isolate(overrides: { readonly runId?: string; readonly startCommit?: string } = {}) {
  const isolation = isolateRepository({
    repositoryPath: repo.path,
    runId: overrides.runId ?? "run-001",
    ...(overrides.startCommit === undefined ? {} : { startCommit: overrides.startCommit }),
  });
  releases.push(() => {
    isolation.release();
  });
  return isolation;
}

describe("worktree placement", () => {
  it("creates the worktree outside the repository under test", () => {
    repo = createFixtureRepo();
    const isolation = isolate();

    expect(isolation.worktreePath.startsWith(isolation.sourcePath)).toBe(false);
    expect(existsSync(join(isolation.worktreePath, "package.json"))).toBe(true);
    expect(isolation.startCommit).toBe(repo.headCommit);
    expect(isolation.runBranch).toBe("safe-upgrade/run-001");
    expect(isolation.defaultBranch).toBe("main");
  });

  it("resolves the source through a symlink so the path is canonical", () => {
    repo = createFixtureRepo();
    const link = join(repo.path, "..", `link-${String(process.pid)}`);
    symlinkSync(repo.path, link);
    try {
      const isolation = isolateRepository({ repositoryPath: link, runId: "run-002" });
      releases.push(() => {
        isolation.release();
      });
      expect(isolation.sourcePath).toBe(repo.path);
    } finally {
      // The link lives beside the repo, which cleanup removes wholesale.
    }
  });

  it("refuses a subdirectory of a repository", () => {
    repo = createFixtureRepo();
    expect(() => isolateRepository({ repositoryPath: join(repo.path, "src"), runId: "run-003" })).toThrow(
      RepositoryError,
    );
  });

  it("refuses a path that is not a repository at all", () => {
    repo = createFixtureRepo();
    const orphan = join(repo.path, "..", `orphan-${String(process.pid)}`);
    mkdirSync(orphan, { recursive: true });
    expect(() => isolateRepository({ repositoryPath: orphan, runId: "run-004" })).toThrow(RepositoryError);
  });
});

describe("the source repository is never written", () => {
  it("leaves uncommitted work exactly as it was", () => {
    repo = createFixtureRepo();
    repo.write("src/search.js", "// half-finished work the user has not committed\n");
    const before = repo.status();
    expect(before).not.toBe("");

    const isolation = isolate();

    expect(repo.status()).toBe(before);
    expect(isolation.sourceClean).toBe(false);
    // The worktree came from the commit, so the uncommitted edit is absent from
    // it rather than swept up into the run.
    expect(existsSync(join(isolation.worktreePath, "src", "search.js"))).toBe(true);
  });

  it("creates no branch in the source repository", () => {
    repo = createFixtureRepo();
    const before = repo.git(["branch", "--list"]);
    const isolation = isolate();
    expect(repo.git(["branch", "--list"])).toBe(before);
    expect(repo.git(["rev-parse", "HEAD"])).toBe(isolation.startCommit);
  });

  it("reports a clean source as clean", () => {
    repo = createFixtureRepo();
    expect(isolate().sourceClean).toBe(true);
  });
});

describe("inputs that could steer git", () => {
  /**
   * The run id reaches a directory name and a branch name. A traversal or a
   * flag-shaped value must be refused at the door rather than sanitised later.
   */
  const hostileRunIds = [
    ["traversal", "../../etc"],
    ["absolute", "/tmp/elsewhere"],
    ["flag", "--upload-pack=touch"],
    ["shell", "run;touch /tmp/x"],
    ["space", "run 001"],
    ["empty", ""],
    ["refspec", "run:refs/heads/main"],
  ] as const;

  for (const [label, runId] of hostileRunIds) {
    it(`refuses a ${label} run id`, () => {
      repo = createFixtureRepo();
      expect(() => isolateRepository({ repositoryPath: repo.path, runId })).toThrow(
        InputValidationError,
      );
    });
  }

  /**
   * A revision expression is not a commit. `main` moves, `HEAD@{1}` depends on
   * the local reflog, and neither is the immutable starting point the evidence
   * record claims to pin.
   */
  const nonCommits = ["main", "HEAD", "HEAD@{1}", "main~3", "v1.0.0", "--help"];
  for (const startCommit of nonCommits) {
    it(`refuses '${startCommit}' as a start commit`, () => {
      repo = createFixtureRepo();
      expect(() => isolateRepository({ repositoryPath: repo.path, runId: "run-005", startCommit })).toThrow(
        InputValidationError,
      );
    });
  }

  it("accepts a full object id and checks it out", () => {
    repo = createFixtureRepo();
    const first = repo.headCommit;
    repo.commit({ "NOTES.md": "later work\n" }, "second commit");
    const isolation = isolate({ startCommit: first });

    expect(isolation.startCommit).toBe(first);
    expect(existsSync(join(isolation.worktreePath, "NOTES.md"))).toBe(false);
  });
});

describe("release", () => {
  it("removes the worktree and leaves the source intact", () => {
    repo = createFixtureRepo();
    const isolation = isolate();
    const path = isolation.worktreePath;
    expect(existsSync(path)).toBe(true);

    isolation.release();

    expect(existsSync(path)).toBe(false);
    expect(repo.status()).toBe("");
    expect(repo.git(["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("is safe to call twice", () => {
    repo = createFixtureRepo();
    const isolation = isolate();
    isolation.release();
    expect(() => {
      isolation.release();
    }).not.toThrow();
  });
});
