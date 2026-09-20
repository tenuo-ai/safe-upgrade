/**
 * The first run that is real from end to end.
 *
 * Nothing is mocked: a git worktree is created from a commit, `npm ci` installs
 * from the committed lockfile, the fixture's own test and build scripts execute
 * as child processes, every tool call passes a Tenuo capability check, and the
 * result is classified by the same code that will classify production runs.
 *
 * The run finishes as `blocked`, and that is the assertion. Five of the seven
 * workers are not written, so the honest outcome is a stop with the reason naming
 * the gap. A test that expected `verified` here would be asserting that the
 * system reports success for work nobody did.
 *
 * Requires network access for the install, so it is opt-in via SAFE_UPGRADE_E2E.
 */

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runUpgrade, type RunReport } from "@safe-upgrade/runner";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

/** Fixed so the assertions on the written report can name it. */
const RUN_ID = "3f8c1b52-6d41-4c7a-9e02-8b5a7d4e1c93";

const enabled = process.env["SAFE_UPGRADE_E2E"] === "1";
const describeE2E = enabled ? describe : describe.skip;

let repo: FixtureRepo;
let artifacts: string;
let report: RunReport;

afterEach(() => {
  // Each block runs one shared run; cleanup happens after the last test.
});

describeE2E("a real baseline run against the fixture", () => {
  beforeAll(async () => {
    repo = createFixtureRepo();
    artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-artifacts-"));
    report = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "escape-string-regexp",
      targetVersion: "5.0.0",
      runId: RUN_ID,
      artifactsDirectory: artifacts,
    });
  }, 300_000);

  afterEach(() => {
    // no-op; see cleanup below
  });

  it("detects the repository without being told anything about it", () => {
    expect(report.facts.packageManager).toBe("npm");
    expect(report.facts.lockfile).toBe("package-lock.json");
    expect(report.facts.currentVersion).toBe("4.0.0");
    expect(report.sourceClean).toBe(true);
    // The fixture defines no typecheck or lint script, which the run reports
    // rather than treating as a failure.
    expect([...report.absentChecks].sort()).toEqual(["lint", "typecheck"]);
  });

  it("really installed and really ran the repository's own checks", () => {
    const baseline = report.finalState.baselineChecks;
    const purposes = baseline.map((check) => check.command.purpose);
    expect(purposes).toEqual(["install", "test", "build"]);
    // Green at baseline, which is what makes a later failure attributable.
    expect(baseline.every((check) => check.outcome === "passed")).toBe(true);

    const install = baseline[0];
    expect(install?.command.args).toEqual(["ci", "--ignore-scripts"]);
    expect(install?.exitCode).toBe(0);
    // Real child processes take real time.
    expect(install?.durationMs).toBeGreaterThan(0);

    // The fixture's three tests actually executed.
    const testCheck = baseline.find((check) => check.command.purpose === "test");
    expect(readFileSync(String(testCheck?.stdoutArtifact), "utf8")).toMatch(/pass 3/);
  });

  it("stops at the first worker that does not exist, and says so", () => {
    expect(report.result.status).toBe("blocked");
    expect(report.result.reasons.join(" ")).toMatch(/researcher worker is not implemented/);
    // It got as far as research, which means inspect and baseline both succeeded.
    expect(report.finalState.phase).toBe("finalize");
  });

  it("leaves an audit trail that accounts for every delegation and tool call", () => {
    const types = report.events.map((event) => event.type);
    expect(types).toContain("repository_inspected");
    expect(types).toContain("baseline_recorded");
    expect(types).toContain("session_delegated");
    expect(types).toContain("session_destroyed");
    expect(types).toContain("result_classified");

    // Every session that was delegated was also destroyed.
    const delegated = report.events.filter((event) => event.type === "session_delegated");
    const destroyed = report.events.filter((event) => event.type === "session_destroyed");
    expect(delegated.length).toBeGreaterThan(0);
    expect(destroyed).toHaveLength(delegated.length);

    // And each one was a terminal leaf with its own lifetime.
    for (const event of delegated) {
      expect(event.payload["terminal"]).toBe(true);
      expect(event.payload["depth"]).toBe(1);
    }

    // No tool call was denied: the workers that ran asked only for what their
    // profiles grant. A denial here would mean a worker and its profile disagree.
    expect(types).not.toContain("tool_denied");
    expect(types).toContain("tool_allowed");
  });

  it("writes the evidence to disk", () => {
    const result = JSON.parse(readFileSync(join(artifacts, "result.json"), "utf8")) as {
      status: string;
    };
    expect(result.status).toBe("blocked");

    const markdown = readFileSync(join(artifacts, "report.md"), "utf8");
    expect(markdown).toMatch(new RegExp(`# Upgrade run ${RUN_ID}`));
    expect(markdown).toMatch(/escape-string-regexp` 4\.0\.0 to 5\.0\.0/);
    expect(markdown).toMatch(/no runnable script, so no gate/);

    const audit = readFileSync(join(artifacts, "audit.jsonl"), "utf8").trim().split("\n");
    expect(audit.length).toBe(report.events.length);
    // Authorization events are also written separately, for review without the
    // rest of the run's noise.
    expect(readFileSync(join(artifacts, "authorization-events.jsonl"), "utf8")).toMatch(
      /session_delegated/,
    );
  });

  it("never touched the user's checkout and left no worktree behind", () => {
    expect(repo.status()).toBe("");
    expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.headCommit);
    expect(repo.git(["branch", "--list"])).toBe(`* ${repo.defaultBranch}`);
    // The worktree was released, so the source has no registration for it.
    expect(repo.git(["worktree", "list"]).split("\n")).toHaveLength(1);
    // And the dependency was never actually upgraded, because no worker got there.
    const manifest = readFileSync(join(repo.path, "package.json"), "utf8");
    expect(manifest).toMatch(/"escape-string-regexp": "4\.0\.0"/);
  });

  it("cleans up", () => {
    repo.cleanup();
    rmSync(artifacts, { recursive: true, force: true });
  });
});
