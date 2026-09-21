import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderAssessment, runUpgrade, type RunReport } from "@safe-upgrade/runner";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

const describeE2E = process.env["SAFE_UPGRADE_E2E"] === "1" ? describe : describe.skip;

let repo: FixtureRepo;
let artifacts: string;
let report: RunReport;

describeE2E("a read-only first-run assessment", () => {
  beforeAll(async () => {
    repo = createFixtureRepo();
    artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-assessment-"));
    report = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "escape-string-regexp",
      targetVersion: "5.0.0",
      artifactsDirectory: artifacts,
      assessmentOnly: true,
    });
  }, 600_000);

  afterAll(() => {
    repo.cleanup();
    rmSync(artifacts, { recursive: true, force: true });
  });

  it("runs inspection, baseline, research, and coverage assessment only", () => {
    const workers = report.events
      .filter((event) => event.type === "session_delegated")
      .map((event) => event.worker);
    expect(workers).toContain("inspector");
    expect(workers).toContain("researcher");
    expect(workers).toContain("test_author");
    expect(workers).not.toContain("implementer");
    expect(workers).not.toContain("ci_author");
    expect(workers).not.toContain("verifier");
    expect(report.finalState.fileChanges).toEqual([]);
  });

  it("leaves the source repository untouched", () => {
    expect(repo.status()).toBe("");
    expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.headCommit);
  });

  it("writes a useful assessment and a continuation command", () => {
    const markdown = readFileSync(join(artifacts, "report.md"), "utf8");
    expect(markdown).toBe(renderAssessment(report));
    expect(markdown).toMatch(/Repository-specific findings/);
    expect(markdown).toMatch(/Existing verification coverage/);
    expect(markdown).toMatch(/Tenuo warrant boundaries used/);
    expect(markdown).not.toMatch(/test_author:.*write_test_file/);
    expect(markdown).toMatch(/test_author: read_file, list_files/);
    expect(markdown).toContain(`--repository '${repo.path}'`);
    expect(markdown).toContain("Repository files changed: none");
  });
});
