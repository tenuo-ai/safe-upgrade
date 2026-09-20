/**
 * The decision engine contract.
 *
 * Jev answers bounded semantic questions. It never produces code, commands,
 * paths, capabilities, or worker identities, and it cannot invent a graph node:
 * every question it is asked is a choice among candidates that trusted code
 * computed first.
 *
 * Keeping this contract free of any SDK import is deliberate. The real adapter
 * and the deterministic fake implement the same interface, so the router cannot
 * tell them apart and the graph tests do not need network access.
 */

import type { CheckPurpose, Phase, RoutableAction, WorkerId } from "@safe-upgrade/domain";

export interface RouteCandidate {
  readonly action: RoutableAction;
  readonly worker: WorkerId | null;
  /** Why this action is eligible right now. Shown to the engine as criteria. */
  readonly reason: string;
}

export interface UnresolvedFinding {
  readonly id: string;
  readonly summary: string;
  readonly affectedFileCount: number;
  readonly hasVerification: boolean;
}

/**
 * A compact, factual view of the run. Never the repository, never raw logs, and
 * never anything a release note wrote.
 */
export interface RouteInput {
  readonly currentPhase: Phase;
  readonly eligibleActions: readonly RouteCandidate[];
  readonly unresolvedFindings: readonly UnresolvedFinding[];
  readonly baselinePassed: boolean;
  readonly implementationChanged: boolean;
  readonly testsChanged: boolean;
  readonly ciSufficient: boolean;
  readonly lastVerification: "not_run" | "passed" | "failed";
  readonly attempts: Readonly<Partial<Record<WorkerId, number>>>;
}

export interface RouteChoice {
  readonly action: RoutableAction;
  /** Null when the engine does not report confidence. */
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
}

export interface TestCoverageInput {
  readonly finding: UnresolvedFinding;
  readonly requiredChange: string;
  /** Existing tests that reach the affected path, as file and title pairs. */
  readonly candidateTests: readonly { readonly file: string; readonly title: string }[];
  readonly baselinePassed: boolean;
}

export interface TestCoverageDecision {
  readonly sufficient: boolean;
  readonly confidence: number | null;
  readonly rationale: string;
}

export interface MigrationCompletenessInput {
  readonly findings: readonly UnresolvedFinding[];
  readonly changedFiles: readonly string[];
  readonly checksPassed: readonly CheckPurpose[];
}

export interface MigrationCompletenessDecision {
  readonly complete: boolean;
  readonly confidence: number | null;
  readonly unaddressedFindingIds: readonly string[];
}

export interface DecisionEngine {
  chooseNextAction(input: RouteInput): Promise<RouteChoice>;
  assessTestCoverage(input: TestCoverageInput): Promise<TestCoverageDecision>;
  assessMigrationCompleteness(input: MigrationCompletenessInput): Promise<MigrationCompletenessDecision>;
}
