/**
 * The progress lines a run prints while it runs.
 *
 * Two properties matter. Each line is about the node it names, which means differencing against
 * the previous superstep rather than reporting a total — a worker following one that wrote two
 * files would otherwise claim those two as its own. And a line is omitted rather than invented
 * when the state says nothing, because these are progress and not findings.
 */

import { describe, expect, it } from "vitest";

import { describeProgress, formatProgress } from "../../packages/runner/src/progress.ts";
import type { UpgradeState } from "../../packages/graph/src/state.ts";
import { check } from "../support/graph-harness.ts";

/** Only the channels these descriptions read. */
function state(overrides: Partial<UpgradeState>): UpgradeState {
  return {
    repository: null,
    releaseEvidence: [],
    findings: [],
    baselineChecks: [],
    postChangeChecks: [],
    fileChanges: [],
    routeHistory: [],
    blockingConditions: [],
    elevationRequests: [],
    pendingApprovals: [],
    lastVerification: "not_run",
    draftPullRequestUrl: null,
    result: null,
    ...overrides,
  } as UpgradeState;
}

describe("progress lines", () => {
  it("reports what this node wrote, not the running total", () => {
    const before = state({ fileChanges: [{ path: "a" }, { path: "b" }] as never });
    const after = state({
      fileChanges: [{ path: "a" }, { path: "b" }, { path: "c" }, { path: "d" }] as never,
    });

    // Four files exist; this node wrote two of them.
    expect(describeProgress("implement", after, before).detail).toBe("2 files changed");
  });

  it("counts everything when nothing came before it", () => {
    const after = state({ fileChanges: [{ path: "a" }] as never });

    expect(describeProgress("author_tests", after, null).detail).toBe("1 file changed");
  });

  it("prefers the reason a worker stopped over what it wrote", () => {
    // The moment a run's outcome is decided is the line most worth printing.
    const after = state({
      fileChanges: [{ path: "a" }] as never,
      blockingConditions: ["a removed export is reached in two places"],
    });

    expect(describeProgress("implement", after, null).detail).toBe(
      "stopped: a removed export is reached in two places",
    );
  });

  it("names a pending approval, since the run is about to stop for one", () => {
    const after = state({
      elevationRequests: [{ id: "e1", capability: "update_manifest_field" }] as never,
    });

    expect(describeProgress("implement", after, null).detail).toBe(
      "needs approval for update_manifest_field",
    );
  });

  it("reports only the checks this node ran", () => {
    const before = state({ postChangeChecks: [check("install", "passed")] });
    const after = state({
      postChangeChecks: [check("install", "passed"), check("test", "failed")],
    });

    expect(describeProgress("verify", after, before).detail).toBe("test failed");
  });

  it("collapses repeated purposes to the latest outcome", () => {
    const after = state({
      baselineChecks: [check("test", "failed"), check("test", "passed")],
    });

    expect(describeProgress("baseline_verify", after, null).detail).toBe("test passed");
  });

  it("says nothing rather than guessing when the state is silent", () => {
    const event = describeProgress("implement", state({}), null);

    expect(event.detail).toBeNull();
    // A phase on its own still tells a reader the run is moving.
    expect(formatProgress(event)).toBe("implement");
  });

  it("names the action a route chose", () => {
    const after = state({ routeHistory: [{ selected: "verify" }] as never });

    expect(formatProgress(describeProgress("route", after, null))).toBe("route: chose verify");
  });
});
