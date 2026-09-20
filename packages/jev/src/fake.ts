/**
 * Deterministic decision engine for tests and offline runs.
 *
 * Default behavior mirrors the fallback priority order, so a graph test produces
 * the same route every time. The failure modes are first-class rather than
 * simulated with mocks, because the router's handling of a bad response is
 * exactly the behavior worth testing.
 */

import { DecisionEngineError } from "@safe-upgrade/domain";
import type { RoutableAction } from "@safe-upgrade/domain";
import type {
  DecisionEngine,
  MigrationCompletenessDecision,
  MigrationCompletenessInput,
  ProseBreakDecision,
  ProseBreakInput,
  RouteChoice,
  RouteInput,
  TestCoverageDecision,
  TestCoverageInput,
} from "./contract.ts";
import { deterministicFallback } from "./fallback.ts";

export type ScriptedResponse =
  | { readonly kind: "choose"; readonly action: RoutableAction; readonly confidence?: number }
  /** An action that was never offered. The router must reject it. */
  | { readonly kind: "invalid"; readonly action: string }
  /** A response that does not match the schema at all. */
  | { readonly kind: "malformed" }
  /** A transport-level failure, which the router may retry once. */
  | { readonly kind: "unavailable" };

export interface FakeDecisionEngineOptions {
  /** Consumed in order. Once empty, the engine falls back to deterministic choice. */
  readonly script?: readonly ScriptedResponse[];
  /** Confidence reported for unscripted choices. */
  readonly defaultConfidence?: number;
  readonly coverage?: (input: TestCoverageInput) => TestCoverageDecision;
  readonly completeness?: (input: MigrationCompletenessInput) => MigrationCompletenessDecision;
  readonly prose?: (input: ProseBreakInput) => ProseBreakDecision;
}

export class FakeDecisionEngine implements DecisionEngine {
  private readonly script: ScriptedResponse[];
  private readonly defaultConfidence: number;
  private readonly options: FakeDecisionEngineOptions;
  /** Every route question the engine was asked, for assertions. */
  readonly routeCalls: RouteInput[] = [];
  readonly coverageCalls: TestCoverageInput[] = [];

  constructor(options: FakeDecisionEngineOptions = {}) {
    this.script = [...(options.script ?? [])];
    this.defaultConfidence = options.defaultConfidence ?? 0.9;
    this.options = options;
  }

  async chooseNextAction(input: RouteInput): Promise<RouteChoice> {
    this.routeCalls.push(input);
    const scripted = this.script.shift();

    if (scripted === undefined) {
      const fallback = deterministicFallback(input, "fake engine");
      return { action: fallback.action, confidence: this.defaultConfidence, probabilities: null };
    }

    switch (scripted.kind) {
      case "choose":
        return {
          action: scripted.action,
          confidence: scripted.confidence ?? this.defaultConfidence,
          probabilities: { [scripted.action]: scripted.confidence ?? this.defaultConfidence },
        };
      case "invalid":
        // Deliberately outside the candidate set. Returned through the same
        // channel a real SDK would use, so the router's validation is exercised.
        return { action: scripted.action as RoutableAction, confidence: 0.99, probabilities: null };
      case "malformed":
        return { action: "", confidence: 5, probabilities: null } as unknown as RouteChoice;
      case "unavailable":
        throw new DecisionEngineError("fake engine is unavailable");
    }
  }

  async assessTestCoverage(input: TestCoverageInput): Promise<TestCoverageDecision> {
    this.coverageCalls.push(input);
    if (this.options.coverage !== undefined) {
      return this.options.coverage(input);
    }
    return {
      sufficient: input.candidateTests.length > 0,
      confidence: this.defaultConfidence,
      rationale:
        input.candidateTests.length > 0
          ? "an existing test reaches the affected path"
          : "no existing test reaches the affected path",
    };
  }

  async assessMigrationCompleteness(
    input: MigrationCompletenessInput,
  ): Promise<MigrationCompletenessDecision> {
    if (this.options.completeness !== undefined) {
      return this.options.completeness(input);
    }
    return {
      complete: input.findings.length === 0,
      confidence: this.defaultConfidence,
      unaddressedFindingIds: input.findings.map((finding) => finding.id),
    };
  }

  /**
   * Answers `false` by default, so a test that does not care about release prose gets the
   * behaviour of a run where the note named nothing rather than one where a break was invented.
   */
  async assessProseBreak(input: ProseBreakInput): Promise<ProseBreakDecision> {
    if (this.options.prose !== undefined) {
      return this.options.prose(input);
    }
    return { affects: false, confidence: this.defaultConfidence, evidenceId: input.evidenceId };
  }
}
