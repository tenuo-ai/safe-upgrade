/**
 * An upgrade whose break is not in any manifest.
 *
 * The other end-to-end tests upgrade across a module-system change, which a manifest
 * announces: the target says `"type": "module"` and publishes no CommonJS entry, and
 * `require()` of it throws. This one has no such tell. postcss 7 and 8 both publish as
 * CommonJS, with the same entry point and the same callable shape; the difference is that
 * `postcss.vendor` exists in 7 and does not in 8. Comparing manifests finds nothing.
 *
 * So this fixture pins down the honest outcome for a break that cannot be fixed
 * mechanically: it has to be *found*, stated in terms someone can act on, and then
 * refused rather than guessed at. The fixture also has a property the other one does not
 * — its test suite passes at the target version, because the only covered call site is
 * one that survives — so a run that trusted a green suite would report success on code
 * that does not build.
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpgrade, type RunReport } from "@safe-upgrade/runner";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

// Installs from the registry, like the other end-to-end tests.
const describeE2E = process.env["SAFE_UPGRADE_E2E"] === "1" ? describe : describe.skip;

describeE2E("an upgrade whose break is only visible in what the package exports", () => {
  let repo: FixtureRepo;
  let artifacts: string;
  let run: RunReport;

  beforeAll(async () => {
    repo = createFixtureRepo({
      fixture: "prefix-tool",
      message: "prefix tool at postcss 7.0.39",
    });
    artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-api-change-"));
    run = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "postcss",
      targetVersion: "8.4.35",
      artifactsDirectory: artifacts,
    });
  }, 600_000);

  afterAll(() => {
    repo.cleanup();
    rmSync(artifacts, { recursive: true, force: true });
  });

  describe("what research established", () => {
    it("found the removed export by comparing the two published versions", () => {
      const finding = run.finalState.findings.find((candidate) =>
        candidate.id.startsWith("export-removed-at-target:"),
      );
      expect(finding).toBeDefined();
      expect(finding?.id).toBe("export-removed-at-target:vendor");
      expect(finding?.affectedSymbols).toEqual(["postcss.vendor"]);
      // Structural, so not hedged: the name was in one installed version and not the other.
      expect(finding?.confidence).toBe(1);
    });

    it("named the file that reaches it, and not the file that does not", () => {
      const finding = run.finalState.findings.find((candidate) =>
        candidate.id === "export-removed-at-target:vendor",
      );
      // src/declarations.js uses postcss.parse, which exists at both versions.
      expect(finding?.affectedFiles).toEqual(["src/prefix.js"]);
    });

    it("cited the registry documents the comparison rests on", () => {
      const finding = run.finalState.findings.find((candidate) =>
        candidate.id === "export-removed-at-target:vendor",
      );
      expect(finding?.evidenceIds).toContain("registry:postcss@7.0.39");
      expect(finding?.evidenceIds).toContain("registry:postcss@8.4.35");
    });

    it("recorded both surfaces and the reached names in the audit", () => {
      const completed = run.events.find((event) => event.type === "research_completed");
      expect(completed?.payload["surfaceRead"]).toBe(true);
      expect(completed?.payload["removedExports"]).toContain("vendor");
      expect(completed?.payload["reachedRemovedExports"]).toEqual([
        "src/prefix.js:12 vendor",
        "src/prefix.js:13 vendor",
      ]);
    });

    it("did not claim to be in the dark, having compared the exports", () => {
      // The "a major bump and no structural rule explains it" statement belongs to runs
      // with no explanation. This run has one.
      expect(run.finalState.highSeverityUncertainty.join(" ")).not.toMatch(/no structural rule/);
    });
  });

  describe("what the run refused to do", () => {
    it("did not attempt a substitution it cannot derive", () => {
      const sources = run.finalState.fileChanges.filter((change) => change.path.startsWith("src/"));
      expect(sources).toEqual([]);
    });

    it("blocked, and said which symbol and which file need a person", () => {
      expect(run.result.status).toBe("blocked");
      const reason = run.result.reasons.join("\n");
      expect(reason).toMatch(/postcss.*exports vendor.*8\.4\.35 does not/);
      expect(reason).toContain("src/prefix.js");
      expect(reason).toMatch(/needs a person/);
    });

    it("offered the names the target added as a lead, not as an answer", () => {
      const reason = run.result.reasons.join("\n");
      expect(reason).toMatch(/where to look for a replacement/);
      expect(reason).toMatch(/not something a list of names can settle/);
    });

    it("stopped after one attempt instead of spending its budget", () => {
      // Nothing about the run changes between attempts, so a second try would rewrite the
      // lockfile and reach the same conclusion.
      const attempts = run.finalState.routeHistory.filter((entry) => entry.selected === "implement");
      expect(attempts).toHaveLength(1);
    });

    it("established nothing about the upgrade working", () => {
      expect(run.finalState.postChangeChecks).toEqual([]);
      expect(run.result.status).not.toBe("verified");
    });
  });

  describe("the parts of the run that had nothing to do", () => {
    it("left the existing workflow alone, it already runs every check", () => {
      // The other fixture is missing a check, so this is the only place the opposite
      // decision gets exercised.
      const workflows = run.finalState.fileChanges.filter((change) =>
        change.path.startsWith(".github/"),
      );
      expect(workflows).toEqual([]);
    });

    it("left the original checkout untouched", () => {
      expect(repo.status()).toBe("");
      expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.headCommit);
    });
  });
});
