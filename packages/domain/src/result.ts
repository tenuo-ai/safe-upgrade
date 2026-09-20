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
  /**
   * Required checks that were already failing before anything was touched.
   *
   * Named rather than counted, because "a required baseline check failed" sends a reader to
   * hunt through artifacts for which one, and the answer is usually that the repository does
   * not build in this environment at all.
   */
  readonly failedBaselinePurposes: readonly CheckPurpose[];
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

interface Derived {
  readonly unaddressed: readonly string[];
  readonly unverifiedFindings: readonly string[];
  readonly failed: readonly CheckResult[];
  readonly capAtPartial: boolean;
}

/**
 * Every condition `verified` requires and this run does not meet, in words.
 *
 * One function rather than a boolean predicate beside a list of reasons. Those were two
 * spellings of the same rule, and a condition added to one but not the other gives a
 * run that either claims `verified` without saying why or withholds it without saying
 * why. An empty result here is what `verified` means.
 */
function shortfalls(input: ClassificationInput, derived: Derived): string[] {
  const out: string[] = [];
  if (derived.capAtPartial) {
    out.push("the baseline was not clean, so post-change results cannot be compared against it");
  }
  if (!input.targetVersionResolved) {
    out.push("installed version does not resolve exactly to the requested target");
  }
  for (const id of derived.unaddressed) {
    out.push(`finding ${id} is not addressed`);
  }
  for (const id of derived.unverifiedFindings) {
    out.push(`finding ${id} has no meaningful verification path`);
  }
  for (const check of derived.failed) {
    out.push(`required ${check.command.purpose} check ${check.outcome}`);
  }
  if (!input.diffPolicyPassed) {
    out.push("diff policy failed");
  }
  if (!input.ciSufficient) {
    out.push("CI does not cover the verified command set");
  }
  return out;
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
  if (input.failedBaselinePurposes.length > 0) {
    reasons.push(
      `the repository's own ${joinNames(input.failedBaselinePurposes)} ${
        input.failedBaselinePurposes.length === 1 ? "check was" : "checks were"
      } already failing before anything was changed, so no later result can be attributed to this upgrade`,
    );
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
    // Whether the wait is the only thing left is the first thing the person deciding
    // needs to know, and it is not implied by anything above. Without this, a run that
    // established everything and needs a yes reads exactly like one that is stuck on a
    // failing check and happens to also need a yes.
    const outstanding = shortfalls(input, { unaddressed, unverifiedFindings, failed, capAtPartial });
    reasons.push(
      outstanding.length === 0
        ? "nothing else is outstanding: every other condition this run checks is met"
        : `also outstanding, independently of the approval: ${outstanding.join("; ")}`,
    );
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

  const outstanding = shortfalls(input, { unaddressed, unverifiedFindings, failed, capAtPartial });

  if (outstanding.length === 0) {
    reasons.push(
      "target version resolved exactly",
      "every finding addressed and covered by a verification path",
      "all required clean checks passed",
      "diff policy passed",
      "CI covers the verified command set",
    );
    return decide("verified");
  }

  reasons.push(...outstanding);

  if (!input.targetVersionResolved) {
    unverifiedClaims.push("the dependency upgrade itself is unconfirmed");
  }
  for (const id of unaddressed) {
    unverifiedClaims.push(`finding ${id} has no corresponding change`);
  }
  for (const id of unverifiedFindings) {
    unverifiedClaims.push(`finding ${id} is unverified`);
  }
  for (const check of failed) {
    unverifiedClaims.push(`${check.command.purpose} is unverified`);
  }
  for (const check of notRun) {
    unverifiedClaims.push(`${check.command.purpose} never ran`);
  }
  if (!input.diffPolicyPassed) {
    unverifiedClaims.push("the change set contains edits the policy forbids");
  }
  if (!input.ciSufficient) {
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

/** "test", "test and lint", "test, lint, and build". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
