export type {
  DecisionEngine,
  MigrationCompletenessDecision,
  MigrationCompletenessInput,
  RouteCandidate,
  RouteChoice,
  RouteInput,
  TestCoverageDecision,
  TestCoverageInput,
  UnresolvedFinding,
} from "./contract.ts";

export { validateCoverageDecision, validateRouteChoice } from "./validate.ts";

export type { FallbackResult } from "./fallback.ts";
export { deterministicFallback } from "./fallback.ts";

export type { FakeDecisionEngineOptions, ScriptedResponse } from "./fake.ts";
export { FakeDecisionEngine } from "./fake.ts";
