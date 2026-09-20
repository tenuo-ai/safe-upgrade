/**
 * Graph assembly.
 *
 * Every edge in the compiled graph is also present in `TRANSITIONS`, and the
 * edge functions assert that at run time. The allowlist is therefore not
 * documentation that can drift from the wiring; a divergence throws.
 */

import { END, START, StateGraph } from "@langchain/langgraph";
import { RepositoryError, type Phase, type WorkerId } from "@safe-upgrade/domain";
import { UpgradeStateAnnotation, type UpgradeState } from "./state.ts";
import { createNodes, type NodeDependencies, type WorkerRegistry } from "./nodes.ts";
import { isLegalTransition, ROUTABLE_ACTIONS, TRANSITIONS } from "./transitions.ts";

const WORKER_IDS: readonly WorkerId[] = [
  "inspector",
  "researcher",
  "test_author",
  "implementer",
  "ci_author",
  "verifier",
  "publisher",
];

/** `inspect`, `baseline_verify`, `research`, and the `finalize` every run ends at. */
const PROLOGUE = 4;

/**
 * The superstep budget a run needs, given what its attempt caps permit.
 *
 * LangGraph counts one superstep per node and stops at twenty-five by default, which is a
 * number chosen for chat agents and is below what this graph's own limits allow: every routed
 * action costs two nodes, the route that chose it and the worker that ran it, and the attempt cap
 * applies per worker rather than to the run.
 *
 * It was the default until measured, because the test harness passed sixty and production passed
 * nothing. Short runs finish in nine to eleven supersteps, so nothing failed; a run that used its
 * retries would have hit the ceiling in production with no test able to see it. Stated here so
 * both callers spend the same budget, and so raising `maxWorkerAttempts` raises this with it.
 *
 * Exceeding it is a bug in the eligibility rules, not a condition to plan for: the caps are what
 * stop a run, and this is the ceiling above them.
 */
export function superstepBudget(maxWorkerAttempts: number): number {
  return PROLOGUE + 2 * ROUTABLE_ACTIONS.length * maxWorkerAttempts;
}

/** Reject an incomplete registry at build time rather than mid-run. */
function assertRegistryComplete(workers: WorkerRegistry): void {
  const missing = WORKER_IDS.filter((worker) => typeof workers[worker] !== "function");
  if (missing.length > 0) {
    throw new RepositoryError(`the worker registry is missing: ${missing.join(", ")}`);
  }
}

/**
 * Follow the phase the node just set, after confirming the move is allowed.
 *
 * A node sets `phase` to where it intends to go; this converts that intent into
 * an edge. An illegal target is a programming error in trusted code, so it throws
 * rather than being silently corrected.
 */
function transitionTo(from: Phase, fallback: Phase) {
  return (state: UpgradeState): Phase => {
    // A recorded blocking condition always wins: there is no point routing on.
    if (state.blockingConditions.length > 0 || state.prohibitedActions.length > 0) {
      if (!isLegalTransition(from, "finalize")) {
        throw new RepositoryError(`${from} cannot reach finalize, but a blocking condition was recorded`);
      }
      return "finalize";
    }
    const target = state.phase === from ? fallback : state.phase;
    if (!isLegalTransition(from, target)) {
      throw new RepositoryError(`illegal transition ${from} -> ${target}`);
    }
    return target;
  };
}

/**
 * Build the state machine. The caller compiles it, which is where a checkpointer
 * is supplied, so persistence is a deployment decision rather than a graph one.
 */
export function buildGraph(dependencies: NodeDependencies) {
  assertRegistryComplete(dependencies.workers);
  const nodes = createNodes(dependencies);

  const graph = new StateGraph(UpgradeStateAnnotation)
    .addNode("inspect", nodes.inspect)
    .addNode("baseline_verify", nodes.baseline_verify)
    .addNode("research", nodes.research)
    .addNode("route", nodes.route)
    .addNode("assess_verification", nodes.assess_verification)
    .addNode("author_tests", nodes.author_tests)
    .addNode("implement", nodes.implement)
    .addNode("configure_ci", nodes.configure_ci)
    .addNode("verify", nodes.verify)
    .addNode("publish_draft", nodes.publish_draft)
    .addNode("finalize", nodes.finalize)

    .addEdge(START, "inspect")

    .addConditionalEdges("inspect", transitionTo("inspect", "baseline_verify"), [...TRANSITIONS.inspect])
    .addConditionalEdges("baseline_verify", transitionTo("baseline_verify", "research"), [
      ...TRANSITIONS.baseline_verify,
    ])
    .addConditionalEdges("research", transitionTo("research", "route"), [...TRANSITIONS.research])

    // The route node has already chosen; this edge only carries out the choice.
    .addConditionalEdges("route", transitionTo("route", "finalize"), [...TRANSITIONS.route])

    .addConditionalEdges("assess_verification", transitionTo("assess_verification", "route"), [
      ...TRANSITIONS.assess_verification,
    ])
    .addConditionalEdges("author_tests", transitionTo("author_tests", "route"), [...TRANSITIONS.author_tests])
    .addConditionalEdges("implement", transitionTo("implement", "route"), [...TRANSITIONS.implement])
    .addConditionalEdges("configure_ci", transitionTo("configure_ci", "route"), [...TRANSITIONS.configure_ci])
    .addConditionalEdges("verify", transitionTo("verify", "route"), [...TRANSITIONS.verify])
    .addEdge("publish_draft", "finalize")
    .addEdge("finalize", END);

  return graph;
}
