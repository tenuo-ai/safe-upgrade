/**
 * Router behavior: what happens when the decision engine misbehaves.
 *
 * The engine is treated as an untrusted component throughout. Each test here
 * gives it a chance to derail the run and checks that it cannot.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AuditLog } from "@safe-upgrade/evidence";
import { FakeDecisionEngine } from "@safe-upgrade/jev";
import { elevationRequest } from "@safe-upgrade/domain";
import type { UpgradeRequest } from "@safe-upgrade/domain";
import {
  ACTION_WORKER,
  UNSET_REQUEST,
  buildRouteInput,
  decideRoute,
  eligibleActions,
  type RouterConfig,
  type UpgradeState,
} from "@safe-upgrade/graph";
import { check, finding } from "../support/graph-harness.ts";

const config: RouterConfig = { confidenceThreshold: 0.6, maxGraphSteps: 40, maxWorkerAttempts: 3 };

const request: UpgradeRequest = {
  ...UNSET_REQUEST,
  runId: randomUUID(),
  repositoryPath: "/tmp/worktree",
  packageName: "left-pad",
  targetVersion: "1.3.0",
};

/**
 * A state with several eligible actions, so the engine has a genuine choice and
 * the router does not short-circuit to the single-candidate path.
 */
function stateWithChoices(overrides: Partial<UpgradeState> = {}): UpgradeState {
  return {
    request,
    phase: "route",
    step: 3,
    repository: null,
    releaseEvidence: [],
    findings: [finding("f1"), finding("f2")],
    baselineChecks: [check("test", "passed")],
    postChangeChecks: [],
    fileChanges: [],
    testAssessment: null,
    ciAssessment: { sufficient: false, missingChecks: ["typecheck"] },
    routeHistory: [],
    workerAttempts: {},
    activeSessionRef: null,
    addressedFindingIds: [],
    verifiedFindingIds: [],
    // Already at the target, so these cases exercise the order among the actions that come
    // after the move rather than the move itself, which outranks all of them.
    dependencyMoved: true,
    targetVersionResolved: false,
    diffPolicyPassed: true,
    lastVerification: "not_run",
    blockingConditions: [],
    highSeverityUncertainty: [],
    prohibitedActions: [],
    pendingApprovals: [],
    elevationRequests: [],
    approvalGranted: false,
    draftPullRequestUrl: null,
    result: null,
    ...overrides,
  } as UpgradeState;
}

let audit: AuditLog;

beforeEach(() => {
  audit = new AuditLog({ runId: request.runId });
});

afterEach(() => {
  // Nothing to clean up: the router touches no filesystem and no session.
});

describe("candidate construction", () => {
  it("offers only actions that are both legal and currently sensible", () => {
    const candidates = eligibleActions(stateWithChoices(), config).map((entry) => entry.action);
    expect(candidates).toContain("implement");
    expect(candidates).toContain("assess_verification");
    // Nothing has changed yet, so there is nothing to verify or publish.
    expect(candidates).not.toContain("verify");
    expect(candidates).not.toContain("publish_draft");
  });

  it("does not configure CI for an upgrade that has not been made yet", () => {
    // A workflow added now would say it runs the checks this upgrade was verified
    // against, which is not true of a run whose findings are still outstanding.
    const outstanding = eligibleActions(stateWithChoices(), config).map((entry) => entry.action);
    expect(outstanding).not.toContain("configure_ci");

    const done = eligibleActions(
      stateWithChoices({ addressedFindingIds: ["f1", "f2"] }),
      config,
    ).map((entry) => entry.action);
    expect(done).toContain("configure_ci");
  });

  it("withholds a worker that is waiting on an approval nobody has given", () => {
    // It asked, it wrote nothing, and nothing has changed since: routing to it again
    // would produce the same request until its attempts ran out.
    const request = elevationRequest({
      worker: "implementer",
      capability: "update_manifest_field",
      arguments: { path: "package.json", field: "type", value: "module" },
      reason: "the target is ESM-only",
      findingIds: ["f1"],
    });
    const waiting = stateWithChoices({ elevationRequests: [request] });

    expect(eligibleActions(waiting, config).map((entry) => entry.action)).not.toContain("implement");
    // Granted, it is offered again, because now the retry can do something different.
    const grants = [{ id: request.id, approvedBy: "someone", approvedAt: "2026-01-01T00:00:00.000Z" }];
    expect(eligibleActions(waiting, config, grants).map((entry) => entry.action)).toContain("implement");
  });

  it("never offers publish_draft before verification passes", () => {
    const candidates = eligibleActions(
      stateWithChoices({ approvalGranted: true, lastVerification: "failed" }),
      config,
    ).map((entry) => entry.action);
    expect(candidates).not.toContain("publish_draft");
  });

  it("withholds a worker that has exhausted its attempts", () => {
    const candidates = eligibleActions(
      stateWithChoices({ workerAttempts: { implementer: 3 } }),
      config,
    ).map((entry) => entry.action);
    expect(candidates).not.toContain("implement");
  });

  it("sends no repository content or log output to the engine", () => {
    const input = buildRouteInput(stateWithChoices(), config);
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("/tmp/worktree/src");
    // Findings are summarized, not shipped whole.
    expect(input.unresolvedFindings[0]?.summary.length).toBeLessThanOrEqual(280);
    expect(Object.keys(input).sort()).toEqual([
      "attempts",
      "baselinePassed",
      "ciSufficient",
      "currentPhase",
      "dependencyMoved",
      "eligibleActions",
      "implementationChanged",
      "lastVerification",
      "testsChanged",
      "unresolvedFindings",
    ]);
  });
});

