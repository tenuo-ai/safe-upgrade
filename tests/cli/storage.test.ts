import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultRunDirectory,
  loadAssessment,
  safeUpgradeHome,
  saveAssessment,
  validateAssessmentState,
} from "@safe-upgrade/cli";
import type { RunReport } from "@safe-upgrade/runner";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

const RUN_ID = "01234567-89ab-4cde-8fab-0123456789ab";

describe("durable assessment records", () => {
  let repo: FixtureRepo | undefined;
  let state: string | undefined;

  afterEach(() => {
    repo?.cleanup();
    if (state !== undefined) rmSync(state, { recursive: true, force: true });
    repo = undefined;
    state = undefined;
  });

  it("keeps its default records outside the repository", () => {
    state = mkdtempSync(join(tmpdir(), "safe-upgrade-state-"));
    const env = { SAFE_UPGRADE_HOME: state };
    expect(safeUpgradeHome(env)).toBe(state);
    expect(defaultRunDirectory(env, RUN_ID)).toBe(join(state, "runs", RUN_ID));
  });

  it("saves enough evidence to continue and accepts an unchanged checkout", () => {
    repo = createFixtureRepo();
    state = mkdtempSync(join(tmpdir(), "safe-upgrade-state-"));
    const artifacts = join(state, "runs", RUN_ID);
    mkdirSync(artifacts, { recursive: true });
    const record = saveAssessment(report(repo, artifacts), {
      env: { SAFE_UPGRADE_HOME: state },
      engine: "deterministic",
    });

    expect(loadAssessment(RUN_ID, { SAFE_UPGRADE_HOME: state })).toEqual(record);
    expect(() => validateAssessmentState(record)).not.toThrow();
    expect(repo.status()).toBe("");
  });

  it("refuses continuation when the repository moved", () => {
    repo = createFixtureRepo();
    state = mkdtempSync(join(tmpdir(), "safe-upgrade-state-"));
    const artifacts = join(state, "runs", RUN_ID);
    mkdirSync(artifacts, { recursive: true });
    const record = saveAssessment(report(repo, artifacts), {
      env: { SAFE_UPGRADE_HOME: state },
      engine: "deterministic",
    });

    repo.commit({ "notes.txt": "new state\n" }, "move repository");
    expect(() => validateAssessmentState(record)).toThrow(/repository moved.*new assessment/);
  });

  it("refuses continuation when assessed dependency inputs are dirty", () => {
    repo = createFixtureRepo();
    state = mkdtempSync(join(tmpdir(), "safe-upgrade-state-"));
    const artifacts = join(state, "runs", RUN_ID);
    mkdirSync(artifacts, { recursive: true });
    const record = saveAssessment(report(repo, artifacts), {
      env: { SAFE_UPGRADE_HOME: state },
      engine: "deterministic",
    });

    repo.write("package.json", "{}\n");
    expect(() => validateAssessmentState(record)).toThrow(/uncommitted changes.*new assessment/);
  });
});

function report(repo: FixtureRepo, artifactsDirectory: string): RunReport {
  return {
    runId: RUN_ID,
    sourceRepositoryPath: repo.path,
    request: {
      runId: RUN_ID,
      repositoryPath: repo.path,
      packageName: "escape-string-regexp",
      targetVersion: "5.0.0",
      companions: [],
      workspace: "",
      allowTransitive: false,
      createDraftPullRequest: false,
    },
    startCommit: repo.headCommit,
    sourceClean: true,
    facts: { lockfile: "package-lock.json" },
    result: { classifiedAt: "2026-09-21T00:00:00.000Z" },
    artifactsDirectory,
  } as unknown as RunReport;
}
