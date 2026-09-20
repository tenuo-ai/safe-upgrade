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
  /**
   * Whether the dependency is already at the target version.
   *
   * Not in the spec's field list, and added because without it neither the engine nor the
   * fallback can tell "the change has not been made yet" from "the change is done and
   * something else is next". Every other field describes work *around* the upgrade.
   */
  readonly dependencyMoved: boolean;
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

/**
 * How this repository uses a package, in terms that are not its source.
 *
 * The load style and the member names are the two things a release note could speak to, and
 * neither is private: the members are the package's own published API, and the style is which of
 * three ways the language offers was used. The matched source line is deliberately not here.
 */
export interface ProseUsage {
  readonly style: "require" | "import" | "dynamic_import";
  /** Members of the package's published API this repository names. */
  readonly members: readonly string[];
  readonly callSiteCount: number;
}

/**
 * The one question in this contract whose input is prose.
 *
 * Every other question is asked over facts trusted code computed, and this one has to be
 * different, because the thing it asks about is a sentence someone wrote. It exists for the case
 * every real run ended in: a major version bump that no structural rule explains, with a release
 * note sitting in the evidence record that nothing read.
 *
 * What crosses the wire is public. The excerpt is quoted from a published changelog or release,
 * the member names are the package's own API, and the repository's source does not appear. What
 * comes back is a boolean and a number — no prose, so nothing generated is repeated anywhere.
 */
export interface ProseBreakInput {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  /** Quoted from a retrieved public document, bounded by the caller. */
  readonly excerpt: string;
  /** Evidence id of that document, echoed back so an answer can be cited to it. */
  readonly evidenceId: string;
  readonly usage: ProseUsage;
}

export interface ProseBreakDecision {
  readonly affects: boolean;
  readonly confidence: number | null;
  /** The document the answer is about, so a finding can cite it. */
  readonly evidenceId: string;
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
  /**
   * Whether a release note describes a break that reaches how this repository uses the package.
   *
   * May raise a concern and may not settle one. A `false` here does not discharge the caution
   * that prompted the question: a model reading a changelog and not finding your call site is a
   * reading, not a proof, and treating it as one would let a confident misreading turn a real
   * break into a verified run. The asymmetry is the point.
   */
  assessProseBreak(input: ProseBreakInput): Promise<ProseBreakDecision>;
}
