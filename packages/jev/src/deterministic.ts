/**
 * The engine used when there is no decision engine.
 *
 * It answers nothing. Every method reports unavailability, which sends the router
 * to the deterministic priority order in `fallback.ts` — the same path taken when
 * a real engine is down or returns something invalid.
 *
 * This is not a stub standing in for a missing feature. A run with no model
 * attached is a supported configuration, and it is the configuration in which the
 * safety properties are easiest to state: the route is then a pure function of
 * graph state, and the audit trail records `fallback` as the source of every
 * decision. `FakeDecisionEngine` is the one for tests that need to script
 * specific answers.
 */

import { DecisionEngineError } from "@safe-upgrade/domain";
import type {
  DecisionEngine,
  MigrationCompletenessDecision,
  MigrationCompletenessInput,
  RouteChoice,
  RouteInput,
  TestCoverageDecision,
  TestCoverageInput,
} from "./contract.ts";

const REASON = "no decision engine is configured, so the deterministic order decides";

export class DeterministicEngine implements DecisionEngine {
  async chooseNextAction(_input: RouteInput): Promise<RouteChoice> {
    throw new DecisionEngineError(REASON);
  }

  async assessTestCoverage(_input: TestCoverageInput): Promise<TestCoverageDecision> {
    throw new DecisionEngineError(REASON);
  }

  async assessMigrationCompleteness(
    _input: MigrationCompletenessInput,
  ): Promise<MigrationCompletenessDecision> {
    throw new DecisionEngineError(REASON);
  }
}
