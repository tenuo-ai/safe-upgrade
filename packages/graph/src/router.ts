/**
 * The router.
 *
 * Sequence, and the order is the whole point:
 *
 * 1. deterministic code computes the eligible actions;
 * 2. the engine chooses among them, and only among them;
 * 3. the response is validated against that same candidate list;
 * 4. low confidence, a malformed response, or a transport failure falls back to
 *    a deterministic choice;
 * 5. trusted code resolves the action to a worker.
 *
 * A retry is permitted exactly once, and only for a malformed or unavailable
 * response. A choice outside the candidate set is not retried: it is rejected and
 * the fallback runs, because an engine that answered a question we did not ask
 * does not get a second chance to answer the same one.
 */

import { DecisionEngineError } from "@safe-upgrade/domain";
import type { RouteDecision, WorkerId } from "@safe-upgrade/domain";
import type { AuditLog } from "@safe-upgrade/evidence";
import type { DecisionEngine, RouteInput } from "@safe-upgrade/jev";
import { deterministicFallback, validateRouteChoice } from "@safe-upgrade/jev";
import { ACTION_WORKER } from "./transitions.ts";
import { eligibleActions, type EligibilityConfig } from "./eligibility.ts";
import {
  baselinePassed,
  implementationChanged,
  testsChanged,
  unresolvedFindings,
  unverifiedFindings,
  type UpgradeState,
} from "./state.ts";

export interface RouterConfig extends EligibilityConfig {
  /** Below this, the engine's top choice is replaced by the fallback. */
  readonly confidenceThreshold: number;
}

export interface RouterOptions {
  readonly engine: DecisionEngine;
  readonly config: RouterConfig;
  readonly audit: AuditLog;
  readonly clock?: () => Date;
}

/** Build the compact state the engine sees. Never files, logs, or release text. */
export function buildRouteInput(state: UpgradeState, config: EligibilityConfig): RouteInput {
  const verified = new Set(state.verifiedFindingIds);
  return {
    currentPhase: state.phase,
    eligibleActions: eligibleActions(state, config),
    unresolvedFindings: unresolvedFindings(state).map((finding) => ({
      id: finding.id,
      summary: finding.releaseClaim.slice(0, 280),
      affectedFileCount: finding.affectedFiles.length,
      hasVerification: verified.has(finding.id),
    })),
    baselinePassed: baselinePassed(state),
    implementationChanged: implementationChanged(state),
    testsChanged: testsChanged(state),
    ciSufficient: state.ciAssessment?.sufficient ?? false,
    lastVerification: state.lastVerification,
    attempts: state.workerAttempts,
  };
}

export interface Route {
  readonly decision: RouteDecision;
  readonly worker: WorkerId | null;
}

export async function decideRoute(state: UpgradeState, options: RouterOptions): Promise<Route> {
  const { engine, config, audit } = options;
  const now = options.clock ?? (() => new Date());
  const input = buildRouteInput(state, config);
  const candidates = input.eligibleActions.map((candidate) => candidate.action);

  const finish = (
    action: (typeof candidates)[number],
    source: "jev" | "fallback",
    confidence: number | null,
    probabilities: Readonly<Record<string, number>> | null,
    fallbackReason: string | null,
  ): Route => {
    // The worker is resolved here, from a constant, after the action is known.
    const worker = ACTION_WORKER[action];
    const decision: RouteDecision = {
      step: state.step,
      from: state.phase,
      candidates,
      selected: action,
      worker,
      source,
      confidence,
      probabilities,
      fallbackReason,
      decidedAt: now().toISOString(),
    };
    audit.record({
      phase: "route",
      type: "route_decision",
      payload: {
        step: decision.step,
        candidates,
        selected: action,
        worker,
        source,
        confidence,
        probabilities,
        fallbackReason,
        eligibilityReasons: Object.fromEntries(
          input.eligibleActions.map((candidate) => [candidate.action, candidate.reason]),
        ),
      },
    });
    return { decision, worker };
  };

  // Asking a model to choose from a list of one adds latency and a failure mode
  // without adding a decision.
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only === undefined) {
      throw new DecisionEngineError("the router produced an empty candidate list");
    }
    return finish(only, "fallback", null, null, "only one eligible action");
  }

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await engine.chooseNextAction(input);
      const choice = validateRouteChoice(response, candidates);
      if (choice.confidence !== null && choice.confidence < config.confidenceThreshold) {
        const fallback = deterministicFallback(
          input,
          `confidence ${choice.confidence.toFixed(2)} is below the ${config.confidenceThreshold} threshold`,
        );
        return finish(fallback.action, "fallback", choice.confidence, choice.probabilities, fallback.reason);
      }
      return finish(choice.action, "jev", choice.confidence, choice.probabilities, null);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof DecisionEngineError && !lastError.includes("not among the offered");
      if (!retryable || attempt === 1) {
        break;
      }
    }
  }

  const fallback = deterministicFallback(input, `decision engine rejected: ${lastError}`);
  return finish(fallback.action, "fallback", null, null, fallback.reason);
}
