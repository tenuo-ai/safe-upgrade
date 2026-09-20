/**
 * The approval loop, run for real twice.
 *
 * First run: the implementer finds that the upgrade needs `package.json`'s `type`
 * set to `module`, which no worker holds by default. It records a request and writes
 * nothing, so the run ends `human_required` with the worktree as it was found.
 *
 * Second run: the same request is approved by id. The implementer holds the
 * capability for that one call, applies the migration, and the verifier decides
 * whether it worked from a clean frozen install.
 *
 * Nothing is mocked. The registry is real, `npm ci` is real, and the fixture's own
 * test and build scripts run as child processes.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElevationGrant } from "@safe-upgrade/domain";
import { runUpgrade, type RunReport } from "@safe-upgrade/runner";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

const enabled = process.env["SAFE_UPGRADE_E2E"] === "1";
const describeE2E = enabled ? describe : describe.skip;

const FIRST_RUN = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SECOND_RUN = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

let repo: FixtureRepo;
let artifacts: string;
let asked: RunReport;
let approved: RunReport;
let grant: ElevationGrant;

describeE2E("an upgrade that needs approval to proceed", () => {
  beforeAll(async () => {
    repo = createFixtureRepo();
    artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-approval-"));

    asked = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "escape-string-regexp",
      targetVersion: "5.0.0",
      runId: FIRST_RUN,
      artifactsDirectory: join(artifacts, "asked"),
    });

    const request = asked.finalState.elevationRequests[0];
    grant = {
      id: String(request?.id),
      approvedBy: "an-operator",
      approvedAt: new Date().toISOString(),
    };

    approved = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "escape-string-regexp",
      targetVersion: "5.0.0",
      runId: SECOND_RUN,
      artifactsDirectory: join(artifacts, "approved"),
      approvals: [grant],
    });
  }, 600_000);

  afterAll(() => {
    repo.cleanup();
    rmSync(artifacts, { recursive: true, force: true });
  });

  describe("the run that asked", () => {
    it("stops for a human and says exactly what it wants", () => {
      expect(asked.result.status).toBe("human_required");

      const request = asked.finalState.elevationRequests[0];
      expect(request?.worker).toBe("implementer");
      expect(request?.capability).toBe("update_manifest_field");
      // Worktree-relative, so the approval still means something once this
      // worktree has been deleted.
      expect(request?.arguments).toEqual({ path: "package.json", field: "type", value: "module" });
      expect(request?.findingIds).toEqual(["esm-only-at-target"]);
    });

    it("changed nothing while it waited", () => {
      // A dependency bumped without the migration leaves a worktree that does not
      // build, so the implementer moves nothing until it can move everything.
      const manifest = readFileSync(join(repo.path, "package.json"), "utf8");
      expect(manifest).toMatch(/"escape-string-regexp": "4\.0\.0"/);
      expect(manifest).not.toMatch(/"type"/);
      expect(repo.status()).toBe("");
    });

    it("tells the reader how to approve it", () => {
      const markdown = readFileSync(join(artifacts, "asked", "report.md"), "utf8");
      expect(markdown).toMatch(/## Approval needed before this can proceed/);
      expect(markdown).toMatch(/implementer calling update_manifest_field/);
      expect(markdown).toMatch(new RegExp(`Approval id: \`${String(asked.finalState.elevationRequests[0]?.id)}\``));
      // The re-run recipe, not just the fact that something is needed.
      expect(markdown).toMatch(/"approvedBy": "<who>"/);
    });

    it("never had the capability, so no call to it was even attempted", () => {
      const types = asked.events.map((event) => event.type);
      expect(types).toContain("elevation_requested");
      expect(types).not.toContain("elevation_granted");
      // The delegation records what the implementer actually held.
      const delegations = asked.events.filter(
        (event) => event.type === "session_delegated" && event.worker === "implementer",
      );
      expect(delegations.length).toBeGreaterThan(0);
      for (const delegation of delegations) {
        expect(delegation.payload["capabilities"]).not.toContain("update_manifest_field");
        expect(delegation.payload["elevatedCapabilities"]).toEqual([]);
      }
    });
  });

  describe("the run that was approved", () => {
    it("granted exactly one call, to exactly one worker", () => {
      const grants = approved.events.filter((event) => event.type === "elevation_granted");
      expect(grants).toHaveLength(1);
      expect(grants[0]?.worker).toBe("implementer");
      expect(grants[0]?.payload["approvedBy"]).toBe("an-operator");
      expect(grants[0]?.payload["request"]).toMatch(/field=type path=package\.json value=module/);
    });

    it("applied the migration the finding called for", () => {
      const changed = approved.finalState.fileChanges.map((change) => change.path);
      // Every file in the package moves, not only the two that name the dependency:
      // a module converted to ESM can no longer be required by its neighbour.
      expect(changed).toContain("src/search.js");
      expect(changed).toContain("src/highlight.js");
      expect(changed).toContain("src/index.js");
      expect(changed).toContain("package.json");

      const manifestChange = approved.finalState.fileChanges.find(
        (change) => change.path === "package.json",
      );
      expect(manifestChange?.reason).toMatch(/set type to module, from unset/);
      expect(manifestChange?.owner).toBe("implementer");
    });

    it("attributes every write to the worker that was allowed to make it", () => {
      // Not a convention: each area has exactly one worker holding the capability that
      // can write it, so the owner recorded here is the only one it could have been.
      const ownerFor = (path: string): string => {
        if (path.startsWith("test/")) {
          return "test_author";
        }
        return path.startsWith(".github/workflows/") ? "ci_author" : "implementer";
      };
      for (const change of approved.finalState.fileChanges) {
        expect(change.owner).toBe(ownerFor(change.path));
      }
    });

    it("noticed the untested call site and wrote a test that reaches it", () => {
      // The first assessment is where the gap is recorded. `highlight` has no test in
      // the fixture, which is what the run is meant to find; `search` does, so it is
      // not reported.
      const firstAssessment = approved.events.find(
        (event) => event.type === "test_assessment_recorded",
      );
      expect(firstAssessment?.payload["sufficient"]).toBe(false);
      expect(String(firstAssessment?.payload["rationale"])).toMatch(/src\/highlight\.js/);
      expect(String(firstAssessment?.payload["rationale"])).not.toMatch(/src\/search\.js/);

      const added = approved.finalState.fileChanges.find(
        (change) => change.path === "test/highlight.load.test.js",
      );
      expect(added?.owner).toBe("test_author");

      // And the gap is closed rather than merely reported: the re-assessment after
      // writing is what makes the run stop asking for more tests.
      expect(approved.finalState.testAssessment?.sufficient).toBe(true);
    });

    it("ran a clean frozen install and the repository's own checks afterwards", () => {
      const purposes = approved.finalState.postChangeChecks.map((check) => check.command.purpose);
      expect(purposes).toContain("install");
      expect(purposes).toContain("test");
      expect(purposes).toContain("build");

      const install = approved.finalState.postChangeChecks.find(
        (check) => check.command.purpose === "install",
      );
      expect(install?.command.args).toEqual(["ci", "--ignore-scripts"]);
    });

    it("resolved the dependency to the exact target, not a range containing it", () => {
      expect(approved.finalState.targetVersionResolved).toBe(true);
    });

    it("weakened no test on the way", () => {
      expect(approved.finalState.diffPolicyPassed).toBe(true);
      expect(approved.finalState.prohibitedActions).toEqual([]);
    });

    it("left the user's checkout untouched throughout", () => {
      expect(repo.status()).toBe("");
      expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.headCommit);
      expect(repo.git(["worktree", "list"]).split("\n")).toHaveLength(1);
      expect(readFileSync(join(repo.path, "package.json"), "utf8")).not.toMatch(/"type"/);
    });

    it("closed the gap between what passed locally and what CI would run", () => {
      // The fixture's own workflow runs the tests and never the build, on purpose. A
      // green local build there proves nothing about a merge.
      const assessment = approved.events.find((event) => event.type === "ci_assessment_recorded");
      expect(assessment?.payload["wasMissing"]).toEqual(["build"]);

      const workflow = approved.finalState.fileChanges.find(
        (change) => change.path === ".github/workflows/safe-upgrade-checks.yml",
      );
      expect(workflow?.owner).toBe("ci_author");
      expect(approved.finalState.ciAssessment).toMatchObject({
        sufficient: true,
        missingChecks: [],
      });

      // The existing workflow is left alone. The new checks arrive as a file a reviewer
      // can read next to it, not as an edit that could have dropped a step.
      const edited = approved.finalState.fileChanges.filter(
        (change) => change.path === ".github/workflows/ci.yml",
      );
      expect(edited).toEqual([]);
    });

    it("reached a verified conclusion, with its reasons stated", () => {
      // This fixture supports every condition `verified` requires, so anything less is
      // a real gap rather than a limit of the scenario. The one dependency that is not
      // in this repository's control is the release document: a major bump whose notes
      // cannot be read is `indeterminate` by design, and saying so here is more useful
      // than a test that fails when GitHub rate-limits an unauthenticated request.
      const uncertainty = approved.finalState.highSeverityUncertainty;
      if (uncertainty.length > 0) {
        expect(uncertainty.join(" ")).toMatch(/release note|changelog/i);
        expect(approved.result.status).toBe("indeterminate");
        return;
      }

      expect(approved.result.status).toBe("verified");
      expect(approved.result.reasons).toContain("target version resolved exactly");
      expect(approved.result.reasons).toContain("CI covers the verified command set");
      expect(approved.finalState.blockingConditions).toEqual([]);

      // Every finding, including the one no edit can discharge, ends up both addressed
      // and covered by something that would catch a regression.
      for (const finding of approved.finalState.findings) {
        expect(approved.finalState.addressedFindingIds).toContain(finding.id);
        expect(approved.finalState.verifiedFindingIds).toContain(finding.id);
      }
    });

    it("stopped short of publishing, because nobody approved it", () => {
      // Verified is not the same as agreed to. Publishing is a separate decision, and
      // the run does not take it on the strength of its own verdict.
      expect(approved.finalState.draftPullRequestUrl).toBeNull();
      expect(approved.finalState.routeHistory.map((route) => route.selected)).not.toContain(
        "publish_draft",
      );
    });
  });
});
