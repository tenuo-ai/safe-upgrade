/**
 * The deterministic fallback.
 *
 * Used whenever the engine cannot be trusted to have answered: a malformed
 * response, a transport failure, a choice outside the candidate set, or a
 * confidence below the configured threshold. It is also what runs when only one
 * action is eligible, because asking a model to choose from a list of one is
 * pointless.
 *
 * The order is fixed by section 10.3 of the spec, and it is a priority list
 * rather than a state machine: the first eligible action wins.
 */

import type { RoutableAction } from "@safe-upgrade/domain";
import type { RouteInput } from "./contract.ts";

export interface FallbackResult {
  readonly action: RoutableAction;
  readonly reason: string;
}

/**
 * Preference order, most urgent first. Each entry is only used if the router
 * already found that action eligible.
 */
function preferenceOrder(input: RouteInput): readonly { action: RoutableAction; reason: string }[] {
  const preferences: { action: RoutableAction; reason: string }[] = [];

  if (input.lastVerification === "failed") {
    // Resolve the failure before doing anything else. Implementation first,
    // since a failing verification most often means the change is incomplete.
    preferences.push(
      { action: "implement", reason: "verification failed, so the implementation is revisited first" },
      { action: "author_tests", reason: "verification failed and the implementation is already current" },
    );
  }

  const unverified = input.unresolvedFindings.filter((finding) => !finding.hasVerification);
  if (unverified.length > 0) {
    preferences.push({
      action: "author_tests",
      reason: `${unverified.length} finding(s) have no verification path`,
    });
  }

  if (!input.dependencyMoved) {
    // Below covering a finding and above everything else.
    //
    // Above, because a workflow or a verification that describes a change nobody has made yet
    // is describing nothing. Below, because the implementer migrates source in the same visit
    // that it moves the dependency, and doing that before the tests are converted leaves the
    // repository half in one module system and fails a verification that was always going to
    // fail. Putting the move first outright cost three implementer visits and a failed round.
    preferences.push({
      action: "implement",
      reason: "the dependency is not yet at the target version",
    });
  }

  if (input.unresolvedFindings.length > 0) {
    preferences.push({
      action: "implement",
      reason: `${input.unresolvedFindings.length} finding(s) are unresolved`,
    });
  }

  if (!input.ciSufficient) {
    preferences.push({ action: "configure_ci", reason: "CI does not cover the verified command set" });
  }

  preferences.push(
    { action: "assess_verification", reason: "verification coverage has not been assessed" },
    { action: "verify", reason: "changes are ready for independent verification" },
    { action: "publish_draft", reason: "verification passed and publishing is approved" },
    { action: "finalize", reason: "no further action is eligible" },
  );

  return preferences;
}

/** Pick the highest-priority eligible action. Always returns something. */
export function deterministicFallback(input: RouteInput, cause: string): FallbackResult {
  const eligible = new Set(input.eligibleActions.map((candidate) => candidate.action));
  for (const preference of preferenceOrder(input)) {
    if (eligible.has(preference.action)) {
      return { action: preference.action, reason: `${cause}: ${preference.reason}` };
    }
  }
  // `finalize` is eligible whenever a blocking condition is recorded, and the
  // router adds it when nothing else remains, so this is a safety net only.
  return { action: "finalize", reason: `${cause}: no eligible action remained` };
}
