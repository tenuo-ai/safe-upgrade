/**
 * The first run that is real from end to end.
 *
 * Nothing is mocked: a git worktree is created from a commit, `npm ci` installs
 * from the committed lockfile, the fixture's own test and build scripts execute
 * as child processes, every tool call passes a Tenuo capability check, and the
 * result is classified by the same code that will classify production runs.
 *
 * The run finishes as `human_required`, and that is the assertion. The migration
 * this upgrade needs includes setting `package.json`'s `type` field, which no worker
 * holds by default, so the honest outcome is a stop that names what it wants
 * approved and changes nothing while it waits.
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

  it("researched the real package and found the break by itself", () => {
    // Nothing in this test names ESM. The finding comes from the published
    // manifests of 4.0.0 and 5.0.0, fetched from the registry during the run.
    const finding = report.finalState.findings.find((candidate) => candidate.id === "esm-only-at-target");
    expect(finding?.releaseClaim).toMatch(/ES module with no CommonJS entry point/);
    expect(finding?.confidence).toBe(1);

    // Both real call sites, and not the test file, which does not import the
    // package directly.
    expect(finding?.affectedFiles).toEqual(["src/highlight.js", "src/search.js"]);
  });

  it("cites evidence that can be checked against what was retrieved", () => {
    const evidence = report.finalState.releaseEvidence;
    const ids = evidence.map((record) => record.id);
    expect(ids).toContain("registry:escape-string-regexp@5.0.0");

    for (const record of evidence) {
      // A hash of exactly what was fetched, so a claim can be re-checked rather
      // than believed.
      expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // Every finding cites at least one stored record, and cites nothing that was
    // not stored.
    for (const finding of report.finalState.findings) {
      expect(finding.evidenceIds.length).toBeGreaterThan(0);
      for (const id of finding.evidenceIds) {
        expect(ids).toContain(id);
      }
    }
  });

  it("stops for a human rather than migrating without approval", () => {
    // The implementer needs `package.json`'s `type` set to `module`, which no worker
    // holds by default. It asks and stops. `tests/e2e/approved-upgrade.test.ts` runs
    // the other half, where the same request is approved.
    expect(report.result.status).toBe("human_required");
    expect(report.result.reasons.join(" ")).toMatch(/awaiting approval: implementer calling update_manifest_field/);
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
    // The capability the implementer lacks is one it asks for rather than attempts.
    expect(types).not.toContain("tool_denied");
    expect(types).toContain("tool_allowed");
  });

  it("writes the evidence to disk", () => {
    const result = JSON.parse(readFileSync(join(artifacts, "result.json"), "utf8")) as {
      status: string;
    };
    expect(result.status).toBe("human_required");

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
