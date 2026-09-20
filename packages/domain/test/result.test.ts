import { describe, expect, it } from "vitest";
import { classifyRun, type ClassificationInput } from "../src/result.ts";
import type { CheckResult } from "../src/types.ts";

function check(purpose: CheckResult["command"]["purpose"], outcome: CheckResult["outcome"]): CheckResult {
  return {
    command: { executable: "pnpm", args: ["run", purpose], cwd: "/tmp/wt", purpose, timeoutMs: 1000 },
    phase: "final",
    exitCode: outcome === "passed" ? 0 : 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 10,
    stdoutArtifact: "checks/out.txt",
    stderrArtifact: "checks/err.txt",
    outcome,
  };
}

const verifiable: ClassificationInput = {
  baselineKnown: true,
  baselineRequiredFailure: false,
  targetVersionResolved: true,
  findingIds: ["f1"],
  addressedFindingIds: ["f1"],
  verifiedFindingIds: ["f1"],
  requiredChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
  optionalCheckPurposes: [],
  diffPolicyPassed: true,
  ciSufficient: true,
  highSeverityUncertainty: [],
  blockingConditions: [],
  prohibitedActions: [],
  pendingApprovals: [],
  partialAllowed: true,
  evidenceLinks: [],
  draftPullRequestUrl: null,
  now: "2026-01-01T00:00:00.000Z",
};

describe("classifyRun", () => {
  it("returns verified only when every condition holds", () => {
    expect(classifyRun(verifiable).status).toBe("verified");
  });

  it("returns blocked for a prohibited action, whatever else passed", () => {
    const result = classifyRun({ ...verifiable, prohibitedActions: ["pushed the default branch"] });
    expect(result.status).toBe("blocked");
    expect(result.reasons[0]).toContain("pushed the default branch");
  });

  it("puts blocking conditions ahead of a pending approval", () => {
    const result = classifyRun({
      ...verifiable,
      blockingConditions: ["package manager is not supported"],
      pendingApprovals: ["draft pull request"],
    });
    expect(result.status).toBe("blocked");
  });

  it("returns human_required when a valid next step awaits approval", () => {
    const result = classifyRun({ ...verifiable, pendingApprovals: ["draft pull request"] });
    expect(result.status).toBe("human_required");
  });

  it("says whether the approval is the only thing left", () => {
    // The two cases below are the same status and want opposite decisions from whoever
    // reads them, so the difference has to be in the reasons.
    const settled = classifyRun({ ...verifiable, pendingApprovals: ["draft pull request"] });
    expect(settled.reasons).toContain("nothing else is outstanding: every other condition this run checks is met");

    const unsettled = classifyRun({
      ...verifiable,
      pendingApprovals: ["draft pull request"],
      ciSufficient: false,
      requiredChecks: [check("install", "passed"), check("test", "failed")],
    });
    expect(unsettled.reasons.join(" ")).toContain("also outstanding");
    expect(unsettled.reasons.join(" ")).toContain("required test check failed");
    expect(unsettled.reasons.join(" ")).toContain("CI does not cover");
  });

  it("returns indeterminate rather than verified when evidence is missing", () => {
    const result = classifyRun({
      ...verifiable,
      highSeverityUncertainty: ["no release notes exist for this version"],
    });
    expect(result.status).toBe("indeterminate");
    expect(result.unverifiedClaims.join(" ")).toContain("cannot be shown to be correct");
  });

  it("returns indeterminate when research recorded no findings at all", () => {
    expect(
      classifyRun({ ...verifiable, findingIds: [], addressedFindingIds: [], verifiedFindingIds: [] }).status,
    ).toBe("indeterminate");
  });

  it("returns partial and names the unverified claim when a check fails", () => {
    const result = classifyRun({
      ...verifiable,
      requiredChecks: [check("test", "passed"), check("typecheck", "failed")],
    });
    expect(result.status).toBe("partial");
    expect(result.unverifiedClaims).toContain("typecheck is unverified");
  });

  it("returns partial when a finding is addressed but has no verification path", () => {
    const result = classifyRun({ ...verifiable, verifiedFindingIds: [] });
    expect(result.status).toBe("partial");
    expect(result.reasons.join(" ")).toContain("no meaningful verification path");
  });

  it("blocks on a failing required baseline unless the run permits a partial result", () => {
    expect(classifyRun({ ...verifiable, baselineRequiredFailure: true, partialAllowed: false }).status).toBe(
      "blocked",
    );
  });

  it("caps a run that started from a failing baseline at partial, never verified", () => {
    const result = classifyRun({ ...verifiable, baselineRequiredFailure: true, partialAllowed: true });
    expect(result.status).toBe("partial");
    expect(result.unverifiedClaims.join(" ")).toContain("passing baseline");
  });

  it("never reports verified when CI does not cover the verified commands", () => {
    const result = classifyRun({ ...verifiable, ciSufficient: false });
    expect(result.status).toBe("partial");
    expect(result.unverifiedClaims.join(" ")).toContain("CI will not re-run");
  });

  it("never reports verified when the target version did not resolve", () => {
    expect(classifyRun({ ...verifiable, targetVersionResolved: false }).status).toBe("partial");
  });
});
