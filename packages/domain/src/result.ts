/**
 * Deterministic final classification.
 *
 * No model, and no worker, decides the outcome of a run. This function does,
 * from recorded facts alone. `verified` requires every condition in section 15
 * of the spec to hold; anything short of that degrades to a weaker status that
 * names what could not be established.
 */

import type { CheckPurpose, CheckResult, EvidenceLink, FinalResult, RunStatus } from "./types.ts";

export interface ClassificationInput {
  /** Baseline ran to completion, so we know the repository's starting state. */
  readonly baselineKnown: boolean;
  /** A required baseline check failed before we touched anything. */
  readonly baselineRequiredFailure: boolean;
  /** Installed version matches the exact requested target. */
  readonly targetVersionResolved: boolean;
  readonly findingIds: readonly string[];
  readonly addressedFindingIds: readonly string[];
  readonly verifiedFindingIds: readonly string[];
  readonly requiredChecks: readonly CheckResult[];
  readonly optionalCheckPurposes: readonly CheckPurpose[];
  readonly diffPolicyPassed: boolean;
  readonly ciSufficient: boolean;
  /** Evidence gaps severe enough that correctness cannot be established. */
  readonly highSeverityUncertainty: readonly string[];
  /** Concrete conditions that stop progress, such as an unsupported manager. */
  readonly blockingConditions: readonly string[];
  /** A prohibited action was attempted or performed. Always fatal. */
  readonly prohibitedActions: readonly string[];
  /** A valid next operation is waiting on a human. */
  readonly pendingApprovals: readonly string[];
  /** Configuration permits reporting a partial result instead of blocking. */
  readonly partialAllowed: boolean;
  readonly evidenceLinks: readonly EvidenceLink[];
  readonly draftPullRequestUrl: string | null;
  readonly now: string;
}

function missing(all: readonly string[], present: readonly string[]): string[] {
  const seen = new Set(present);
  return all.filter((id) => !seen.has(id));
}

function failedChecks(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.outcome !== "passed");
}

/**
 * Precedence is fixed: prohibited actions and blocking conditions outrank
 * everything, then pending approvals, then the positive `verified` predicate,
 * then uncertainty, and `partial` is the residual.
 */
export function classifyRun(input: ClassificationInput): FinalResult {
  const reasons: string[] = [];
  const unverifiedClaims: string[] = [];

  const unaddressed = missing(input.findingIds, input.addressedFindingIds);
  const unverifiedFindings = missing(input.findingIds, input.verifiedFindingIds);
  const failed = failedChecks(input.requiredChecks);
  const notRun = input.requiredChecks.filter((check) => check.outcome === "not_run");

  const decide = (status: RunStatus): FinalResult => ({
    status,
    reasons,
    unverifiedClaims,
    evidenceLinks: input.evidenceLinks,
    draftPullRequestUrl: input.draftPullRequestUrl,
    classifiedAt: input.now,
  });

  if (input.prohibitedActions.length > 0) {
    reasons.push(...input.prohibitedActions.map((action) => `prohibited action: ${action}`));
    return decide("blocked");
  }

  if (input.blockingConditions.length > 0) {
    reasons.push(...input.blockingConditions);
    return decide("blocked");
  }

  // A run that started from a failing baseline can still produce useful work,
  // but it can never reach `verified`: there is no way to tell our change's
  // effect apart from a failure that was already there.
  let capAtPartial = false;
  if (input.baselineRequiredFailure) {
    reasons.push("a required baseline check failed before any change was made");
    if (!input.partialAllowed) {
      return decide("blocked");
    }
    unverifiedClaims.push("post-change checks cannot be compared against a passing baseline");
    capAtPartial = true;
  }

  if (!input.baselineKnown) {
    reasons.push("baseline state is unknown");
    unverifiedClaims.push("no claim about behavior change can be supported without a baseline");
    return decide(input.partialAllowed ? "partial" : "blocked");
  }

  if (input.pendingApprovals.length > 0) {
    reasons.push(...input.pendingApprovals.map((item) => `awaiting approval: ${item}`));
    return decide("human_required");
  }

  // Unresolvable uncertainty outranks a clean check run: passing tests do not
  // establish that we understood the release correctly.
  if (input.highSeverityUncertainty.length > 0) {
    reasons.push(...input.highSeverityUncertainty);
    unverifiedClaims.push("the migration cannot be shown to be correct from available evidence");
    return decide("indeterminate");
  }

  if (input.findingIds.length === 0) {
    reasons.push("research produced no findings, so there is nothing to establish");
    unverifiedClaims.push("no migration finding was recorded, not even 'no source change required'");
    return decide("indeterminate");
  }

  const verifiedConditions =
    !capAtPartial &&
    input.targetVersionResolved &&
    unaddressed.length === 0 &&
    unverifiedFindings.length === 0 &&
    failed.length === 0 &&
    input.diffPolicyPassed &&
    input.ciSufficient;

  if (verifiedConditions) {
    reasons.push(
      "target version resolved exactly",
      "every finding addressed and covered by a verification path",
      "all required clean checks passed",
      "diff policy passed",
      "CI covers the verified command set",
    );
    return decide("verified");
  }

  if (!input.targetVersionResolved) {
    reasons.push("installed version does not resolve exactly to the requested target");
    unverifiedClaims.push("the dependency upgrade itself is unconfirmed");
  }
  for (const id of unaddressed) {
    reasons.push(`finding ${id} is not addressed`);
    unverifiedClaims.push(`finding ${id} has no corresponding change`);
  }
  for (const id of unverifiedFindings) {
    reasons.push(`finding ${id} has no meaningful verification path`);
    unverifiedClaims.push(`finding ${id} is unverified`);
  }
  for (const check of failed) {
    reasons.push(`required ${check.command.purpose} check ${check.outcome}`);
    unverifiedClaims.push(`${check.command.purpose} is unverified`);
  }
  for (const check of notRun) {
    unverifiedClaims.push(`${check.command.purpose} never ran`);
  }
  if (!input.diffPolicyPassed) {
    reasons.push("diff policy failed");
    unverifiedClaims.push("the change set contains edits the policy forbids");
  }
  if (!input.ciSufficient) {
    reasons.push("CI does not cover the verified command set");
    unverifiedClaims.push("CI will not re-run the checks proven locally");
  }
  for (const purpose of input.optionalCheckPurposes) {
    unverifiedClaims.push(`${purpose} was not part of the required set`);
  }

  return decide("partial");
}

/** `partial` results must never be presented as safe. */
export function isSafeToPresentAsVerified(status: RunStatus): boolean {
  return status === "verified";
}
