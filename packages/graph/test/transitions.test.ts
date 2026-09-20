import { describe, expect, it } from "vitest";
import { ACTION_WORKER, ROUTABLE_ACTIONS, TRANSITIONS, isLegalTransition } from "../src/transitions.ts";
import type { Phase } from "@safe-upgrade/domain";

const PHASES = Object.keys(TRANSITIONS) as Phase[];

describe("the transition allowlist", () => {
  it("lets every phase reach finalize, so a blocking condition always has an exit", () => {
    for (const phase of PHASES) {
      if (phase === "finalize") {
        continue;
      }
      expect(isLegalTransition(phase, "finalize"), phase).toBe(true);
    }
  });

  it("has no way out of finalize", () => {
    expect(TRANSITIONS.finalize).toEqual([]);
  });

  it("refuses transitions that skip the mandatory opening sequence", () => {
    expect(isLegalTransition("inspect", "route")).toBe(false);
    expect(isLegalTransition("inspect", "implement")).toBe(false);
    expect(isLegalTransition("baseline_verify", "route")).toBe(false);
    // Routing begins only after research.
    expect(isLegalTransition("research", "route")).toBe(true);
  });

  it("returns every worker phase to the router rather than to another worker", () => {
    for (const action of ROUTABLE_ACTIONS) {
      if (action === "finalize" || action === "publish_draft") {
        continue;
      }
      expect(TRANSITIONS[action]).toEqual(["route", "finalize"]);
    }
    // Publishing is terminal: there is nothing to decide afterwards.
    expect(TRANSITIONS.publish_draft).toEqual(["finalize"]);
  });

  it("names a target that is itself a known phase", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const target of targets) {
        expect(PHASES, `${from} -> ${target}`).toContain(target);
      }
    }
  });
});

describe("the action-to-worker map", () => {
  it("covers every routable action exactly once", () => {
    expect(Object.keys(ACTION_WORKER).sort()).toEqual([...ROUTABLE_ACTIONS].sort());
  });

  it("assigns no worker to finalize, because finalize is deterministic", () => {
    expect(ACTION_WORKER.finalize).toBeNull();
  });

  it("keeps the code-writing and test-writing roles separate", () => {
    expect(ACTION_WORKER.implement).toBe("implementer");
    expect(ACTION_WORKER.author_tests).toBe("test_author");
    expect(ACTION_WORKER.implement).not.toBe(ACTION_WORKER.author_tests);
    // The verifier is nobody else's role either.
    expect(ACTION_WORKER.verify).toBe("verifier");
  });
});
