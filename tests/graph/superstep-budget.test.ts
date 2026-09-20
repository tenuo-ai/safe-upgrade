/**
 * The superstep budget, and what happens if a run ever reaches it.
 *
 * LangGraph stops at twenty-five nodes by default. This graph's own attempt caps allow more than
 * that, and the discrepancy was invisible because the test harness passed sixty while the runner
 * passed nothing: short runs finish in nine to eleven supersteps, so no test and no real run ever
 * reached either ceiling. These pin the budget to the caps it has to cover.
 */

import { describe, expect, it } from "vitest";
import { GraphRecursionError } from "@langchain/langgraph";

import { createGraphHarness } from "../support/graph-harness.ts";

import { superstepBudget } from "../../packages/graph/src/build-graph.ts";
import { ROUTABLE_ACTIONS } from "../../packages/graph/src/transitions.ts";

/** What LangGraph uses when the caller passes nothing. */
const LANGGRAPH_DEFAULT = 25;

describe("the superstep budget", () => {
  it("covers every action being attempted up to the cap", () => {
    const attempts = 3;
    // Each routed action costs two nodes: the route that chose it and the worker that ran it.
    const worstCase = 2 * ROUTABLE_ACTIONS.length * attempts;

    expect(superstepBudget(attempts)).toBeGreaterThanOrEqual(worstCase);
  });

  it("exceeds the default, which is the reason it has to be set", () => {
    // If this ever stops being true the explicit limit is redundant, and the comment explaining
    // why it exists should go with it.
    expect(superstepBudget(3)).toBeGreaterThan(LANGGRAPH_DEFAULT);
  });

  it("grows with the attempt cap, so raising retries does not silently cap the run", () => {
    expect(superstepBudget(6)).toBeGreaterThan(superstepBudget(3));
  });

  it("leaves room for the phases that run before any routing", () => {
    // inspect, baseline_verify, research, and the finalize every run ends at.
    expect(superstepBudget(1) - 2 * ROUTABLE_ACTIONS.length).toBe(4);
  });
});

describe("reaching the ceiling", () => {
  it("leaves the work readable instead of losing it", async () => {
    const harness = createGraphHarness();
    try {
      // Deliberately below what any run needs, to stand in for a routing defect that the attempt
      // caps failed to stop.
      await expect(harness.run({}, 3)).rejects.toThrow(GraphRecursionError);

      // The property the runner depends on: the checkpointer makes the last committed state
      // readable after the throw, so a run that dies this way can still be classified and can
      // still write its patch. Without it the worktree is released in a `finally` and the diff is
      // gone for good.
      const recovered = await harness.committedState();
      expect(recovered.request.packageName).toBe("left-pad");
      expect(recovered.phase).not.toBe("finalize");
    } finally {
      harness.cleanup();
    }
  });
});
