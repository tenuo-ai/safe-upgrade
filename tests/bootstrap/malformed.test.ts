/**
 * Repositories this run cannot work with, and what it says about them.
 *
 * The message is the subject here, not the refusal. Each of these is something a person can fix
 * in a minute once they know which thing is wrong, and each of them previously produced either a
 * raw git error or advice that could not be followed: a repository with no `package.json` was
 * told it needed a lockfile, which no install would produce until the manifest existed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRepositoryFacts, isolateRepository } from "@safe-upgrade/bootstrap";

function repository(files: Readonly<Record<string, string>>, options: { commit: boolean } = { commit: true }): string {
  const root = mkdtempSync(join(tmpdir(), "malformed-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (options.commit && Object.keys(files).length > 0) {
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "initial"],
      { cwd: root },
    );
  }
  return root;
}

function detect(root: string): void {
  detectRepositoryFacts({
    worktreePath: root,
    defaultBranch: "main",
    packageName: "left-pad",
    commandTimeoutMs: 60_000,
  });
}

describe("a repository with nothing in it", () => {
  it("says it has no commits, rather than reporting a failed git command", () => {
    const root = repository({}, { commit: false });
    expect(() => isolateRepository({ repositoryPath: root, runId: "11111111-1111-4111-8111-111111111111" })).toThrow(
      /no commits/,
    );
  });
});

describe("a repository with no manifest", () => {
  it("says the manifest is missing, not that a lockfile is", () => {
    // The order these are checked in is the whole point. "Run an install and commit the result"
    // is advice that cannot be followed when there is no manifest to install from.
    const root = repository({ "README.md": "hello\n" });
    expect(() => detect(root)).toThrow(/no package\.json/);
  });

  it("does not name the temporary worktree it was reading", () => {
    const root = repository({ "README.md": "hello\n" });
    try {
      detect(root);
      expect.unreachable("detection should have refused");
    } catch (error) {
      // Detection runs inside a worktree that is deleted afterwards, so a path in the message
      // sends the reader somewhere that no longer exists.
      expect((error as Error).message).not.toMatch(/\/(private\/)?var|tmp|worktree/);
    }
  });
});

describe("a repository whose manifest does not parse", () => {
  it("says the JSON is invalid", () => {
    const root = repository({ "package.json": '{ "name": "x", \n' });
    expect(() => detect(root)).toThrow(/not valid JSON/);
  });
});

describe("a repository with a manifest but no lockfile", () => {
  it("names the lockfiles it would accept", () => {
    const root = repository({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "left-pad": "1.2.0" } }),
    });
    expect(() => detect(root)).toThrow(/package-lock\.json, pnpm-lock\.yaml, yarn\.lock/);
  });
});

describe("a repository that is not the root of its checkout", () => {
  it("says which repository the path sits inside", () => {
    const root = repository({ "package.json": "{}", "packages/inner/package.json": "{}" });
    expect(() =>
      isolateRepository({
        repositoryPath: join(root, "packages", "inner"),
        runId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow(/repository root/);
  });
});