describe("engine responses", () => {
  it("follows a confident choice from the candidate set", async () => {
    const engine = new FakeDecisionEngine({
      script: [{ kind: "choose", action: "assess_verification", confidence: 0.95 }],
    });
    const route = await decideRoute(stateWithChoices(), { engine, config, audit });

    expect(route.decision.selected).toBe("assess_verification");
    expect(route.decision.source).toBe("jev");
    expect(route.worker).toBe(ACTION_WORKER.assess_verification);
  });

  it("falls back deterministically when confidence is below the threshold", async () => {
    const engine = new FakeDecisionEngine({
      script: [{ kind: "choose", action: "assess_verification", confidence: 0.2 }],
    });
    const route = await decideRoute(stateWithChoices(), { engine, config, audit });

    expect(route.decision.source).toBe("fallback");
    expect(route.decision.confidence).toBe(0.2);
    expect(route.decision.fallbackReason).toContain("below the 0.6 threshold");
    // Spec order: covering a finding that has no verification path outranks
    // implementing it.
    expect(route.decision.selected).toBe("author_tests");
  });

  it("moves the dependency rather than configuring CI for a change nobody made", async () => {
    // The gap real repositories exposed: with `implement` gated on research having produced a
    // finding, a clean upgrade — which is most upgrades — routed straight past the manifest,
    // wrote a workflow, and finished with a patch that changed no version at all.
    const engine = new FakeDecisionEngine();
    const route = await decideRoute(stateWithChoices({ dependencyMoved: false, findings: [] }), {
      engine,
      config,
      audit,
    });

    expect(route.decision.selected).toBe("implement");
    expect(route.worker).toBe(ACTION_WORKER.implement);
  });

  it("does not offer migrating a finding whose change reaches test files", async () => {
    // Not a preference here but a constraint, and the difference is what a live model made of
    // it. Offered `implement` and `author_tests` for an ESM break, the engine picked migrating
    // with 0.85 to 0.98 confidence across every phrasing of the state it was shown — and the
    // run that reaches `verified` under the deterministic order came out `blocked`, because the
    // implementer converted the source while the tests went on loading it the old way. The cost
    // is invisible in anything the engine sees, so the choice is not offered.
    const engine = new FakeDecisionEngine({
      script: [{ kind: "choose", action: "implement", confidence: 0.98 }],
    });
    const spanning = { ...finding("f1"), spansTestFiles: true };
    const route = await decideRoute(
      stateWithChoices({ dependencyMoved: false, findings: [spanning] }),
      { engine, config, audit },
    );

    expect(route.decision.candidates).not.toContain("implement");
    expect(route.decision.selected).toBe("author_tests");
  });

  it("offers it again once the tests have moved", async () => {
    const engine = new FakeDecisionEngine();
    const spanning = { ...finding("f1"), spansTestFiles: true };
    const route = await decideRoute(
      stateWithChoices({
        dependencyMoved: false,
        findings: [spanning],
        verifiedFindingIds: ["f1"],
        testAssessment: { sufficient: true, uncoveredFindings: [], rationale: "covered" },
        fileChanges: [
          { path: "test/f1.test.js", beforeHash: null, afterHash: null, owner: "test_author", reason: "cover f1" },
        ],
      }),
      { engine, config, audit },
    );

    expect(route.decision.selected).toBe("implement");
  });

  it("still covers an unverified finding before moving anything", async () => {
    // The move outranks CI and verification, not coverage. The implementer migrates source in
    // the same visit that it moves the dependency, so going first would convert the source
    // while the tests still load it the old way and fail a round that was always going to.
    const engine = new FakeDecisionEngine();
    const route = await decideRoute(stateWithChoices({ dependencyMoved: false }), {
      engine,
      config,
      audit,
    });

    expect(route.decision.selected).toBe("author_tests");
  });

  it("rejects a choice that was never offered", async () => {
    const engine = new FakeDecisionEngine({ script: [{ kind: "invalid", action: "publish_draft" }] });
    const route = await decideRoute(stateWithChoices(), { engine, config, audit });

    expect(route.decision.selected).not.toBe("publish_draft");
    expect(route.decision.source).toBe("fallback");
    expect(route.decision.fallbackReason).toContain("not among the offered candidates");
    // An out-of-set answer is not retried; one call, then the fallback.
    expect(engine.routeCalls).toHaveLength(1);
  });

  it("rejects an invented action that is not a phase at all", async () => {
    const engine = new FakeDecisionEngine({ script: [{ kind: "invalid", action: "exfiltrate_secrets" }] });
    const route = await decideRoute(stateWithChoices(), { engine, config, audit });

    expect(route.decision.source).toBe("fallback");
    // Whatever the engine said, the selection is one the router offered.
    expect(route.decision.candidates).toContain(route.decision.selected);
  });

  it("retries once on a transport failure, then falls back", async () => {
    const engine = new FakeDecisionEngine({
      script: [{ kind: "unavailable" }, { kind: "choose", action: "assess_verification", confidence: 0.95 }],
    });
    const route = await decideRoute(stateWithChoices(), { engine, config, audit });

    expect(engine.routeCalls).toHaveLength(2);
    expect(route.decision.selected).toBe("assess_verification");
    expect(route.decision.source).toBe("jev");
  });

  it("falls back when both attempts fail", async () => {
    const engine = new FakeDecisionEngine({ script: [{ kind: "unavailable" }, { kind: "malformed" }] });
    const route = await decideRoute(stateWithChoices(), { engine, config, audit });

    expect(engine.routeCalls).toHaveLength(2);
    expect(route.decision.source).toBe("fallback");
  });

  it("does not consult the engine when only one action is eligible", async () => {
    const engine = new FakeDecisionEngine();
    const route = await decideRoute(
      stateWithChoices({ findings: [], ciAssessment: { sufficient: true, missingChecks: [] } }),
      { engine, config, audit },
    );

    expect(engine.routeCalls).toHaveLength(0);
    expect(route.decision.selected).toBe("finalize");
    expect(route.decision.fallbackReason).toBe("only one eligible action");
  });
});

describe("audit trail", () => {
  it("records the candidates, the choice, and why each was eligible", async () => {
    const engine = new FakeDecisionEngine({
      script: [{ kind: "choose", action: "implement", confidence: 0.88 }],
    });
    await decideRoute(stateWithChoices(), { engine, config, audit });

    const recorded = audit.ofType("route_decision");
    expect(recorded).toHaveLength(1);
    const payload = recorded[0]?.payload as Record<string, unknown>;
    expect(payload.selected).toBe("implement");
    expect(payload.source).toBe("jev");
    expect(payload.confidence).toBe(0.88);
    expect(payload.candidates).toContain("assess_verification");
    expect(payload.eligibilityReasons).toMatchObject({ implement: expect.any(String) });
  });
});
