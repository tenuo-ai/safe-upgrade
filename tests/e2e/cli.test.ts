/**
 * The installed binary, spec criterion 1.
 *
 * Spawned rather than imported, because everything the unit tests cannot reach lives in the
 * gap between the two: the shim that runs before anything is known about the environment,
 * the exit code the shell actually sees, and which stream each piece of output went to.
 *
 * That last one matters more than it sounds. The report goes to stdout so it can be piped
 * into a file, and the summary and any warning go to stderr so they survive being piped.
 * Getting it backwards would mean a saved report with a warning glued to the top of it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

const BIN = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "packages",
  "cli",
  "bin",
  "safe-upgrade.mjs",
);

// Installs from the registry, like the other end-to-end tests. Also needs a Node that can
// run the binary at all: the package ships TypeScript sources, so a runtime without type
// stripping refuses by design, and asserting that here would only restate the shim.
const runnable =
  process.env["SAFE_UPGRADE_E2E"] === "1" && process.features.typescript === "strip";
const describeE2E = runnable ? describe : describe.skip;

interface Invocation {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], env: Readonly<Record<string, string>> = {}): Invocation {
  const sandboxTestOverride = process.env["SAFE_UPGRADE_ALLOW_UNSANDBOXED"];
  const result = spawnSync(process.execPath, ["--no-warnings", BIN, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...(sandboxTestOverride === undefined
        ? {}
        : { SAFE_UPGRADE_ALLOW_UNSANDBOXED: sandboxTestOverride }),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describeE2E("the safe-upgrade binary", () => {
  describe("before it runs anything", () => {
    it("prints usage and exits 0 when asked for help", () => {
      const help = run(["--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("safe-upgrade <name>@<exact-version>");
    });

    it("prints usage and exits 0 when given nothing", () => {
      // A bare invocation is someone finding out what this is, not an error.
      expect(run([]).status).toBe(0);
    });

    it("exits 64 on a version that is not exact", () => {
      const attempt = run(["postcss@^8.0.0"], { NODE_ENV: "development" });
      expect(attempt.status).toBe(64);
      expect(attempt.stderr).toMatch(/not an exact version/);
      // Nothing on stdout: there is no report, so a pipe gets an empty file.
      expect(attempt.stdout).toBe("");
    });

    it("exits 64 rather than running with authority it minted for itself", () => {
      const attempt = run(["postcss@8.4.35"]);
      expect(attempt.status).toBe(64);
      expect(attempt.stderr).toContain("TENUO_ROOT_PUBLIC_KEY");
    });

    it("refuses a token on the command line, and does not echo it", () => {
      const attempt = run(["postcss@8.4.35", "--github-token", "ghp_never_print_this"], {
        NODE_ENV: "development",
      });
      expect(attempt.status).toBe(64);
      expect(attempt.stderr).toMatch(/shell history/);
      expect(`${attempt.stdout}${attempt.stderr}`).not.toContain("ghp_never_print_this");
    });
  });

  describe("a real run", () => {
    let repo: FixtureRepo;
    let artifacts: string;
    let invocation: Invocation;

    beforeAll(() => {
      repo = createFixtureRepo({ fixture: "prefix-tool", message: "prefix tool at postcss 7.0.39" });
      artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-cli-"));
      invocation = run(
        ["postcss@8.4.35", "--repository", repo.path, "--artifacts", artifacts],
        { NODE_ENV: "development" },
      );
    }, 600_000);

    afterAll(() => {
      repo.cleanup();
      rmSync(artifacts, { recursive: true, force: true });
    });

    it("exits with the code for the status it reached", () => {
      // 4 is blocked, distinct from 3 for human_required and from 1: a pipeline that treats
      // "needs an approval" as a failure is a pipeline nobody will leave enabled.
      expect(invocation.status).toBe(4);
    });

    it("puts the report on stdout and the summary on stderr", () => {
      expect(invocation.stdout).toMatch(/^# Upgrade run /m);
      expect(invocation.stdout).not.toMatch(/^blocked: /m);
      expect(invocation.stderr).toMatch(/^blocked: postcss 8\.4\.35/m);
    });

    it("says on stderr that it minted its own authority", () => {
      expect(invocation.stderr).toMatch(/minted its own authority/);
    });

    it("leaves the record where it said it would", () => {
      const report = readFileSync(join(artifacts, "report.md"), "utf8");
      // The same report, so the copy on disk and the copy that was printed agree.
      expect(invocation.stdout).toContain(report.trimEnd());
      expect(() => readFileSync(join(artifacts, "patch.diff"), "utf8")).not.toThrow();
    });

    it("points at the diff rather than at a worktree that is gone", () => {
      const report = readFileSync(join(artifacts, "report.md"), "utf8");
      expect(report).toContain(join(artifacts, "patch.diff"));
      expect(report).toMatch(/The worktree is gone/);
    });

    it("left the repository it was pointed at untouched", () => {
      expect(repo.status()).toBe("");
      expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.headCommit);
    });
  });

  describe("a first-run assessment", () => {
    let repo: FixtureRepo;
    let artifacts: string;
    let invocation: Invocation;

    beforeAll(() => {
      repo = createFixtureRepo();
      artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-cli-assess-"));
      invocation = run(
        ["assess", "--repository", repo.path, "--artifacts", artifacts],
        { NODE_ENV: "development" },
      );
    }, 600_000);

    afterAll(() => {
      repo.cleanup();
      rmSync(artifacts, { recursive: true, force: true });
    });

    it("selects an outdated direct dependency and exits successfully", () => {
      expect(invocation.status).toBe(0);
      expect(invocation.stderr).toMatch(/selected escape-string-regexp 4\.0\.0 -> 5\.0\.0/);
      expect(invocation.stderr).toMatch(/assessment complete/);
    });

    it("prints risk, coverage, warrant boundaries, and the continuation", () => {
      expect(invocation.stdout).toMatch(/^# Upgrade assessment for escape-string-regexp/m);
      expect(invocation.stdout).toMatch(/Migration work: required for 2 affected files/);
      expect(invocation.stdout).toMatch(/Impact on this repository/);
      expect(invocation.stdout).toMatch(/Verification coverage/);
      expect(invocation.stdout).toMatch(/Delegated access used for this assessment/);
      expect(invocation.stdout).not.toMatch(/test_author:.*write_test_file/);
      expect(invocation.stdout).toContain(`--repository '${repo.path}'`);
    });

    it("leaves the repository untouched", () => {
      expect(repo.status()).toBe("");
      expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.headCommit);
    });
  });

  describe("machine-readable output", () => {
    it("prints the whole report as JSON, all of it", () => {
      const repo = createFixtureRepo({ fixture: "prefix-tool" });
      try {
        const invocation = run(["postcss@8.4.35", "--repository", repo.path, "--format", "json"], {
          NODE_ENV: "development",
        });
        // Parsed rather than pattern-matched: a report truncated at the pipe size still
        // matches any regex you would write about its first line, and this is the test that
        // caught the binary exiting before stdout had drained.
        expect(invocation.stdout.length).toBeGreaterThan(8192);
        const report = JSON.parse(invocation.stdout) as { result: { status: string } };
        expect(report.result.status).toBe("blocked");
      } finally {
        repo.cleanup();
      }
    }, 600_000);
  });
});
