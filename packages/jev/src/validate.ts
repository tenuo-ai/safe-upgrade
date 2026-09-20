/**
 * Validation of decision-engine responses.
 *
 * The engine's output is untrusted, and static types from an SDK are not a
 * runtime guarantee. Every response is checked against the exact candidate list
 * the router computed, so a choice the router never offered is rejected rather
 * than followed.
 */

import { z } from "zod";
import { DecisionEngineError } from "@safe-upgrade/domain";
import type { RoutableAction } from "@safe-upgrade/domain";
import type { RouteChoice, TestCoverageDecision } from "./contract.ts";

const routeChoiceSchema = z.object({
  action: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  probabilities: z.record(z.string(), z.number()).nullable(),
});

const coverageSchema = z.object({
  sufficient: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  rationale: z.string().max(4000),
});

/**
 * Accept a route choice only if it is one of the candidates. The candidate list
 * is the authority here, not the response.
 */
export function validateRouteChoice(
  response: unknown,
  candidates: readonly RoutableAction[],
): RouteChoice {
  const parsed = routeChoiceSchema.safeParse(response);
  if (!parsed.success) {
    throw new DecisionEngineError(
      `route response does not match the expected shape: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const action = parsed.data.action as RoutableAction;
  if (!candidates.includes(action)) {
    throw new DecisionEngineError(
      `route response selected '${parsed.data.action}', which was not among the offered candidates (${candidates.join(", ")})`,
    );
  }
  return {
    action,
    confidence: parsed.data.confidence,
    probabilities: parsed.data.probabilities,
  };
}

export function validateCoverageDecision(response: unknown): TestCoverageDecision {
  const parsed = coverageSchema.safeParse(response);
  if (!parsed.success) {
    throw new DecisionEngineError(
      `coverage response does not match the expected shape: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}
