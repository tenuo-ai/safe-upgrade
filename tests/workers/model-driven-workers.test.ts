import { afterEach, describe, expect, it } from "vitest";
import type { MigrationFinding, RepositoryFacts, TestAssessment, UpgradeRequest } from "@safe-upgrade/domain";
import { FakeDecisionEngine } from "@safe-upgrade/jev";
import type { UpgradeState } from "@safe-upgrade/graph";
import {
  createImplementer,
  createTestAuthor,
  type PatchGenerationRequest,
  type PatchGenerator,
  type RunContext,
} from "@safe-upgrade/workers";
import { createHarness, type Harness } from "../support/harness.ts";

let harness: Harness;

afterEach(() => harness?.cleanup());

const finding: MigrationFinding = {
  id: "removed:legacy",
  releaseClaim: "the target removed legacy()",
  evidenceIds: ["release:example@2"],
  affectedSymbols: ["legacy"],
  affectedFiles: ["src/index.ts"],
  requiredChange: "preserve the behavior with the new API",
  confidence: 1,
  needsHuman: true,
};

function setup(generator: PatchGenerator): { context: RunContext; state: UpgradeState } {
  harness = createHarness({ requestedPackage: "left-pad", targetVersion: "2.0.0" });
  const request: UpgradeRequest = {
    runId: harness.runId,
    repositoryPath: harness.root,
    packageName: "left-pad",
    targetVersion: "2.0.0",
    companions: [],
    workspace: "",
    allowTransitive: false,
    createDraftPullRequest: false,
  };
  const facts: RepositoryFacts = {
    worktreePath: harness.root,
    defaultBranch: harness.defaultBranch,
    packageManager: "pnpm",
    workspaceRoots: [],
    manifests: ["package.json"],
    lockfile: "pnpm-lock.yaml",
    currentVersion: "1.3.0",
    declaredRange: "1.3.0",
    workspace: "",
    workspaceSelector: "",
    workspacePackageName: "fixture-app",
    companions: [],
    verificationCommands: [],
    existingCiFiles: [".github/workflows/ci.yml"],
    testFramework: "node",
  };
  const context: RunContext = {
    request,
    facts,
    checkScripts: { test: "test" },
    absentChecks: ["typecheck", "lint", "build"],
    startCommit: "fixture",
    runBranch: harness.runBranch,
    sourceClean: true,
    detectionWarnings: [],
    patchGenerator: generator,
  };
  const state = {
    request,
    phase: "route",
    step: 3,
    repository: facts,
    releaseEvidence: [
      {
        id: "release:example@2",
        sourceUrl: "https://example.invalid/release",
        sourceType: "release",
        retrievedAt: "2026-01-01T00:00:00.000Z",
        contentHash: "a".repeat(64),
        relevantExtract: "legacy() was removed",
      },
    ],
    findings: [finding],
    baselineChecks: [],
    postChangeChecks: [],
    fileChanges: [],
    testAssessment: null,
    ciAssessment: null,
    routeHistory: [],
    workerAttempts: {},
    activeSessionRef: null,
    addressedFindingIds: [],
    verifiedFindingIds: [],
    dependencyMoved: true,
    targetVersionResolved: false,
    diffPolicyPassed: true,
    lastVerification: "not_run",
    blockingConditions: [],
    highSeverityUncertainty: [],
    prohibitedActions: [],
    ciWorkflowRisks: [],
    pendingApprovals: [],
    elevationRequests: [],
    approvalGranted: false,
    draftPullRequestUrl: null,
    result: null,
  } satisfies UpgradeState;
  return { context, state };
}

describe("model-driven workers", () => {
  it("applies a source proposal through the implementer's warrant", async () => {
    const generator: PatchGenerator = {
      propose: async (request) => {
        expect(request.kind).toBe("source");
        const source = request.editableFiles[0];
        if (source === undefined) throw new Error("missing source");
        return {
          summary: "use the replacement API",
          addressedFindingIds: [finding.id],
          changes: [
            {
              path: source.path,
              expectedBeforeHash: source.hash,
              content: "export const greeting = 'migrated';\n",
              reason: "replace the removed API",
              findingIds: [finding.id],
            },
          ],
        };
      },
    };
    const { context, state } = setup(generator);
    const worker = createImplementer(context);
    const update = await harness.runtime.broker.withWorker(
      "implementer",
      "implement",
      (handle) => worker({ state, handle, runtime: harness.runtime, engine: new FakeDecisionEngine(), audit: harness.audit }),
    );

    expect(harness.read("src/index.ts")).toContain("migrated");
    expect(update.addressedFindingIds).toContain(finding.id);
    expect(update.fileChanges).toEqual([
      expect.objectContaining({ path: "src/index.ts", owner: "implementer" }),
    ]);
  });

  it("applies a behavioral test proposal through the test author's warrant", async () => {
    const calls: PatchGenerationRequest[] = [];
    const generator: PatchGenerator = {
      propose: async (request) => {
        calls.push(request);
        return {
          summary: "cover the affected behavior",
          addressedFindingIds: [finding.id],
          changes: [
            {
              path: "test/migration.test.js",
              expectedBeforeHash: "absent",
              content: 'require("../src/index.ts");\n',
              reason: "exercise the affected source",
              findingIds: [finding.id],
            },
          ],
        };
      },
    };
    const { context, state } = setup(generator);
    const worker = createTestAuthor(context);
    const authoringState = { ...state, phase: "author_tests" as const };
    const engine = new FakeDecisionEngine({
      coverage: (input) => ({
        sufficient: input.candidateTests.some((test) => test.file === "test/migration.test.js"),
        confidence: 0.95,
        rationale: "the new test reaches the affected source",
      }),
    });
    const update = await harness.runtime.broker.withWorker(
      "test_author",
      "author_tests",
      (handle) => worker({ state: authoringState, handle, runtime: harness.runtime, engine, audit: harness.audit }),
    );

    expect(calls.map((call) => call.kind)).toEqual(["tests"]);
    expect(harness.read("test/migration.test.js")).toContain("src/index.ts");
    expect(update.fileChanges).toEqual([
      expect.objectContaining({ path: "test/migration.test.js", owner: "test_author" }),
    ]);
    expect((update.testAssessment as TestAssessment | undefined)?.sufficient).toBe(true);
  });
});
