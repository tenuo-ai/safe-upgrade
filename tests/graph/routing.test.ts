/**
 * Routing scenarios from section 20.3 of the spec.
 *
 * Each test drives the real compiled graph with scripted workers, so what is
 * being asserted is the orchestration: which specialist runs, in what order, and
 * what the run is allowed to conclude.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createGraphHarness, check, finding, type GraphHarness } from "../support/graph-harness.ts";

let harness: GraphHarness;

afterEach(() => {
  harness?.cleanup();
});

describe("the mandatory opening sequence", () => {
  it("always inspects, baselines, and researches before routing", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("install", "passed"), check("test", "passed")] }),
      },
    });
    const { state } = await harness.run();

    // The inspector runs twice: once to gather facts, once for the baseline.
    expect(harness.visited.slice(0, 3)).toEqual(["inspector", "inspector", "researcher"]);
    // No routing decision was taken before research produced findings.
    const firstRoute = state.routeHistory[0];
    expect(firstRoute?.from).toBe("route");
    expect(state.findings.length).toBeGreaterThan(0);
  });
});

describe("test sufficiency", () => {
  it("skips the test author when existing tests already cover every finding", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({
          findings: [finding("f1")],
          // Research found a finding that an existing test already covers.
          verifiedFindingIds: ["f1"],
        }),
        implementer: async () => ({
          addressedFindingIds: ["f1"],
          fileChanges: [
            { path: "src/index.ts", beforeHash: null, afterHash: null, owner: "implementer", reason: "migrate read() to parse()" },
          ],
          targetVersionResolved: true,
        }),
        verifier: async () => ({
          postChangeChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
          lastVerification: "passed",
          ciAssessment: { sufficient: true, missingChecks: [] },
        }),
      },
    });
    const { status } = await harness.run();

    expect(harness.visited).not.toContain("test_author");
    expect(harness.visited).toContain("implementer");
    expect(status).toBe("verified");
  });

  it("runs the test author before the implementer when coverage is missing", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({ findings: [finding("f1")] }),
        test_author: async () => ({
          verifiedFindingIds: ["f1"],
          testAssessment: { sufficient: true, uncoveredFindings: [], rationale: "added a regression test" },
          fileChanges: [
            { path: "src/migration.test.ts", beforeHash: null, afterHash: null, owner: "test_author", reason: "cover f1" },
          ],
        }),
        implementer: async () => ({
          addressedFindingIds: ["f1"],
          fileChanges: [
            { path: "src/index.ts", beforeHash: null, afterHash: null, owner: "implementer", reason: "migrate f1" },
          ],
          targetVersionResolved: true,
        }),
        verifier: async () => ({
          postChangeChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
          lastVerification: "passed",
          ciAssessment: { sufficient: true, missingChecks: [] },
        }),
      },
    });
    const { status } = await harness.run();

    const testAuthorAt = harness.visited.indexOf("test_author");
    const implementerAt = harness.visited.indexOf("implementer");
    expect(testAuthorAt).toBeGreaterThanOrEqual(0);
    expect(testAuthorAt).toBeLessThan(implementerAt);
    expect(status).toBe("verified");
  });
});

describe("failure recovery", () => {
  it("routes back to the implementer when verification fails, then finishes", async () => {
    let verifyCalls = 0;
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({ findings: [finding("f1")], verifiedFindingIds: ["f1"] }),
        implementer: async () => ({
          addressedFindingIds: ["f1"],
          fileChanges: [
            { path: "src/index.ts", beforeHash: null, afterHash: null, owner: "implementer", reason: "migrate f1" },
          ],
          targetVersionResolved: true,
        }),
        verifier: async () => {
          verifyCalls += 1;
          if (verifyCalls === 1) {
            return {
              postChangeChecks: [check("test", "failed")],
              lastVerification: "failed",
              ciAssessment: { sufficient: true, missingChecks: [] },
            };
          }
          return {
            postChangeChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
            lastVerification: "passed",
            ciAssessment: { sufficient: true, missingChecks: [] },
          };
        },
      },
    });
    const { status } = await harness.run();

    // implementer, verifier (fails), implementer again, verifier (passes)
    const implementerRuns = harness.visited.filter((worker) => worker === "implementer").length;
    expect(implementerRuns).toBeGreaterThanOrEqual(2);
    expect(verifyCalls).toBeGreaterThanOrEqual(2);
    expect(status).toBe("verified");
  });

  it("routes to the CI author when CI is missing required checks", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({ findings: [finding("f1")], verifiedFindingIds: ["f1"] }),
        implementer: async () => ({
          addressedFindingIds: ["f1"],
          fileChanges: [
            { path: "src/index.ts", beforeHash: null, afterHash: null, owner: "implementer", reason: "migrate f1" },
          ],
          targetVersionResolved: true,
        }),
        verifier: async () => ({
          postChangeChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
          lastVerification: "passed",
          ciAssessment: { sufficient: false, missingChecks: ["typecheck"] },
        }),
        ci_author: async () => ({
          ciAssessment: { sufficient: true, selectedWorkflow: ".github/workflows/verify.yml", missingChecks: [] },
          fileChanges: [
            { path: ".github/workflows/verify.yml", beforeHash: null, afterHash: null, owner: "ci_author", reason: "add typecheck" },
          ],
        }),
      },
    });
    const { status } = await harness.run();

    expect(harness.visited).toContain("ci_author");
    expect(status).toBe("verified");
  });

  it("stops at the attempt limit instead of looping forever", async () => {
    harness = createGraphHarness({
      config: { maxWorkerAttempts: 2, confidenceThreshold: 0.6, maxGraphSteps: 40 },
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({ findings: [finding("f1")], verifiedFindingIds: ["f1"] }),
        // Never resolves the finding, so the router keeps wanting to implement.
        implementer: async () => ({ targetVersionResolved: true }),
      },
    });
    const { status, state } = await harness.run();

    expect(state.workerAttempts.implementer).toBeLessThanOrEqual(2);
    expect(status).not.toBe("verified");
    expect(state.result?.status).toBeDefined();
  });
});

describe("approval gate", () => {
  it("pauses at human_required when a draft pull request is not approved", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({ findings: [finding("f1")], verifiedFindingIds: ["f1"] }),
        implementer: async () => ({
          addressedFindingIds: ["f1"],
          fileChanges: [
            { path: "src/index.ts", beforeHash: null, afterHash: null, owner: "implementer", reason: "migrate f1" },
          ],
          targetVersionResolved: true,
        }),
        verifier: async () => ({
          postChangeChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
          lastVerification: "passed",
          ciAssessment: { sufficient: true, missingChecks: [] },
        }),
      },
    });
    const { status, state } = await harness.run({ createDraftPullRequest: true });

    expect(status).toBe("human_required");
    expect(state.pendingApprovals).toContain("draft pull request creation");
    // Nothing was published, and the publisher never even ran.
    expect(harness.visited).not.toContain("publisher");
    expect(state.draftPullRequestUrl).toBeNull();
  });
});

describe("evidence gaps", () => {
  it("reports indeterminate rather than verified when release evidence is missing", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({
          findings: [finding("f1")],
          verifiedFindingIds: ["f1"],
          highSeverityUncertainty: ["no release notes or changelog exist for 1.3.0"],
        }),
        implementer: async () => ({
          addressedFindingIds: ["f1"],
          fileChanges: [
            { path: "src/index.ts", beforeHash: null, afterHash: null, owner: "implementer", reason: "migrate f1" },
          ],
          targetVersionResolved: true,
        }),
        verifier: async () => ({
          postChangeChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
          lastVerification: "passed",
          ciAssessment: { sufficient: true, missingChecks: [] },
        }),
      },
    });
    const { status, state } = await harness.run();

    expect(status).toBe("indeterminate");
    expect(state.result?.reasons.join(" ")).toContain("no release notes");
  });
});

describe("authorization failures inside a node", () => {
  it("turns a denial into a recorded blocking condition and finishes controllably", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({ findings: [finding("f1")], verifiedFindingIds: ["f1"] }),
        // A worker that reaches for a capability it does not hold.
        implementer: async ({ handle, state }) =>
          handle.tools
            .write_test_file({
              path: `${state.request.repositoryPath}/src/cheat.test.ts`,
              expectedBeforeHash: "absent",
              content: "test.skip('regression', () => {});\n",
            })
            .then(() => ({})),
      },
    });
    const { status, state } = await harness.run();

    expect(status).toBe("blocked");
    expect(state.blockingConditions.join(" ")).toContain("not authorized to call write_test_file");
    expect(harness.base.audit.ofType("tool_denied")).toHaveLength(1);
  });
});
